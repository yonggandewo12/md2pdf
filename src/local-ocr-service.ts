/**
 * 本地 OCR 服务：recognize_text 工具的实现后端。
 *
 * 完全离线——图片经 pdf-lib 包装为单页 PDF 后与 PDF 输入一样走
 * @firecrawl/pdf-inspector 的 PP-OCRv6 Small 选择性 OCR（OCR 运行时与模型
 * 由 pdf-inspector-service 按需加载/下载；纯文本 PDF 的 Auto 路由零开销）。
 * 不依赖任何云服务与 API key。
 *
 * 图片格式仅支持 PNG/JPEG（pdf-lib 原生嵌入能力）；其他格式显式报错，
 * 提示调用方先转换为 PNG/JPEG。
 */
import { promises as fs } from 'fs';
import { PDFDocument } from 'pdf-lib';
import { OcrOptions, OcrResult, OcrPageResult } from './types.js';
import { processPdfWithOcrBuffer } from './pdf-inspector-service.js';
import { parsePages } from './pdf-extract-adapter.js';

function isPng(buf: Buffer): boolean {
  return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

function isJpeg(buf: Buffer): boolean {
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

function stripDataUriPrefix(base64: string): string {
  const match = base64.match(/^data:image\/[^;]+;base64,(.+)$/s);
  return match ? match[1] : base64;
}

/** PNG/JPEG bytes → single-page image PDF; other formats throw with guidance. */
async function imageBytesToPdf(buf: Buffer): Promise<Buffer> {
  const doc = await PDFDocument.create();
  let image;
  if (isPng(buf)) {
    image = await doc.embedPng(buf);
  } else if (isJpeg(buf)) {
    image = await doc.embedJpg(buf);
  } else {
    throw new Error(
      'Unsupported image format: local OCR accepts PNG and JPEG only. ' +
        'Convert the image (e.g. to PNG) and retry.',
    );
  }
  const page = doc.addPage([image.width, image.height]);
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  return Buffer.from(await doc.save());
}

export class LocalOcrService {
  /** Resolve the configured input to PDF bytes. Priority: image > pdf. */
  private async resolveInputToPdf(options: OcrOptions): Promise<Buffer> {
    if (options.imagePath) {
      return imageBytesToPdf(await this.readFileOrThrow(options.imagePath, '图片'));
    }
    if (options.imageUrl) {
      const res = await fetch(options.imageUrl, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`下载图片失败: HTTP ${res.status}`);
      return imageBytesToPdf(Buffer.from(await res.arrayBuffer()));
    }
    if (options.imageBase64) {
      return imageBytesToPdf(Buffer.from(stripDataUriPrefix(options.imageBase64), 'base64'));
    }
    if (options.pdfPath) {
      return this.readFileOrThrow(options.pdfPath, 'PDF');
    }
    throw new Error('必须提供 imagePath、imageUrl、imageBase64 或 pdfPath 其中之一');
  }

  /** 读取本地文件：ENOENT 报"不存在"，其余错误保留原始错误码避免误诊。 */
  private async readFileOrThrow(filePath: string, label: string): Promise<Buffer> {
    try {
      return await fs.readFile(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new Error(`${label}文件不存在: ${filePath}`);
      }
      throw new Error(`${label}文件读取失败 (${code ?? 'UNKNOWN'}): ${filePath}`);
    }
  }

  /**
   * Recognize text from an image or PDF via local PP-OCRv6.
   * `Auto` mode: image-wrapped PDFs are always routed to OCR; text-based
   * PDFs return their native text with zero OCR overhead.
   */
  async recognize(options: OcrOptions): Promise<OcrResult> {
    const start = Date.now();
    try {
      const buffer = await this.resolveInputToPdf(options);
      const oneIndexed = parsePages(options.targetPages);
      const doc = await processPdfWithOcrBuffer(buffer, {
        mode: 'Auto',
        pages: oneIndexed,
        dpi: options.dpi,
      });

      const pages: OcrPageResult[] = doc.pages.map((p) => ({
        page: p.pageIndex + 1,
        text: p.markdown,
        source: p.ocrProvenance?.source ?? 'Native',
        ocrConfidence: p.ocrProvenance?.ocrConfidence,
        warnings: p.ocrProvenance?.warnings ?? [],
        hostedRecommended: p.ocrProvenance?.hostedRecommended ?? false,
      }));

      const single = pages.length === 1;
      const text = pages
        .map((p) => (single ? p.text : `[Page ${p.page}]\n${p.text}`.trim()))
        .join('\n\n--- Page Break ---\n\n');

      return {
        success: true,
        text,
        pages,
        pageCount: doc.pageCount,
        details: { processingTime: Date.now() - start },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        details: { processingTime: Date.now() - start },
      };
    }
  }
}
