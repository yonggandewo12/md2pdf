/**
 * @firecrawl/pdf-inspector NAPI 类型映射与内部标准化。
 *
 * 对外统一为 0-indexed；内部按 NAPI 各字段约定透传。
 *
 * `pageCount` 语义：
 * - 走 `extractPagesMarkdownAsync` 路径时，NAPI 不返回总页数，
 *   `pageCount` 取 `pages.length`（未选页时即总页数；选页时为返回页数）。
 * - 走 `processPdfWithOcr` 路径时，NAPI 返回真实总页数，直接采用。
 */
import type {
  PagesExtractionResult,
  TextItem,
  OcrPdfResult,
  PageOcrReasons,
  StructureElementJs,
} from '@firecrawl/pdf-inspector';

// 注意：本文件只允许 type-only import/re-export。任何值导出（如
// `export { OcrMode } from ...`）都会在模块加载阶段触发原生二进制
// require，导致无 prebuilt 二进制的平台（macOS x86_64）在启动时崩溃。

export type {
  TextItem,
  PageOcrReasons,
  StructureElementJs,
};

/** pdfType fallback when the underlying NAPI result has no pdfType field. */
export const UNKNOWN_PDF_TYPE = 'Unknown';

/** 标准化后的 PDF 文档。**所有页码字段统一 0-indexed。** */
export interface NormalizedPdfDocument {
  /** 返回的页数（未选页时等于文档总页数；选页时为实际返回的页数）。 */
  pageCount: number;
  pdfType: string;
  pages: NormalizedPage[];
  /** 0-indexed */
  pagesNeedingOcr: number[];
  /** 0-indexed */
  pagesWithTables: number[];
  /** 0-indexed */
  pagesWithColumns: number[];
  processingTimeMs: number;
  isComplexLayout: boolean;
  hasEncodingIssues: boolean;
  title?: string;
  confidence: number;
}

export interface NormalizedPage {
  /** 0-indexed */
  pageIndex: number;
  markdown: string;
  needsOcr: boolean;
  ocrReason?: string;
  textItems: TextItem[];
  /**
   * OCR 路径（processPdfWithOcr）填充：该页内容来源与质量信息。
   * native 提取路径（extractPagesMarkdownAsync）为 undefined。
   */
  ocrProvenance?: NormalizedOcrProvenance;
}

/** 单页 OCR 来源与质量摘要（0-indexed 语义无关，仅透传 NAPI 字段）。 */
export interface NormalizedOcrProvenance {
  /** 页面内容来源：Native=原生文本，Ocr=本地 OCR，Fused=两者融合。 */
  source: 'Native' | 'Ocr' | 'Fused';
  /** OCR 置信度（0-1），仅 Ocr/Fused 页存在。 */
  ocrConfidence?: number;
  /** OCR 完成后仍空/低置信/疑似不完整，建议托管解析。 */
  hostedRecommended: boolean;
  warnings: string[];
}

/** Group 1-indexed TextItems into a 0-indexed page → items map. */
function groupTextItemsByPage(textItems: TextItem[]): Map<number, TextItem[]> {
  const byPage = new Map<number, TextItem[]>();
  for (const item of textItems) {
    const idx = item.page - 1;
    const list = byPage.get(idx) ?? [];
    list.push(item);
    byPage.set(idx, list);
  }
  return byPage;
}

/**
 * Normalize `PagesExtractionResult` (from `extractPagesMarkdownAsync`) to
 * 0-indexed `NormalizedPdfDocument`.
 *
 * NAPI 侧 `pagesNeedingOcr` / `pagesWithTables` / `pagesWithColumns` 均为
 * 1-indexed，此处统一转 0-indexed。
 *
 * `classification`（可选）来自 `classifyPdfAsync` 的预检结果，用于填充
 * `pdfType` / `confidence`；未预检时回落到 `Unknown` / 0。
 */
export function normalizePagesExtraction(
  raw: PagesExtractionResult,
  textItems: TextItem[],
  classification?: { pdfType: string; confidence: number },
): NormalizedPdfDocument {
  const itemsByPage = groupTextItemsByPage(textItems);

  const pages: NormalizedPage[] = raw.pages.map((p) => ({
    pageIndex: p.page,
    markdown: p.markdown,
    needsOcr: p.needsOcr,
    ocrReason: p.ocrReason,
    textItems: itemsByPage.get(p.page) ?? [],
  }));

  return {
    pageCount: pages.length,
    pdfType: classification?.pdfType ?? UNKNOWN_PDF_TYPE,
    pages,
    pagesNeedingOcr: raw.pagesNeedingOcr.map((p) => p - 1),
    pagesWithTables: raw.pagesWithTables.map((p) => p - 1),
    pagesWithColumns: raw.pagesWithColumns.map((p) => p - 1),
    processingTimeMs: 0,
    isComplexLayout: raw.isComplex,
    hasEncodingIssues: false,
    confidence: classification?.confidence ?? 0,
  };
}

/**
 * Normalize `OcrPdfResult` (from `processPdfWithOcr`) to 0-indexed
 * `NormalizedPdfDocument`. Uses NAPI's real `pageCount`.
 *
 * `textItems` is optional; populate it via `extractTextWithPositions` at the
 * call site when needed (it is a synchronous blocking NAPI call).
 */
export function normalizeOcrPdfResult(
  result: OcrPdfResult,
  textItems: TextItem[] = [],
): NormalizedPdfDocument {
  const itemsByPage = groupTextItemsByPage(textItems);

  const pages: NormalizedPage[] = result.pages.map((p) => ({
    pageIndex: p.pageNumber - 1,
    markdown: p.markdown,
    needsOcr: p.provenance.source !== 'Native',
    ocrReason: undefined,
    textItems: itemsByPage.get(p.pageNumber - 1) ?? [],
    ocrProvenance: {
      source: p.provenance.source,
      ocrConfidence: p.provenance.ocrConfidence,
      hostedRecommended: p.provenance.hostedRecommended,
      warnings: p.provenance.warnings,
    },
  }));

  return {
    pageCount: result.pageCount,
    pdfType: UNKNOWN_PDF_TYPE,
    pages,
    pagesNeedingOcr: result.pagesRecommendedForOcr.map((p) => p - 1),
    pagesWithTables: result.pagesWithTables.map((p) => p - 1),
    pagesWithColumns: result.pagesWithColumns.map((p) => p - 1),
    processingTimeMs: result.processingTimeMs,
    isComplexLayout: result.isComplex,
    hasEncodingIssues: false,
    confidence: 0,
  };
}
