/**
 * Adapter: align NAPI-extracted NormalizedPdfDocument with the public MCP
 * `extract_pdf_text` tool's three-mode output contract (text | json | markdown).
 *
 * - `text`: per-page markdown joined with `--- Page Break ---` separators.
 * - `json`: full NormalizedPdfDocument serialized (includes textItems).
 * - `markdown`: per-page markdown joined with paragraph breaks.
 *
 * Page selection: input is `string` (`"1-5,10"`) 1-indexed.
 * Conversion to 0-indexed happens here; service receives 0-indexed.
 *
 * `maxPages` caps the number of pages extracted (default
 * `DEFAULT_MAX_PAGES`). When `targetPages` is also given, the parsed list is
 * truncated to the first `maxPages` entries. Without `targetPages`, the cap
 * is delegated to the service, which validates it against the real page
 * count (the NAPI silently returns empty phantom pages for out-of-range
 * page numbers).
 */
import type { PdfExtractOptions, PdfExtractResult, PdfOutputFormat } from './types.js';
import type { NormalizedPdfDocument } from './pdf-inspector-types.js';
import * as pdfInspector from './pdf-inspector-service.js';
import { PdfInspectorError } from './pdf-inspector-service.js';

/** Default cap on extracted pages, matching the tool description. */
const DEFAULT_MAX_PAGES = 1000;

/** Upper bound on expanded page selections, to prevent OOM on ranges like "1-999999999". */
const MAX_SELECTABLE_PAGES = 100_000;

/**
 * Parse a page range string like `"1-5,10,15-20"` into a 1-indexed sorted array.
 * Returns `undefined` when `spec` is empty/undefined (whole document).
 *
 * Rejects non-integer tokens (e.g. `1e3`, `5.0`, `0x10`) by requiring the
 * raw string to consist solely of decimal digits, and rejects selections
 * that would expand to more than `MAX_SELECTABLE_PAGES` entries.
 */
export function parsePages(spec: string | undefined): number[] | undefined {
  if (!spec) return undefined;
  const pages: number[] = [];
  const seen = new Set<number>();
  for (const part of spec.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) throw new Error(`Invalid page range: "${spec}"`);
    if (trimmed.includes('-')) {
      const dash = trimmed.indexOf('-');
      const startRaw = trimmed.slice(0, dash).trim();
      const endRaw = trimmed.slice(dash + 1).trim();
      if (!isPositiveInt(startRaw) || !isPositiveInt(endRaw)) {
        throw new Error(`Invalid page range: "${spec}"`);
      }
      const start = Number(startRaw);
      const end = Number(endRaw);
      if (start > end) throw new Error(`Invalid page range (start > end): "${spec}"`);
      if (pages.length + (end - start + 1) > MAX_SELECTABLE_PAGES) {
        throw new Error(
          `Invalid page range: "${spec}" selects more than ${MAX_SELECTABLE_PAGES} pages`,
        );
      }
      for (let i = start; i <= end; i++) {
        if (!seen.has(i)) {
          seen.add(i);
          pages.push(i);
        }
      }
    } else {
      if (!isPositiveInt(trimmed)) throw new Error(`Invalid page range: "${spec}"`);
      const n = Number(trimmed);
      if (!seen.has(n)) {
        seen.add(n);
        pages.push(n);
      }
    }
  }
  return pages;
}

function isPositiveInt(s: string): boolean {
  if (!/^\d+$/.test(s)) return false;
  const n = Number(s);
  return n >= 1 && Number.isSafeInteger(n);
}

/** Normalize `maxPages`: invalid values (< 1, non-finite) fall back to the default. */
function resolveMaxPages(maxPages?: number): number {
  if (maxPages === undefined || !Number.isFinite(maxPages) || maxPages < 1) {
    return DEFAULT_MAX_PAGES;
  }
  return Math.floor(maxPages);
}

/**
 * OCR setup 类失败判定：PDFium/ONNX Runtime 加载失败、模型下载/校验失败。
 * 这些失败与文档内容无关，原生提取路径仍可产出（对扫描页可能不完整的）文本，
 * 因此调用方应回退而非整体失败。页面质量问题（低置信、空结果）不属于此类。
 * 文案来源：darwin-arm64 缺 dylib 与模型下载超时的实测输出。
 */
function isOcrSetupError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /failed to load (?:PDFium|ONNX Runtime)/i.test(msg) ||
    /PDFIUM_LIB_PATH|ORT_DYLIB_PATH/i.test(msg) ||
    /model (?:cache|download|acquisition)|install a compatible/i.test(msg)
  );
}

/** Mode string for the service layer ('Auto' | 'Force'). */
function toOcrMode(mode: 'auto' | 'force'): 'Auto' | 'Force' {
  return mode === 'force' ? 'Force' : 'Auto';
}

/**
 * Local selective OCR via processPdfWithOcrFor.
 *
 * `pages` is 0-indexed; the service entry point takes 1-indexed directly.
 * Without an explicit page selection, the document is classified once to
 * apply the maxPages cap (the OCR entry point has no cap of its own).
 * Classification (and hence capping) is skipped for encrypted PDFs — the
 * classifier cannot see page counts before decryption, and the OCR call
 * validates page numbers itself.
 */
async function extractViaOcr(
  pdfPath: string,
  mode: 'auto' | 'force',
  pages: number[] | undefined,
  maxPages: number,
  password: string | undefined,
  includeTextItems: boolean,
): Promise<NormalizedPdfDocument> {
  let oneIndexed = pages?.map((p) => p + 1);
  if (!oneIndexed && !password) {
    try {
      const { pageCount } = await pdfInspector.classifyPdf(pdfPath);
      if (maxPages < pageCount) {
        oneIndexed = Array.from({ length: maxPages }, (_, i) => i + 1);
      }
    } catch {
      // 预检失败（加密/损坏）→ 不截断，交由 OCR 调用自身校验
    }
  }
  return pdfInspector.processPdfWithOcrFor(pdfPath, {
    mode: toOcrMode(mode),
    pages: oneIndexed,
    password,
    includeTextItems,
  });
}

export async function extractPdf(
  options: PdfExtractOptions,
): Promise<PdfExtractResult> {
  const start = Date.now();
  const format: PdfOutputFormat = options.outputFormat ?? 'text';
  const ocrRequested = options.ocr === 'auto' || options.ocr === 'force';
  try {
    const parsed = parsePages(options.targetPages);
    const zeroIndexed = parsed?.map((p) => p - 1);
    const maxPages = resolveMaxPages(options.maxPages);

    // With an explicit selection, truncate to the first maxPages entries.
    // Without one, pass maxPages through — the service validates it against
    // the real page count and never requests out-of-range pages.
    const pages = zeroIndexed?.slice(0, maxPages);

    if (ocrRequested) {
      let doc: NormalizedPdfDocument;
      let ocrWarning: string | undefined;
      try {
        doc = await extractViaOcr(
          options.pdfPath,
          options.ocr === 'force' ? 'force' : 'auto',
          pages,
          maxPages,
          options.password,
          format === 'json',
        );
      } catch (err) {
        if (!isOcrSetupError(err)) throw err;
        ocrWarning =
          `Local OCR unavailable (${err instanceof Error ? err.message : String(err)}); ` +
          'returning native text, which may be incomplete for scanned pages.';
        doc = await pdfInspector.extractPages(options.pdfPath, {
          pages,
          password: options.password,
          maxPages,
        });
      }
      return assembleResult(doc, format, ocrWarning, start);
    }

    if (format === 'text') {
      const doc = await pdfInspector.extractPages(options.pdfPath, {
        pages,
        password: options.password,
        maxPages,
      });
      const pageTexts = doc.pages.map((p) => {
        const parts: string[] = [`[Page ${p.pageIndex + 1}]`];
        if (p.needsOcr) {
          parts.push(`(Page ${p.pageIndex + 1} flagged for OCR — text content may be unreliable)`);
        }
        if (p.markdown) {
          parts.push(p.markdown);
        }
        return parts.join('\n\n');
      });
      return {
        success: true,
        text: pageTexts.join('\n\n--- Page Break ---\n\n').trim(),
        pageCount: doc.pageCount,
        details: { processingTime: Date.now() - start },
      };
    }

    if (format === 'json') {
      const doc = await pdfInspector.extractPages(options.pdfPath, {
        pages,
        password: options.password,
        maxPages,
        includeTextItems: true,
      });
      return {
        success: true,
        text: JSON.stringify(doc, null, 2),
        pageCount: doc.pageCount,
        details: { processingTime: Date.now() - start },
      };
    }

    // markdown
    const { markdown, pagesNeedingOcr, pageCount } = await pdfInspector.extractMarkdown(
      options.pdfPath,
      { pages, password: options.password, maxPages },
    );
    const prefix =
      pagesNeedingOcr.length > 0
        ? `<!-- OCR warning: ${pagesNeedingOcr.length} page(s) [${pagesNeedingOcr
            .map((p) => p + 1)
            .join(', ')}] flagged for OCR; native text may be incomplete. -->\n\n`
        : '';
    return {
      success: true,
      text: prefix + markdown,
      pageCount,
      details: { processingTime: Date.now() - start },
    };
  } catch (err) {
    if (err instanceof PdfInspectorError) {
      return {
        success: false,
        error: `${err.code}: ${err.message}`,
        details: {
          processingTime: Date.now() - start,
        },
      };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      details: { processingTime: Date.now() - start },
    };
  }
}

/**
 * Assemble the OCR-path document into the three-mode output contract.
 *
 * Warning semantics differ from the native path: content has already been
 * locally OCR'd, so pages are annotated by provenance instead of the
 * "flagged for OCR" marker — only pages whose OCR result still looks
 * incomplete (hostedRecommended) warn about incompleteness.
 */
function assembleResult(
  doc: NormalizedPdfDocument,
  format: PdfOutputFormat,
  ocrWarning: string | undefined,
  start: number,
): PdfExtractResult {
  if (format === 'json') {
    return {
      success: true,
      text: JSON.stringify(doc, null, 2),
      pageCount: doc.pageCount,
      details: { processingTime: Date.now() - start },
    };
  }

  const hostedPages = doc.pages
    .filter((p) => p.ocrProvenance?.hostedRecommended)
    .map((p) => p.pageIndex + 1);

  if (format === 'text') {
    const pageTexts = doc.pages.map((p) => {
      const parts: string[] = [`[Page ${p.pageIndex + 1}]`];
      const prov = p.ocrProvenance;
      if (prov && prov.source !== 'Native') {
        const conf =
          prov.ocrConfidence !== undefined ? ` (confidence ${prov.ocrConfidence.toFixed(2)})` : '';
        parts.push(`(Page ${p.pageIndex + 1}: local OCR applied${conf})`);
      }
      if (prov?.hostedRecommended) {
        parts.push(
          `(Page ${p.pageIndex + 1}: OCR result looks incomplete — consider a hosted parser)`,
        );
      }
      if (p.markdown) parts.push(p.markdown);
      return parts.join('\n\n');
    });
    const text = pageTexts.join('\n\n--- Page Break ---\n\n').trim();
    return {
      success: true,
      text: ocrWarning ? `${ocrWarning}\n\n${text}` : text,
      pageCount: doc.pageCount,
      details: { processingTime: Date.now() - start },
    };
  }

  // markdown
  const markdown = doc.pages.map((p) => p.markdown).join('\n\n');
  const mdPrefix = ocrWarning
    ? `<!-- ${ocrWarning} -->\n\n`
    : hostedPages.length > 0
      ? `<!-- OCR warning: ${hostedPages.length} page(s) [${hostedPages.join(', ')}] look incomplete after local OCR. -->\n\n`
      : '';
  return {
    success: true,
    text: mdPrefix + markdown,
    pageCount: doc.pageCount,
    details: { processingTime: Date.now() - start },
  };
}
