/**
 * PDF 探测：读取本工具（Chromium print）生成的 PDF，回传页数、页面尺寸与
 * 完全空白页列表。供 convert_md_to_pdf 在转换后自检，调用方无需外部工具
 * （mdls 页数可能陈旧，PyMuPDF 在 Node 侧不可用）。
 *
 * 空白页启发式只针对 Chromium 输出：content stream 中无文本绘制（Tj/TJ）、
 * 无 XObject 引用（Do）、路径绘制指令 ≤2（整页白色背景 fill + 至多一条线，
 * 如被分页挤成孤行的 hr border）。不适用于任意第三方 PDF。
 */
import { promises as fs } from 'fs';
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFObject,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} from 'pdf-lib';

export interface PdfProbeResult {
  pageCount: number;
  /** 首页尺寸（pt，四舍五入） */
  pageSize?: { width: number; height: number };
  /** 完全空白页的 1-based 页码 */
  blankPages: number[];
}

interface ContentOpCounts {
  text: number;
  xobject: number;
  paint: number;
}

/** 统计 content stream 中的文本/XObject/路径绘制指令数量。 */
export function countContentOps(content: string): ContentOpCounts {
  return {
    // T/T 不在 hex 字母表内，hex 字符串不会误匹配
    text: (content.match(/T[jJ]/g) ?? []).length,
    xobject: (content.match(/\/[^\s/<>[\]()%]+\s+Do\b/g) ?? []).length,
    // 路径终点算子（fill/stroke 及其组合 + sh 着色，sh 须置于 s 之前）；
    // f/b/s 是 hex 字母，但 hex 字符串内前后紧邻 hex 字符不构成边界，误报可忽略
    paint: (content.match(/(?:^|[\s])(?:f\*|B\*|b\*|sh|f|S|s|B|b)(?=[\s]|$)/g) ?? []).length,
  };
}

/** 收集一页的 content stream 文本（多流按序拼接）；取不到/解码失败返回 null。 */
function pageContentText(doc: PDFDocument, pageIndex: number): string | null {
  const node = doc.getPage(pageIndex).node;
  const raw: PDFObject | undefined = node.get(PDFName.Contents);
  const resolve = (obj: PDFObject | undefined): PDFObject | undefined =>
    obj instanceof PDFRef ? node.context.lookup(obj) : obj;

  const streams: PDFRawStream[] = [];
  const collect = (obj: PDFObject | undefined): void => {
    const resolved = resolve(obj);
    if (resolved instanceof PDFArray) {
      for (let i = 0; i < resolved.size(); i++) collect(resolved.get(i));
    } else if (resolved instanceof PDFRawStream) {
      streams.push(resolved);
    }
  };
  collect(raw);

  if (streams.length === 0) return '';
  try {
    return streams
      .map((s) => Buffer.from(decodePDFRawStream(s).decode()).toString('latin1'))
      .join('\n');
  } catch {
    return null; // 解码失败 → 调用方按非空白处理
  }
}

/** 判定一页是否完全空白：无文本、无图像 XObject、路径绘制 ≤2。 */
function isBlankPage(ops: ContentOpCounts): boolean {
  return ops.text === 0 && ops.xobject === 0 && ops.paint <= 2;
}

/**
 * 探测 PDF：页数、首页尺寸、完全空白页列表。
 * 抛错由调用方决定是否降级（探测失败不得影响转换结果）。
 */
export async function probePdf(pdfPath: string): Promise<PdfProbeResult> {
  const bytes = await fs.readFile(pdfPath);
  const doc = await PDFDocument.load(bytes);

  const firstPage = doc.getPage(0);
  const size = firstPage.getSize();

  const blankPages: number[] = [];
  for (let i = 0; i < doc.getPageCount(); i++) {
    const content = pageContentText(doc, i);
    // content stream 缺失 = 真空白；解码失败（null）= 无法判定，按非空白
    if (content !== null && isBlankPage(countContentOps(content))) {
      blankPages.push(i + 1);
    }
  }

  return {
    pageCount: doc.getPageCount(),
    pageSize: {
      width: Math.round(size.width),
      height: Math.round(size.height),
    },
    blankPages,
  };
}
