export interface PdfOptions {
  format?: 'A4' | 'A3' | 'Letter' | 'Legal' | 'Tabloid';
  landscape?: boolean;
  printBackground?: boolean;
  scale?: number;
  marginTop?: string;
  marginBottom?: string;
  marginLeft?: string;
  marginRight?: string;
  displayHeaderFooter?: boolean;
  headerTemplate?: string;
  footerTemplate?: string;
  preferCSSPageSize?: boolean;
}

export interface ConvertOptions extends PdfOptions {
  htmlPath?: string;
  htmlContent?: string;
  outputPath?: string;
  waitForNetworkIdle?: boolean;
  waitForMermaid?: boolean;
  timeout?: number;
}

export interface ConvertResult {
  success: boolean;
  outputPath?: string;
  error?: string;
  details?: {
    processingTime: number;
    fileSize?: number;
  };
}

// === HTML → Image ===

export interface ImageFormat {
  /** Output image format (default: 'png') */
  imageFormat?: 'png' | 'jpeg';
  /** Quality for JPEG format (default: 90, range: 0-100) */
  quality?: number;
  /** Whether to capture full page or just viewport (default: false) */
  fullPage?: boolean;
  /** Screenshot scale (default: 1, range: 0.1 to 2) */
  imageScale?: number;
}

export interface ConvertImageOptions extends ImageFormat, ConvertOptions {}

export interface ImageConvertResult {
  success: boolean;
  outputPath?: string;
  error?: string;
  details?: {
    processingTime: number;
    fileSize?: number;
    width?: number;
    height?: number;
  };
}

// === Markdown → HTML / PDF ===

export interface MdToPdfOptions {
  /** Path to markdown file */
  mdPath?: string;
  /** Markdown content string (alternative to mdPath) */
  mdContent?: string;

  // MD → HTML conversion options
  /** Embed local images as base64 data URIs (default: true) */
  embedImages?: boolean;
  /** Keep inline Markdown TOC in the article body (default: false) */
  keepInlineToc?: boolean;
  /** Add interactive JS: scroll progress, active TOC, back-to-top (default: false) */
  withJs?: boolean;
  /** Automatically generate a table of contents with anchor links (default: true) */
  toc?: boolean;
  /** Mermaid diagram rendering: 'auto' renders with the bundled local mermaid.min.js, 'none' skips (default: 'auto') */
  mermaidSource?: 'auto' | 'none';

  // PDF output options
  outputPath?: string;
  format?: 'A4' | 'A3' | 'Letter' | 'Legal' | 'Tabloid';
  landscape?: boolean;
  printBackground?: boolean;
  scale?: number;
  marginTop?: string;
  marginBottom?: string;
  marginLeft?: string;
  marginRight?: string;
  displayHeaderFooter?: boolean;
  headerTemplate?: string;
  footerTemplate?: string;
  waitForNetworkIdle?: boolean;
  timeout?: number;
}

export interface MdConvertStats {
  tables: number;
  images: number;
  embeddedImages: number;
  mermaid: number;
  mermaidSource?: string;
  /** 渲染后移除的紧邻 h1/h2 的 hr 数量（节间 --- 分隔线，防止被分页挤成空白页） */
  removedHrs?: number;
  /** 非致命提示：横版建议、空白页警告等 */
  warnings?: string[];
}

export interface ConvertMdResult {
  success: boolean;
  outputPath?: string;
  htmlOutput?: string;
  error?: string;
  details?: {
    processingTime: number;
    fileSize?: number;
    stats?: MdConvertStats;
    /** 输出 PDF 页数（pdf-lib 探测；失败时缺省） */
    pageCount?: number;
    /** 输出 PDF 首页尺寸（pt） */
    pageSize?: { width: number; height: number };
    /** 完全空白页的 1-based 页码列表（无则不产生警告） */
    blankPages?: number[];
  };
}

// === OCR (local PP-OCRv6, fully offline) ===

export interface OcrOptions {
  /** 本地图片文件路径（PNG/JPEG；四选一，图片优先于 PDF） */
  imagePath?: string;
  /** 网络图片 URL（PNG/JPEG） */
  imageUrl?: string;
  /** Base64 编码图片数据（PNG/JPEG；支持 data URI） */
  imageBase64?: string;
  /** 本地 PDF 文件路径 */
  pdfPath?: string;
  /** PDF 页码范围，如 "1-5,10"（仅 pdfPath 时有效，默认全部；1-indexed） */
  targetPages?: string;
  /** OCR 渲染分辨率 DPI（默认 150） */
  dpi?: number;
}

/** 单页识别结果（页码 1-indexed）。 */
export interface OcrPageResult {
  page: number;
  text: string;
  /** 内容来源：Native=原生文本层，Ocr=本地 OCR，Fused=融合。 */
  source: 'Native' | 'Ocr' | 'Fused';
  /** OCR 置信度（0-1），仅 Ocr/Fused 页存在。 */
  ocrConfidence?: number;
  warnings: string[];
  /** OCR 后仍空/低置信/疑似不完整。 */
  hostedRecommended: boolean;
}

export interface OcrResult {
  success: boolean;
  /** 全部页文本（多页时带 [Page N] 分隔）。 */
  text?: string;
  pages?: OcrPageResult[];
  pageCount?: number;
  error?: string;
  details?: { processingTime: number };
}

// === PDF Text Extraction ===

export type PdfOutputFormat = 'text' | 'json' | 'markdown';

export interface PdfExtractOptions {
  /** 本地 PDF 文件路径（必选） */
  pdfPath: string;
  /** 输出格式：text / json / markdown（默认 text） */
  outputFormat?: PdfOutputFormat;
  /** 页码范围，如 "1-5,10,15-20" */
  targetPages?: string;
  /** 最大解析页数（默认 1000） */
  maxPages?: number;
  /** 加密 PDF 密码（可选） */
  password?: string;
  /**
   * 扫描页本地 OCR（PP-OCRv6 Small，离线小模型）：off 不 OCR（默认，仅标记）；
   * auto 仅对质量信号判定需要 OCR 的页本地 OCR；force 对所有选中页强制 OCR。
   * OCR 运行时缺失时自动回退为不 OCR 并附 warning。
   */
  ocr?: 'off' | 'auto' | 'force';
}

export interface PdfExtractResult {
  success: boolean;
  text?: string;
  pageCount?: number;
  error?: string;
  details?: { processingTime: number };
}

// === PDF Screenshot (LiteParse) ===

export interface PdfScreenshotOptions {
  /** 本地 PDF 文件路径（必选） */
  pdfPath: string;
  /** 页码范围，如 "1,3,5"（可选，默认全部） */
  targetPages?: string;
  /** 渲染 DPI（默认 150） */
  dpi?: number;
  /** 截图输出目录（默认当前目录） */
  outputDir?: string;
  /** 加密 PDF 密码（可选） */
  password?: string;
}

export interface PdfScreenshotPage {
  pageNum: number;
  width: number;
  height: number;
  outputPath: string;
}

export interface PdfScreenshotResult {
  success: boolean;
  screenshots?: PdfScreenshotPage[];
  error?: string;
  details?: { processingTime: number };
}

// === PPT Generation (ppt-master) ===

export type PptCanvasFormat =
  | 'ppt169'
  | 'ppt43'
  | 'wechat'
  | 'xiaohongshu'
  | 'moments'
  | 'story'
  | 'banner'
  | 'a4';

export interface GeneratePresentationOptions {
  /** Existing project directory with svg_output/ (export mode) */
  projectDir?: string;
  /** Raw Markdown content (prepare mode) */
  markdownContent?: string;
  /** Path to a Markdown file (prepare mode) */
  markdownPath?: string;
  /** URL to fetch as a source (prepare mode) */
  sourceUrl?: string;
  /** Path to a source file (pdf/docx/xlsx/pptx/html/etc.) (prepare mode) */
  sourceFile?: string;
  /** Project name when creating a new project (prepare mode) */
  projectName?: string;
  /** Base directory for the new project (prepare mode, default: process.cwd()) */
  outputDir?: string;
  /** Canvas format for a new project (default: ppt169) */
  canvasFormat?: PptCanvasFormat;
  /** Explicit output PPTX path (export mode) */
  outputPath?: string;
  /** SVG source directory: 'output' (default) or 'final' (export mode) */
  svgSource?: 'output' | 'final';
  /** Page transition effect, e.g. 'fade' */
  transition?: string;
  /** Per-element entrance animation, e.g. 'auto' */
  animation?: string;
  /** Per-call timeout in milliseconds (default: 120000) */
  timeout?: number;
}

export interface GeneratePresentationResult {
  success: boolean;
  /** Set when a new project was prepared */
  projectDir?: string;
  /** Set when a PPTX was exported */
  outputPath?: string;
  /** Human-readable status message */
  message?: string;
  error?: string;
  details?: {
    processingTime: number;
    exported?: boolean;
    svgCount?: number;
  };
}

// === Source to Markdown ===

export type MarkdownSourceType = 'auto' | 'pdf' | 'doc' | 'excel' | 'ppt' | 'web';

export interface ConvertToMarkdownOptions {
  /** Source file path or URL */
  source: string;
  /** Source type; 'auto' detects from extension/URL */
  sourceType?: MarkdownSourceType;
  /** Output Markdown file path (default: auto-generated) */
  outputPath?: string;
  /** Maximum rows per sheet for Excel (default: 0 = no limit) */
  maxRows?: number;
  /** Maximum columns per sheet for Excel (default: 0 = no limit) */
  maxCols?: number;
  /** PDF image extraction mode: 'all' | 'filtered' | 'none' (default: filtered) */
  pdfImages?: 'all' | 'filtered' | 'none';
  /**
   * PDF scanned-page handling with local PP-OCRv6 Small (offline small model):
   * 'auto' (default) OCRs only pages flagged by quality signals, 'force'
   * OCRs every page, 'off' native extraction only (scanned pages stay flagged).
   */
  pdfOcr?: 'off' | 'auto' | 'force';
  /** Render PDF vector figures as PNG assets (default: false) */
  renderVectorFigures?: boolean;
  /** DPI for rendered PDF vector figures (default: 150) */
  vectorFigureDpi?: number;
  /** Per-call timeout in milliseconds (default: 120000) */
  timeout?: number;
}

export interface ConvertToMarkdownResult {
  success: boolean;
  markdownPath?: string;
  /** Companion asset directory, if any */
  assetsDir?: string;
  error?: string;
  details?: {
    processingTime: number;
    sourceType: string;
    assetCount?: number;
  };
}

/**
 * Paper format dimensions in CSS pixels (96 DPI), shared by the Markdown →
 * HTML and HTML → PDF/image renderers so viewport scaling stays in sync.
 */
export const PAPER_FORMAT_DIMENSIONS: Record<string, { width: number; height: number }> = {
  A4: { width: 794, height: 1123 },
  A3: { width: 1123, height: 1587 },
  Letter: { width: 816, height: 1055 },
  Legal: { width: 816, height: 1346 },
  Tabloid: { width: 1055, height: 1633 },
};
