/**
 * Unit tests for pdf-extract-adapter.
 * Mocks @firecrawl/pdf-inspector-service to verify adapter contract.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockExtractPages = vi.fn();
const mockExtractMarkdown = vi.fn();
const mockProcessPdfWithOcrFor = vi.fn();
const mockClassifyPdf = vi.fn();

vi.mock('../src/pdf-inspector-service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/pdf-inspector-service.js')>(
    '../src/pdf-inspector-service.js',
  );
  return {
    ...actual,
    extractPages: (...args: unknown[]) => mockExtractPages(...args),
    extractMarkdown: (...args: unknown[]) => mockExtractMarkdown(...args),
    processPdfWithOcrFor: (...args: unknown[]) => mockProcessPdfWithOcrFor(...args),
    classifyPdf: (...args: unknown[]) => mockClassifyPdf(...args),
  };
});

import { extractPdf } from '../src/pdf-extract-adapter.js';

beforeEach(() => {
  mockExtractPages.mockReset();
  mockExtractMarkdown.mockReset();
  mockProcessPdfWithOcrFor.mockReset();
  mockClassifyPdf.mockReset();
});

describe('extractPdf', () => {
  it('text format joins pages with separators', async () => {
    mockExtractPages.mockResolvedValue({
      pageCount: 2,
      pages: [
        { pageIndex: 0, markdown: 'Hello world', needsOcr: false, textItems: [] },
        { pageIndex: 1, markdown: 'Page two', needsOcr: false, textItems: [] },
      ],
      pagesNeedingOcr: [],
    });
    const result = await extractPdf({
      pdfPath: '/tmp/x.pdf',
      outputFormat: 'text',
    });
    expect(result.success).toBe(true);
    expect(result.pageCount).toBe(2);
    expect(result.text).toContain('[Page 1]');
    expect(result.text).toContain('Hello world');
    expect(result.text).toContain('--- Page Break ---');
    expect(result.text).toContain('Page two');
  });

  it('text format does not append trailing page-break separator', async () => {
    mockExtractPages.mockResolvedValue({
      pageCount: 2,
      pages: [
        { pageIndex: 0, markdown: 'A', needsOcr: false, textItems: [] },
        { pageIndex: 1, markdown: 'B', needsOcr: false, textItems: [] },
      ],
      pagesNeedingOcr: [],
    });
    const result = await extractPdf({ pdfPath: '/tmp/x.pdf', outputFormat: 'text' });
    expect(result.success).toBe(true);
    expect(result.text!.endsWith('--- Page Break ---')).toBe(false);
    expect(result.text!.endsWith('B')).toBe(true);
  });

  it('text format flags pages needing OCR', async () => {
    mockExtractPages.mockResolvedValue({
      pageCount: 1,
      pages: [
        { pageIndex: 0, markdown: '', needsOcr: true, textItems: [] },
      ],
      pagesNeedingOcr: [0],
    });
    const result = await extractPdf({
      pdfPath: '/tmp/x.pdf',
      outputFormat: 'text',
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain('flagged for OCR');
  });

  it('json format requests includeTextItems and serializes full document', async () => {
    const doc = {
      pageCount: 1,
      pdfType: 'TextBased',
      pages: [{ pageIndex: 0, markdown: 'x', needsOcr: false, textItems: [{ page: 1 }] }],
      pagesNeedingOcr: [],
      pagesWithTables: [],
      pagesWithColumns: [],
    };
    mockExtractPages.mockResolvedValue(doc);
    const result = await extractPdf({
      pdfPath: '/tmp/x.pdf',
      outputFormat: 'json',
    });
    expect(result.success).toBe(true);
    expect(mockExtractPages).toHaveBeenCalledWith('/tmp/x.pdf', expect.objectContaining({ includeTextItems: true }));
    expect(JSON.parse(result.text!)).toEqual(doc);
  });

  it('markdown format joins pages and returns pageCount', async () => {
    mockExtractMarkdown.mockResolvedValue({
      markdown: '# A\n\ntext\n\n# B\n\nmore',
      pagesNeedingOcr: [],
      pageCount: 3,
    });
    const result = await extractPdf({
      pdfPath: '/tmp/x.pdf',
      outputFormat: 'markdown',
    });
    expect(result.success).toBe(true);
    expect(result.text).toBe('# A\n\ntext\n\n# B\n\nmore');
    expect(result.pageCount).toBe(3);
  });

  it('markdown format prepends OCR warning when pages need OCR', async () => {
    mockExtractMarkdown.mockResolvedValue({
      markdown: 'content',
      pagesNeedingOcr: [1, 3],
      pageCount: 5,
    });
    const result = await extractPdf({
      pdfPath: '/tmp/x.pdf',
      outputFormat: 'markdown',
    });
    expect(result.success).toBe(true);
    expect(result.text).toMatch(/^<!-- OCR warning/);
    expect(result.text).toContain('[2, 4]');
    expect(result.text).toContain('content');
  });

  it('converts 1-indexed targetPages to 0-indexed for service', async () => {
    mockExtractPages.mockResolvedValue({ pageCount: 1, pages: [], pagesNeedingOcr: [] });
    await extractPdf({ pdfPath: '/tmp/x.pdf', outputFormat: 'text', targetPages: '1-3,5' });
    expect(mockExtractPages).toHaveBeenCalledWith('/tmp/x.pdf', {
      pages: [0, 1, 2, 4],
      password: undefined,
      maxPages: 1000,
    });
  });

  it('passes password through to service', async () => {
    mockExtractPages.mockResolvedValue({ pageCount: 1, pages: [], pagesNeedingOcr: [] });
    await extractPdf({ pdfPath: '/tmp/x.pdf', outputFormat: 'text', password: 'secret' });
    expect(mockExtractPages).toHaveBeenCalledWith('/tmp/x.pdf', {
      pages: undefined,
      password: 'secret',
      maxPages: 1000,
    });
  });

  it('maxPages truncates targetPages selection', async () => {
    mockExtractPages.mockResolvedValue({ pageCount: 2, pages: [], pagesNeedingOcr: [] });
    await extractPdf({
      pdfPath: '/tmp/x.pdf',
      outputFormat: 'text',
      targetPages: '1-10',
      maxPages: 3,
    });
    expect(mockExtractPages).toHaveBeenCalledWith('/tmp/x.pdf', {
      pages: [0, 1, 2],
      password: undefined,
      maxPages: 3,
    });
  });

  it('maxPages without targetPages is delegated to the service (no blind page list)', async () => {
    mockExtractPages.mockResolvedValue({ pageCount: 5, pages: [], pagesNeedingOcr: [] });
    await extractPdf({
      pdfPath: '/tmp/x.pdf',
      outputFormat: 'text',
      maxPages: 5,
    });
    // The service validates maxPages against the real page count; the adapter
    // must not build [0..maxPages-1] itself (out-of-range pages would produce
    // empty phantom pages in the NAPI).
    expect(mockExtractPages).toHaveBeenCalledWith('/tmp/x.pdf', {
      pages: undefined,
      password: undefined,
      maxPages: 5,
    });
  });

  it('applies the default maxPages of 1000 when unspecified', async () => {
    mockExtractPages.mockResolvedValue({ pageCount: 1, pages: [], pagesNeedingOcr: [] });
    await extractPdf({ pdfPath: '/tmp/x.pdf', outputFormat: 'text' });
    expect(mockExtractPages).toHaveBeenCalledWith('/tmp/x.pdf', {
      pages: undefined,
      password: undefined,
      maxPages: 1000,
    });
  });

  it('invalid maxPages falls back to the default', async () => {
    mockExtractPages.mockResolvedValue({ pageCount: 1, pages: [], pagesNeedingOcr: [] });
    await extractPdf({ pdfPath: '/tmp/x.pdf', outputFormat: 'text', maxPages: 0 });
    expect(mockExtractPages).toHaveBeenCalledWith('/tmp/x.pdf', {
      pages: undefined,
      password: undefined,
      maxPages: 1000,
    });
    await extractPdf({ pdfPath: '/tmp/x.pdf', outputFormat: 'text', maxPages: -3 });
    expect(mockExtractPages).toHaveBeenLastCalledWith('/tmp/x.pdf', {
      pages: undefined,
      password: undefined,
      maxPages: 1000,
    });
  });

  it('catches PdfInspectorError and returns structured failure', async () => {
    const { PdfInspectorError } = await import('../src/pdf-inspector-service.js');
    mockExtractPages.mockRejectedValue(
      new PdfInspectorError('BAD_PDF', 'Invalid PDF header'),
    );
    const result = await extractPdf({ pdfPath: '/tmp/x.pdf', outputFormat: 'text' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('BAD_PDF');
    expect(result.error).toContain('Invalid PDF header');
  });

  it('catches unknown errors as stringified messages', async () => {
    mockExtractPages.mockRejectedValue(new Error('boom'));
    const result = await extractPdf({ pdfPath: '/tmp/x.pdf', outputFormat: 'text' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
  });

  it('invalid targetPages throws a parse error', async () => {
    const result = await extractPdf({ pdfPath: '/tmp/x.pdf', outputFormat: 'text', targetPages: 'abc' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid page range/);
  });
});

/** OCR 路径的 NormalizedPdfDocument fixture。 */
function ocrDoc(pages: Array<{ markdown: string; source: 'Native' | 'Ocr' | 'Fused'; ocrConfidence?: number; hostedRecommended?: boolean }>) {
  return {
    pageCount: pages.length,
    pdfType: 'Unknown',
    pages: pages.map((p, i) => ({
      pageIndex: i,
      markdown: p.markdown,
      needsOcr: p.source !== 'Native',
      textItems: [],
      ocrProvenance: {
        source: p.source,
        ocrConfidence: p.ocrConfidence,
        hostedRecommended: p.hostedRecommended ?? false,
        warnings: [],
      },
    })),
    pagesNeedingOcr: [0],
    pagesWithTables: [],
    pagesWithColumns: [],
    processingTimeMs: 10,
    isComplexLayout: false,
    hasEncodingIssues: false,
    confidence: 0,
  };
}

describe('extractPdf OCR path', () => {
  it('ocr=auto routes to processPdfWithOcrFor with 1-indexed pages and Auto mode', async () => {
    mockProcessPdfWithOcrFor.mockResolvedValue(ocrDoc([{ markdown: 'A', source: 'Ocr', ocrConfidence: 0.97 }]));
    const result = await extractPdf({ pdfPath: '/tmp/x.pdf', ocr: 'auto', targetPages: '1-2' });
    expect(result.success).toBe(true);
    expect(mockProcessPdfWithOcrFor).toHaveBeenCalledWith('/tmp/x.pdf', {
      mode: 'Auto',
      pages: [1, 2],
      password: undefined,
      includeTextItems: false,
    });
    expect(mockExtractPages).not.toHaveBeenCalled();
  });

  it('ocr=force maps to Force mode', async () => {
    mockProcessPdfWithOcrFor.mockResolvedValue(ocrDoc([{ markdown: 'A', source: 'Ocr' }]));
    await extractPdf({ pdfPath: '/tmp/x.pdf', ocr: 'force' });
    expect(mockProcessPdfWithOcrFor).toHaveBeenCalledWith(
      '/tmp/x.pdf',
      expect.objectContaining({ mode: 'Force' }),
    );
  });

  it('default does not trigger OCR', async () => {
    mockExtractPages.mockResolvedValue({ pageCount: 1, pages: [], pagesNeedingOcr: [] });
    await extractPdf({ pdfPath: '/tmp/x.pdf' });
    expect(mockProcessPdfWithOcrFor).not.toHaveBeenCalled();
    expect(mockClassifyPdf).not.toHaveBeenCalled();
  });

  it('caps pages via classify when no explicit selection and maxPages < pageCount', async () => {
    mockClassifyPdf.mockResolvedValue({ pdfType: 'Scanned', pageCount: 100, confidence: 0.9, pagesNeedingOcr: [] });
    mockProcessPdfWithOcrFor.mockResolvedValue(ocrDoc([{ markdown: 'A', source: 'Ocr' }]));
    await extractPdf({ pdfPath: '/tmp/x.pdf', ocr: 'auto', maxPages: 5 });
    expect(mockClassifyPdf).toHaveBeenCalledWith('/tmp/x.pdf');
    expect(mockProcessPdfWithOcrFor).toHaveBeenCalledWith(
      '/tmp/x.pdf',
      expect.objectContaining({ pages: [1, 2, 3, 4, 5] }),
    );
  });

  it('skips classify capping when maxPages >= pageCount', async () => {
    mockClassifyPdf.mockResolvedValue({ pdfType: 'Scanned', pageCount: 3, confidence: 0.9, pagesNeedingOcr: [] });
    mockProcessPdfWithOcrFor.mockResolvedValue(ocrDoc([{ markdown: 'A', source: 'Ocr' }]));
    await extractPdf({ pdfPath: '/tmp/x.pdf', ocr: 'auto', maxPages: 5 });
    expect(mockProcessPdfWithOcrFor).toHaveBeenCalledWith(
      '/tmp/x.pdf',
      expect.objectContaining({ pages: undefined }),
    );
  });

  it('skips classify capping for encrypted PDFs', async () => {
    mockProcessPdfWithOcrFor.mockResolvedValue(ocrDoc([{ markdown: 'A', source: 'Ocr' }]));
    await extractPdf({ pdfPath: '/tmp/x.pdf', ocr: 'auto', password: 'pw', maxPages: 5 });
    expect(mockClassifyPdf).not.toHaveBeenCalled();
  });

  it('setup failure falls back to native extraction with a warning', async () => {
    mockProcessPdfWithOcrFor.mockRejectedValue(
      new Error('process_pdf_with_ocr: failed to load PDFium; install a compatible PDFium shared library or set PDFIUM_LIB_PATH'),
    );
    mockExtractPages.mockResolvedValue({
      pageCount: 1,
      pages: [{ pageIndex: 0, markdown: 'native text', needsOcr: true, textItems: [] }],
      pagesNeedingOcr: [0],
    });
    const result = await extractPdf({ pdfPath: '/tmp/x.pdf', ocr: 'auto', outputFormat: 'text' });
    expect(result.success).toBe(true);
    expect(result.text).toContain('Local OCR unavailable');
    expect(result.text).toContain('PDFIUM_LIB_PATH');
    expect(result.text).toContain('native text');
    expect(mockExtractPages).toHaveBeenCalledTimes(1);
  });

  it('non-setup failure fails the call instead of silently degrading', async () => {
    mockProcessPdfWithOcrFor.mockRejectedValue(new Error('boom'));
    const result = await extractPdf({ pdfPath: '/tmp/x.pdf', ocr: 'auto' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
  });

  it('text output annotates OCR pages by provenance, not the flagged marker', async () => {
    mockProcessPdfWithOcrFor.mockResolvedValue(
      ocrDoc([
        { markdown: 'scanned words', source: 'Ocr', ocrConfidence: 0.912 },
        { markdown: 'native words', source: 'Native' },
      ]),
    );
    const result = await extractPdf({ pdfPath: '/tmp/x.pdf', ocr: 'auto', outputFormat: 'text' });
    expect(result.text).toContain('local OCR applied (confidence 0.91)');
    expect(result.text).not.toContain('flagged for OCR');
    expect(result.text).toContain('scanned words');
  });

  it('text output warns only for hostedRecommended pages', async () => {
    mockProcessPdfWithOcrFor.mockResolvedValue(
      ocrDoc([{ markdown: '', source: 'Ocr', hostedRecommended: true }]),
    );
    const result = await extractPdf({ pdfPath: '/tmp/x.pdf', ocr: 'auto', outputFormat: 'text' });
    expect(result.text).toContain('OCR result looks incomplete');
  });

  it('markdown output prepends incomplete-page comment when hostedRecommended', async () => {
    mockProcessPdfWithOcrFor.mockResolvedValue(
      ocrDoc([
        { markdown: 'a', source: 'Ocr' },
        { markdown: 'b', source: 'Ocr', hostedRecommended: true },
      ]),
    );
    const result = await extractPdf({ pdfPath: '/tmp/x.pdf', ocr: 'auto', outputFormat: 'markdown' });
    expect(result.text).toMatch(/^<!-- OCR warning: 1 page\(s\) \[2\]/);
    expect(result.text).toContain('a\n\nb');
  });

  it('json output includes ocrProvenance per page', async () => {
    mockProcessPdfWithOcrFor.mockResolvedValue(
      ocrDoc([{ markdown: 'A', source: 'Fused', ocrConfidence: 0.88 }]),
    );
    const result = await extractPdf({ pdfPath: '/tmp/x.pdf', ocr: 'auto', outputFormat: 'json' });
    expect(result.success).toBe(true);
    const doc = JSON.parse(result.text!);
    expect(doc.pages[0].ocrProvenance).toEqual({
      source: 'Fused',
      ocrConfidence: 0.88,
      hostedRecommended: false,
      warnings: [],
    });
    expect(mockProcessPdfWithOcrFor).toHaveBeenCalledWith(
      '/tmp/x.pdf',
      expect.objectContaining({ includeTextItems: true }),
    );
  });
});
