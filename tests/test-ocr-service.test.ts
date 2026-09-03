/**
 * Unit tests for local-ocr-service (recognize_text 后端，本地 PP-OCRv6)。
 * Mocks @firecrawl/pdf-inspector-service：验证输入解析、图片→PDF 包装、
 * 页码透传与输出形状；OCR 引擎本身由 e2e 覆盖。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const mockProcessPdfWithOcrBuffer = vi.fn();

vi.mock('../src/pdf-inspector-service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/pdf-inspector-service.js')>(
    '../src/pdf-inspector-service.js',
  );
  return {
    ...actual,
    processPdfWithOcrBuffer: (...args: unknown[]) => mockProcessPdfWithOcrBuffer(...args),
  };
});

import { LocalOcrService } from '../src/local-ocr-service.js';
import { NormalizedPdfDocument } from '../src/pdf-inspector-types.js';

// 1x1 透明 PNG
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function docFrom(pages: Array<{ markdown: string; source?: string; ocrConfidence?: number }>): NormalizedPdfDocument {
  return {
    pageCount: pages.length,
    pdfType: 'Scanned',
    pages: pages.map((p, i) => ({
      pageIndex: i,
      markdown: p.markdown,
      needsOcr: (p.source ?? 'Ocr') !== 'Native',
      textItems: [],
      ocrProvenance: {
        source: (p.source ?? 'Ocr') as 'Native' | 'Ocr' | 'Fused',
        ocrConfidence: p.ocrConfidence,
        hostedRecommended: false,
        warnings: [],
      },
    })),
    pagesNeedingOcr: [],
    pagesWithTables: [],
    pagesWithColumns: [],
    processingTimeMs: 0,
    isComplexLayout: false,
    hasEncodingIssues: false,
    confidence: 0,
  };
}

describe('LocalOcrService', () => {
  let service: LocalOcrService;

  beforeEach(() => {
    service = new LocalOcrService();
    mockProcessPdfWithOcrBuffer.mockReset();
    mockProcessPdfWithOcrBuffer.mockResolvedValue(docFrom([{ markdown: 'hello', source: 'Ocr', ocrConfidence: 0.98 }]));
  });

  it('wraps a base64 PNG into a single-page PDF and OCRs it', async () => {
    const result = await service.recognize({ imageBase64: PNG_1X1_BASE64 });
    expect(result.success).toBe(true);
    expect(mockProcessPdfWithOcrBuffer).toHaveBeenCalledTimes(1);
    const [buffer, opts] = mockProcessPdfWithOcrBuffer.mock.calls[0];
    expect(Buffer.isBuffer(buffer)).toBe(true);
    // 包装产物必须是合法 PDF（%PDF- 魔数）
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(opts.mode).toBe('Auto');
    expect(opts.pages).toBeUndefined();
    expect(result.text).toBe('hello');
    expect(result.pages?.[0]).toMatchObject({ page: 1, source: 'Ocr', ocrConfidence: 0.98 });
  });

  it('strips data URI prefixes from base64 input', async () => {
    await service.recognize({ imageBase64: `data:image/png;base64,${PNG_1X1_BASE64}` });
    expect(mockProcessPdfWithOcrBuffer).toHaveBeenCalledTimes(1);
  });

  it('passes pdfPath bytes through without wrapping', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocr-'));
    const pdfPath = join(dir, 'doc.pdf');
    // 最小合法 PDF 结构即可（mock 不解析内容）
    writeFileSync(pdfPath, Buffer.from('%PDF-1.4\n%%EOF\n'));
    try {
      await service.recognize({ pdfPath });
      const [buffer] = mockProcessPdfWithOcrBuffer.mock.calls[0];
      expect(buffer.toString()).toContain('%PDF-1.4');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unsupported image formats with explicit guidance', async () => {
    const gif = Buffer.from('GIF89a', 'utf8');
    const result = await service.recognize({ imageBase64: gif.toString('base64') });
    expect(result.success).toBe(false);
    expect(result.error).toContain('PNG and JPEG only');
    expect(mockProcessPdfWithOcrBuffer).not.toHaveBeenCalled();
  });

  it('requires one input source', async () => {
    const result = await service.recognize({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('imagePath');
  });

  it('parses targetPages into a 1-indexed selection', async () => {
    await service.recognize({ imageBase64: PNG_1X1_BASE64, targetPages: '2-3' });
    const [, opts] = mockProcessPdfWithOcrBuffer.mock.calls[0];
    expect(opts.pages).toEqual([2, 3]);
  });

  it('passes dpi through', async () => {
    await service.recognize({ imageBase64: PNG_1X1_BASE64, dpi: 200 });
    const [, opts] = mockProcessPdfWithOcrBuffer.mock.calls[0];
    expect(opts.dpi).toBe(200);
  });

  it('prefixes [Page N] only for multi-page results', async () => {
    mockProcessPdfWithOcrBuffer.mockResolvedValue(
      docFrom([{ markdown: 'aaa' }, { markdown: 'bbb', source: 'Native' }]),
    );
    const multi = await service.recognize({ imageBase64: PNG_1X1_BASE64 });
    expect(multi.text).toContain('[Page 1]');
    expect(multi.text).toContain('[Page 2]');

    mockProcessPdfWithOcrBuffer.mockResolvedValue(docFrom([{ markdown: 'aaa' }]));
    const single = await service.recognize({ imageBase64: PNG_1X1_BASE64 });
    expect(single.text).not.toContain('[Page');
    expect(single.text).toBe('aaa');
  });

  it('propagates engine failures as unsuccessful results', async () => {
    mockProcessPdfWithOcrBuffer.mockRejectedValue(
      new Error('process_pdf_with_ocr: failed to load PDFium; install a compatible PDFium shared library'),
    );
    const result = await service.recognize({ imageBase64: PNG_1X1_BASE64 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('PDFium');
  });

  it('reports missing image files', async () => {
    const result = await service.recognize({ imagePath: '/nonexistent/no-such.png' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('不存在');
  });
});
