/**
 * @firecrawl/pdf-inspector NAPI 包装层。
 *
 * 唯一允许直接 import @firecrawl/pdf-inspector 的文件。负责：
 * - Buffer 装载与大文件 warn
 * - 同步 / AsyncTask 变体选择
 * - 错误归一化为 PdfInspectorError
 * - 平台守卫（prebuilt 二进制缺失时不影响模块加载，仅在真实调用时报错）
 * - 索引约定统一：对外一律 0-indexed，对 NAPI 按其各自约定透传
 * - 越界页过滤（NAPI 对越界页码会静默返回空的"幽灵页"）
 *
 * 索引约定备忘（NAPI 侧）：
 * - extractPagesMarkdownAsync(pages)        → 0-indexed
 * - extractTextWithPositions(pages)         → 1-indexed
 * - extractStructureElements(pages)         → 1-indexed
 * - OcrOptions.pageNumbers                  → 1-indexed
 * - OcrPageResult.pageNumber                → 1-indexed
 * - OcrPdfResult.pagesRecommendedForOcr     → 1-indexed
 * - PdfClassification.pagesNeedingOcr       → 0-indexed
 * - PagesExtractionResult.pagesNeedingOcr   → 1-indexed
 * - PagesExtractionResult.pagesWithTables   → 1-indexed
 * - PagesExtractionResult.pagesWithColumns  → 1-indexed
 * - PdfResult.pagesNeedingOcr               → 1-indexed（注意与 PdfClassification 不同！）
 *
 * NAPI 越界页行为备忘：
 * - extractPagesMarkdownAsync：不报错，静默返回空 markdown、needsOcr=true
 *   的"幽灵页"——必须在调用前过滤（本层通过 classifyPdfAsync 预检页数）。
 * - processPdfWithOcr：抛出 "selected page N is invalid" 明确错误，
 *   映射为 PAGE_RANGE。
 */

import { promises as fs } from 'fs';
import type {
  StructureElementJs,
  TextItem,
  PdfClassification,
  OcrPdfResult,
  PagesExtractionResult,
} from '@firecrawl/pdf-inspector';
import type { NormalizedPdfDocument } from './pdf-inspector-types.js';
import { normalizePagesExtraction, normalizeOcrPdfResult } from './pdf-inspector-types.js';

const LARGE_FILE_WARN_BYTES = 50 * 1024 * 1024;

/** NAPI 调用错误码。 */
export type PdfInspectorErrorCode =
  | 'MISSING_FILE'
  | 'BAD_PDF'
  | 'DECRYPT'
  | 'ENCODING'
  | 'OCR_NEEDED'
  | 'PAGE_RANGE'
  | 'PLATFORM_UNSUPPORTED'
  | 'NATIVE';

export class PdfInspectorError extends Error {
  constructor(
    public code: PdfInspectorErrorCode,
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = 'PdfInspectorError';
  }
}

/**
 * Detect platform support. Lazily checked on first real use so that
 * importing this module (and the MCP server startup) does not crash on
 * platforms without prebuilt binaries — only actual PDF operations
 * surface the error.
 */
function checkPlatform(): void {
  if (process.platform === 'darwin' && process.arch !== 'arm64') {
    throw new PdfInspectorError(
      'PLATFORM_UNSUPPORTED',
      `@firecrawl/pdf-inspector prebuilt binaries are not published for macOS x86_64. ` +
        `On Intel Mac, build from source: clone https://github.com/firecrawl/pdf-inspector ` +
        `and follow its build instructions, then point node_modules/@firecrawl/pdf-inspector to your build.`,
    );
  }
}

let platformChecked = false;
function ensurePlatformSupported(): void {
  if (platformChecked) return;
  checkPlatform();
  // 仅在检查通过后置位：检查失败（抛错）时保持 false，
  // 后续调用仍会触发守卫而不是漏过。
  platformChecked = true;
}

/**
 * 原生模块懒加载：napi-rs 的 index.js 在找不到平台二进制时会在 require
 * 阶段直接 throw。若在文件顶层 static import，macOS x86_64 等不支持平台
 * 上整个 MCP server 会在启动时崩溃，平台守卫根本没机会执行。因此这里
 * 改为首次真实调用时动态 import。
 */
type PdfInspectorModule = typeof import('@firecrawl/pdf-inspector');
let nativeModulePromise: Promise<PdfInspectorModule> | null = null;

async function native(): Promise<PdfInspectorModule> {
  ensurePlatformSupported();
  if (!nativeModulePromise) {
    nativeModulePromise = import('@firecrawl/pdf-inspector').catch((err) => {
      // 加载失败（如平台二进制缺失）不缓存，允许后续调用重试；
      // 错误统一归一化为 PdfInspectorError。
      nativeModulePromise = null;
      throw classifyError(err);
    });
  }
  return nativeModulePromise;
}

async function loadBuffer(pdfPath: string): Promise<Buffer> {
  ensurePlatformSupported();
  try {
    const buf = await fs.readFile(pdfPath);
    if (buf.byteLength === 0) {
      throw new PdfInspectorError('BAD_PDF', `PDF file is empty: ${pdfPath}`);
    }
    if (buf.byteLength > LARGE_FILE_WARN_BYTES) {
      console.warn(
        `[pdf-inspector] large PDF detected (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB): ${pdfPath}. ` +
          `Consider using targetPages to limit memory.`,
      );
    }
    return buf;
  } catch (err) {
    if (err instanceof PdfInspectorError) throw err;
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new PdfInspectorError('MISSING_FILE', `PDF not found: ${pdfPath}`, e);
    }
    throw new PdfInspectorError('NATIVE', `Failed to read PDF: ${pdfPath}`, e);
  }
}

function classifyError(err: unknown): PdfInspectorError {
  if (err instanceof PdfInspectorError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (/Cannot find native binding/i.test(msg)) {
    // napi-rs 加载器消息自带支持平台列表，原样透出。
    return new PdfInspectorError('PLATFORM_UNSUPPORTED', msg, err);
  }
  if (/InvalidFileHeader|Bad PDF|not a valid PDF|Not a PDF/i.test(msg)) {
    return new PdfInspectorError('BAD_PDF', `Invalid PDF file: ${msg}`, err);
  }
  if (/selected page \d+ is invalid|page numbers are 1-indexed|invalid page number/i.test(msg)) {
    return new PdfInspectorError('PAGE_RANGE', `Page selection out of range: ${msg}`, err);
  }
  if (/password|encrypted|decrypt/i.test(msg)) {
    return new PdfInspectorError('DECRYPT', `PDF decryption failed: ${msg}`, err);
  }
  if (/encoding|CMap|ToUnicode/i.test(msg)) {
    return new PdfInspectorError('ENCODING', `PDF encoding issue: ${msg}`, err);
  }
  if (/OCR/i.test(msg)) {
    return new PdfInspectorError('OCR_NEEDED', msg, err);
  }
  return new PdfInspectorError('NATIVE', `pdf-inspector native error: ${msg}`, err);
}

/** Convert 0-indexed page selection to 1-indexed for NAPI entry points that expect 1-indexed. */
function toOneIndexed(pages?: number[]): number[] | undefined {
  if (!pages) return undefined;
  return pages.map((p) => p + 1);
}

/** Whether the sorted page list covers the whole document [0..pageCount-1]. */
function isFullRange(pages: number[], pageCount: number): boolean {
  if (pages.length !== pageCount) return false;
  for (let i = 0; i < pages.length; i++) {
    if (pages[i] !== i) return false;
  }
  return true;
}

/**
 * Best-effort `extractTextWithPositions` for encrypted PDFs.
 * `extractTextWithPositions` does not accept a password, so it may fail on
 * encrypted documents. Degrade to an empty array (textItems are optional
 * metadata) rather than failing the whole extraction.
 */
function safeExtractTextWithPositions(
  m: PdfInspectorModule,
  buffer: Buffer,
  pages?: number[],
): TextItem[] {
  try {
    return m.extractTextWithPositions(buffer, pages);
  } catch {
    return [];
  }
}

export interface ExtractPagesOptions {
  /** 0-indexed page selection. Undefined = all pages. */
  pages?: number[];
  password?: string;
  /**
   * Cap on the number of pages extracted when `pages` is not given
   * (documents with fewer pages are returned in full). Requires one extra
   * lightweight classification pass to learn the real page count.
   *
   * Ignored for password-protected PDFs: the page count cannot be
   * pre-computed without decrypting, and blindly requesting
   * `[1..maxPages]` would fail on out-of-range pages.
   */
  maxPages?: number;
  /**
   * Whether to populate `NormalizedPage.textItems` via the synchronous
   * `extractTextWithPositions` NAPI call. Default `false`.
   *
   * `extractTextWithPositions` is synchronous and blocks the event loop; only
   * enable it when the consumer actually needs positioned text items (e.g.
   * the `json` output mode). The `text` and `markdown` modes do not need it.
   */
  includeTextItems?: boolean;
}

/**
 * Extract per-page markdown + (optionally) per-page text positions.
 * `pages` is 0-indexed. Out-of-range page numbers are filtered out
 * (the NAPI would otherwise return empty phantom pages); an entirely
 * out-of-range selection throws `PAGE_RANGE`.
 *
 * Encrypted PDFs (password provided) transparently fall back to
 * `processPdfWithOcr` with `OcrMode.Off`, because `extractPagesMarkdownAsync`
 * does not accept a password.
 */
export async function extractPages(
  pdfPath: string,
  options: ExtractPagesOptions = {},
): Promise<NormalizedPdfDocument> {
  const buffer = await loadBuffer(pdfPath);
  const m = await native();
  try {
    if (options.password) {
      // 加密文档：classifyPdfAsync 解密前会抛 "PDF is encrypted"，无法预检
      // 页数，跳过越页过滤；processPdfWithOcr 自身会校验并抛出明确错误
      // （由 classifyError 映射为 PAGE_RANGE）。maxPages 在此路径不生效。
      const result: OcrPdfResult = await m.processPdfWithOcr(buffer, {
        mode: m.OcrMode.Off,
        pageNumbers: toOneIndexed(options.pages),
        password: options.password,
      });
      const textItems =
        options.includeTextItems === true
          ? safeExtractTextWithPositions(m, buffer, toOneIndexed(options.pages))
          : [];
      return normalizeOcrPdfResult(result, textItems);
    }

    // 预检真实页数：过滤越界页（NAPI 对越界页会返回幽灵空页），
    // 并安全地实施 maxPages 截断。附带收益：pdfType/confidence 得以填充。
    let pages = options.pages;
    let classification: PdfClassification | undefined;
    const wantsCap = options.maxPages !== undefined && options.maxPages >= 1;
    if (pages !== undefined || wantsCap) {
      classification = await m.classifyPdfAsync(buffer);
      const pageCount = classification.pageCount;
      if (pages !== undefined) {
        const filtered = pages.filter((p) => p >= 0 && p < pageCount);
        if (filtered.length === 0) {
          throw new PdfInspectorError(
            'PAGE_RANGE',
            `Requested pages [${pages.join(', ')}] are outside the document ` +
              `(${pageCount} page${pageCount === 1 ? '' : 's'}). Page numbers are 0-indexed.`,
          );
        }
        // 选取恰为全文档时走 NAPI 的 extract-all 快路径。
        pages = isFullRange(filtered, pageCount) ? undefined : filtered;
      } else if (options.maxPages! < pageCount) {
        pages = Array.from({ length: options.maxPages! }, (_, i) => i);
      }
    }

    const pagesResult: PagesExtractionResult = await m.extractPagesMarkdownAsync(buffer, pages);
    const textItems =
      options.includeTextItems === true
        ? m.extractTextWithPositions(buffer, toOneIndexed(pages))
        : [];
    return normalizePagesExtraction(pagesResult, textItems, classification);
  } catch (err) {
    throw classifyError(err);
  }
}

/** Per-page markdown concatenated with `--- Page N ---` separators. */
export async function extractText(
  pdfPath: string,
  options: ExtractPagesOptions = {},
): Promise<string> {
  const doc = await extractPages(pdfPath, options);
  return doc.pages
    .map((p) => `[Page ${p.pageIndex + 1}]\n${p.markdown}`.trim())
    .join('\n\n--- Page Break ---\n\n');
}

/** Full structured document as JSON-serializable object (includes textItems). */
export async function extractJson(
  pdfPath: string,
  options: ExtractPagesOptions = {},
): Promise<NormalizedPdfDocument> {
  return extractPages(pdfPath, { ...options, includeTextItems: true });
}

/** Single-string markdown output (joined without page markers). */
export async function extractMarkdown(
  pdfPath: string,
  options: ExtractPagesOptions = {},
): Promise<{ markdown: string; pagesNeedingOcr: number[]; pageCount: number }> {
  const doc = await extractPages(pdfPath, options);
  return {
    markdown: doc.pages.map((p) => p.markdown).join('\n\n'),
    pagesNeedingOcr: doc.pagesNeedingOcr,
    pageCount: doc.pageCount,
  };
}

export interface StructureElementsResult extends NormalizedPdfDocument {
  structureElements: StructureElementJs[];
}

/** Extract structure-tree references from a tagged PDF. */
export async function extractStructureElementsFor(
  pdfPath: string,
  options: ExtractPagesOptions = {},
): Promise<StructureElementsResult> {
  const buffer = await loadBuffer(pdfPath);
  const m = await native();
  try {
    const pagesResult = await m.extractPagesMarkdownAsync(buffer, options.pages);
    const structureElements = m.extractStructureElements(buffer, toOneIndexed(options.pages));
    const doc = normalizePagesExtraction(pagesResult, []);
    return { ...doc, structureElements };
  } catch (err) {
    throw classifyError(err);
  }
}

export interface ProcessPdfWithOcrOptions {
  /** 1-indexed page selection for NAPI. */
  pages?: number[];
  password?: string;
  mode?: 'Off' | 'Auto' | 'Force';
  dpi?: number;
  /** Whether to populate textItems (sync NAPI call). Default `false`. */
  includeTextItems?: boolean;
}

export async function processPdfWithOcrFor(
  pdfPath: string,
  options: ProcessPdfWithOcrOptions = {},
): Promise<NormalizedPdfDocument> {
  const buffer = await loadBuffer(pdfPath);
  return processPdfWithOcrBuffer(buffer, options);
}

/**
 * In-memory variant of `processPdfWithOcrFor` for callers that already hold
 * the PDF bytes (e.g. single-image-to-PDF wrapping without a temp file).
 */
export async function processPdfWithOcrBuffer(
  buffer: Buffer,
  options: ProcessPdfWithOcrOptions = {},
): Promise<NormalizedPdfDocument> {
  const m = await native();
  try {
    const result: OcrPdfResult = await m.processPdfWithOcr(buffer, {
      mode:
        options.mode === 'Off'
          ? m.OcrMode.Off
          : options.mode === 'Force'
            ? m.OcrMode.Force
            : m.OcrMode.Auto,
      pageNumbers: options.pages,
      password: options.password,
      dpi: options.dpi,
    });
    const textItems = options.includeTextItems
      ? m.extractTextWithPositions(buffer, options.pages)
      : [];
    return normalizeOcrPdfResult(result, textItems);
  } catch (err) {
    throw classifyError(err);
  }
}

/**
 * Quick classification (pdfType + page count + OCR pages). All page arrays
 * are 0-indexed. Uses the NAPI `classifyPdfAsync` lightweight entry point
 * (non-blocking); note that `PdfClassification.pagesNeedingOcr` is
 * 0-indexed, unlike `PdfResult.pagesNeedingOcr` which is 1-indexed.
 */
export async function classifyPdf(pdfPath: string): Promise<{
  pdfType: string;
  pageCount: number;
  pagesNeedingOcr: number[];
  confidence: number;
}> {
  const buffer = await loadBuffer(pdfPath);
  const m = await native();
  try {
    const result: PdfClassification = await m.classifyPdfAsync(buffer);
    return {
      pdfType: result.pdfType,
      pageCount: result.pageCount,
      pagesNeedingOcr: result.pagesNeedingOcr,
      confidence: result.confidence,
    };
  } catch (err) {
    throw classifyError(err);
  }
}
