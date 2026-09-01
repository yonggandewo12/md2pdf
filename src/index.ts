#!/usr/bin/env node

import { promises as fs, readFileSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { PdfConverter } from './pdf-converter.js';
import { MdConverter } from './md-converter.js';
import { ConvertOptions, MdToPdfOptions, ConvertImageOptions, OcrOptions, PdfExtractOptions, PdfScreenshotOptions, GeneratePresentationOptions, GenerateImageOptions, ConvertToMarkdownOptions } from './types.js';
import { OcrService } from './ocr-service.js';
import { PdfExtractor } from './pdf-extractor.js';
import { extractPdf } from './pdf-extract-adapter.js';
import { PptMasterService } from './ppt-master-service.js';
import { ExcelService } from './excel-service.js';
import { EXCEL_TOOLS, EXCEL_ACTION_MAP } from './excel-tools.js';
import { DOCX_TOOLS, DOCX_ACTION_MAP } from './docx-tools.js';
import { getDocxService } from './docx-service.js';
import { pdfPostProcessor } from './pdf-postprocess.js';
import { PDF_TOOLS, PDF_ACTION_MAP } from './pdf-tools.js';
import { PdfService } from './pdf-service.js';
import { mergePdfs, splitPdf, extractPages, compressPdf } from './pdf-ops.js';
import { PPT_TOOLS, PPT_ACTION_MAP } from './ppt-tools.js';
import { PptService } from './ppt-service.js';
import { IMAGE_TOOLS, IMAGE_ACTION_MAP } from './image-tools.js';
import { ImageService } from './image-service.js';

/**
 * Read the package version once at startup so the MCP server advertises the
 * real release instead of a stale hardcoded literal. Falls back gracefully.
 */
function readPackageVersion(): string {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(dir, '..', 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf-8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const converter = new PdfConverter();
const mdConverter = new MdConverter();
const ocrService = new OcrService();
const pdfExtractor = new PdfExtractor();

// PptMasterService / ExcelService construct their PythonScriptRunner
// eagerly, which probes the interpreter synchronously and throws when no
// Python 3.10+ is available (e.g. a fresh machine before the runtime
// sub-package installs, or --omit=optional). Lazy-create them so the MCP
// server can still start and list tools; the failure surfaces only when a
// Python-backed tool is actually invoked.
let pptService: PptMasterService | null = null;
function getPptService(): PptMasterService {
  return (pptService ??= new PptMasterService());
}
let excelSvc: ExcelService | null = null;
function getExcelService(): ExcelService {
  return (excelSvc ??= new ExcelService());
}
let pdfSvc: PdfService | null = null;
function getPdfService(): PdfService {
  return (pdfSvc ??= new PdfService());
}
let pptEditSvc: PptService | null = null;
function getPptEditService(): PptService {
  return (pptEditSvc ??= new PptService());
}
let imageSvc: ImageService | null = null;
function getImageService(): ImageService {
  return (imageSvc ??= new ImageService());
}

const CONVERT_HTML_TO_PDF_TOOL: Tool = {
  name: 'convert_html_to_pdf',
  description: 'Convert HTML file or HTML content to PDF with browser rendering. Supports CSS, JavaScript, and external resources.',
  inputSchema: {
    type: 'object',
    properties: {
      htmlPath: {
        type: 'string',
        description: 'Path to HTML file to convert (absolute or relative to current working directory)'
      },
      htmlContent: {
        type: 'string',
        description: 'HTML content string to convert (alternative to htmlPath)'
      },
      outputPath: {
        type: 'string',
        description: 'Output PDF file path (default: auto-generated with timestamp in current directory)'
      },
      format: {
        type: 'string',
        enum: ['A4', 'A3', 'Letter', 'Legal', 'Tabloid'],
        description: 'Paper format (default: A4)'
      },
      landscape: {
        type: 'boolean',
        description: 'Use landscape orientation (default: false)'
      },
      printBackground: {
        type: 'boolean',
        description: 'Print background graphics (default: true)'
      },
      scale: {
        type: 'number',
        description: 'Scale of the webpage rendering (default: 1, range: 0.1 to 2)'
      },
      marginTop: {
        type: 'string',
        description: 'Top margin (default: 10mm, accepts px, cm, in, mm)'
      },
      marginBottom: {
        type: 'string',
        description: 'Bottom margin (default: 10mm)'
      },
      marginLeft: {
        type: 'string',
        description: 'Left margin (default: 10mm)'
      },
      marginRight: {
        type: 'string',
        description: 'Right margin (default: 10mm)'
      },
      displayHeaderFooter: {
        type: 'boolean',
        description: 'Display header and footer (default: false)'
      },
      headerTemplate: {
        type: 'string',
        description: 'HTML template for header'
      },
      footerTemplate: {
        type: 'string',
        description: 'HTML template for footer'
      },
      waitForNetworkIdle: {
        type: 'boolean',
        description: 'Wait for network to be idle before generating PDF (default: false)'
      },
      timeout: {
        type: 'number',
        description: 'Maximum time to wait for page load in milliseconds (default: 30000)'
      }
    }
  }
};

const CONVERT_HTML_TO_IMAGE_TOOL: Tool = {
  name: 'convert_html_to_image',
  description: 'Convert HTML file or HTML content to an image (PNG/JPEG) with browser rendering. Supports full-page or viewport screenshots.',
  inputSchema: {
    type: 'object',
    properties: {
      htmlPath: {
        type: 'string',
        description: 'Path to HTML file to convert (absolute or relative to current working directory)'
      },
      htmlContent: {
        type: 'string',
        description: 'HTML content string to convert (alternative to htmlPath)'
      },
      outputPath: {
        type: 'string',
        description: 'Output image file path (default: auto-generated with timestamp in current directory)'
      },
      imageFormat: {
        type: 'string',
        enum: ['png', 'jpeg'],
        description: 'Output image format (default: png)'
      },
      quality: {
        type: 'number',
        description: 'JPEG quality (default: 90, range: 0-100)'
      },
      fullPage: {
        type: 'boolean',
        description: 'Capture full page height (default: false, captures only viewport)'
      },
      imageScale: {
        type: 'number',
        description: 'Screenshot scale / device scale factor (default: 1, range: 0.1 to 2)'
      },
      waitForNetworkIdle: {
        type: 'boolean',
        description: 'Wait for network to be idle before capturing (default: false)'
      },
      waitForMermaid: {
        type: 'boolean',
        description: 'Wait for Mermaid diagrams to finish rendering (default: false)'
      },
      timeout: {
        type: 'number',
        description: 'Maximum time to wait for page load in milliseconds (default: 30000)'
      }
    }
  }
};

const CONVERT_MD_TO_HTML_TOOL: Tool = {
  name: 'convert_md_to_html',
  description: 'Convert Markdown file or Markdown content to a standalone, professionally styled HTML report. Features include responsive tables, Mermaid diagram rendering, and local image embedding. The HTML is fully self-contained (no external dependencies).',
  inputSchema: {
    type: 'object',
    properties: {
      mdPath: {
        type: 'string',
        description: 'Path to Markdown file to convert (absolute or relative to current working directory)'
      },
      mdContent: {
        type: 'string',
        description: 'Markdown content string to convert (alternative to mdPath)'
      },
      outputPath: {
        type: 'string',
        description: 'Output HTML file path (default: auto-generated with timestamp in current directory)'
      },
      embedImages: {
        type: 'boolean',
        description: 'Embed local images as base64 data URIs (default: true)'
      },
      keepInlineToc: {
        type: 'boolean',
        description: 'Keep existing Markdown inline TOC in the article body (default: false, removes it during conversion)'
      },
      withJs: {
        type: 'boolean',
        description: 'Add interactive JS for scroll progress and back-to-top button (default: false)'
      },
      toc: {
        type: 'boolean',
        description: 'Automatically generate a table of contents with anchor links (default: true)'
      },
      mermaidSource: {
        type: 'string',
        enum: ['auto', 'cdn', 'local', 'none'],
        description: 'Source for Mermaid diagram rendering. "auto": CDN if needed, "cdn": always CDN, "local": local mermaid.min.js, "none": skip Mermaid (default: auto)'
      }
    }
  }
};

const CONVERT_MD_TO_PDF_TOOL: Tool = {
  name: 'convert_md_to_pdf',
  description: 'Convert Markdown file or Markdown content to PDF. Renders Markdown to a professionally styled HTML report (with responsive tables, Mermaid diagrams, image embedding) then converts to PDF via browser rendering. The response self-checks the output PDF (pageCount, pageSize, blankPages) and stats.warnings may suggest landscape: true when most embedded images are wide.',
  inputSchema: {
    type: 'object',
    properties: {
      mdPath: {
        type: 'string',
        description: 'Path to Markdown file to convert (absolute or relative to current working directory)'
      },
      mdContent: {
        type: 'string',
        description: 'Markdown content string to convert (alternative to mdPath)'
      },
      outputPath: {
        type: 'string',
        description: 'Output PDF file path (default: auto-generated with timestamp in current directory)'
      },
      embedImages: {
        type: 'boolean',
        description: 'Embed local images as base64 data URIs (default: true)'
      },
      keepInlineToc: {
        type: 'boolean',
        description: 'Keep existing Markdown inline TOC in the article body (default: false, removes it during conversion)'
      },
      withJs: {
        type: 'boolean',
        description: 'Add interactive JS for scroll progress and back-to-top button (default: false)'
      },
      toc: {
        type: 'boolean',
        description: 'Automatically generate a table of contents with anchor links (default: true)'
      },
      mermaidSource: {
        type: 'string',
        enum: ['auto', 'cdn', 'local', 'none'],
        description: 'Source for Mermaid diagram rendering. "auto": CDN if needed, "cdn": always CDN, "local": local mermaid.min.js, "none": skip Mermaid (default: auto)'
      },
      format: {
        type: 'string',
        enum: ['A4', 'A3', 'Letter', 'Legal', 'Tabloid'],
        description: 'Paper format (default: A4)'
      },
      landscape: {
        type: 'boolean',
        description: 'Use landscape orientation (default: false). Landscape-oriented images are squeezed in portrait mode; when most embedded images are wide, the result includes a suggestion to retry with landscape: true'
      },
      printBackground: {
        type: 'boolean',
        description: 'Print background graphics (default: true)'
      },
      scale: {
        type: 'number',
        description: 'Scale of the webpage rendering (default: 1, range: 0.1 to 2)'
      },
      marginTop: {
        type: 'string',
        description: 'Top margin (default: 10mm, accepts px, cm, in, mm)'
      },
      marginBottom: {
        type: 'string',
        description: 'Bottom margin (default: 10mm)'
      },
      marginLeft: {
        type: 'string',
        description: 'Left margin (default: 10mm)'
      },
      marginRight: {
        type: 'string',
        description: 'Right margin (default: 10mm)'
      },
      displayHeaderFooter: {
        type: 'boolean',
        description: 'Display header and footer (default: false)'
      },
      headerTemplate: {
        type: 'string',
        description: 'HTML template for header'
      },
      footerTemplate: {
        type: 'string',
        description: 'HTML template for footer'
      },
      waitForNetworkIdle: {
        type: 'boolean',
        description: 'Wait for network to be idle before generating PDF (default: false)'
      },
      timeout: {
        type: 'number',
        description: 'Maximum time to wait for page load in milliseconds (default: 30000)'
      }
    }
  }
};

const RECOGNIZE_TEXT_TOOL: Tool = {
  name: 'recognize_text',
  description: 'Extract text from images or PDF files using Baidu OCR API (supports Chinese and English)',
  inputSchema: {
    type: 'object',
    properties: {
      apiKey: {
        type: 'string',
        description: 'Baidu Cloud API Key (optional if BAIDU_OCR_API_KEY env var is set)'
      },
      secretKey: {
        type: 'string',
        description: 'Baidu Cloud Secret Key (optional if BAIDU_OCR_SECRET_KEY env var is set)'
      },
      imagePath: {
        type: 'string',
        description: 'Local image file path (one of imagePath, imageUrl, imageBase64, pdfPath)'
      },
      imageUrl: {
        type: 'string',
        description: 'Image URL (one of imagePath, imageUrl, imageBase64, pdfPath)'
      },
      imageBase64: {
        type: 'string',
        description: 'Base64 encoded image data (one of imagePath, imageUrl, imageBase64, pdfPath)'
      },
      pdfPath: {
        type: 'string',
        description: 'Local PDF file path (one of imagePath, imageUrl, imageBase64, pdfPath, ofdPath). Priority: image > url > pdf_file > ofd_file'
      },
      pdfFileNum: {
        type: 'number',
        description: 'PDF page number to recognize, starting from 1 (default: 1, only effective with pdfPath)'
      },
      ofdPath: {
        type: 'string',
        description: 'Local OFD file path (one of imagePath, imageUrl, imageBase64, pdfPath, ofdPath). Priority: image > url > pdf_file > ofd_file'
      },
      ofdFileNum: {
        type: 'number',
        description: 'OFD page number to recognize, starting from 1 (default: 1, only effective with ofdPath)'
      },
      languageType: {
        type: 'string',
        enum: ['auto_detect', 'CHN_ENG', 'ENG', 'JAP', 'KOR', 'FRE', 'SPA', 'POR', 'GER', 'ITA', 'RUS', 'DAN', 'DUT', 'MAL', 'SWE', 'IND', 'POL', 'ROM', 'TUR', 'GRE', 'HUN', 'THA', 'VIE', 'ARA', 'HIN'],
        description: 'Language type for recognition (default: CHN_ENG)'
      },
      detectLanguage: {
        type: 'boolean',
        description: 'Detect language in the image (default: true)'
      },
      detectDirection: {
        type: 'boolean',
        description: 'Detect image orientation (default: false)'
      },
      paragraph: {
        type: 'boolean',
        description: 'Output paragraph information (default: false)'
      },
      probability: {
        type: 'boolean',
        description: 'Return confidence scores per line (default: true)'
      },
      multidirectionalRecognize: {
        type: 'boolean',
        description: 'Enable line-level multi-direction text recognition (default: false, set true when image has text in different directions)'
      }
    }
  }
};

const EXTRACT_PDF_TEXT_TOOL: Tool = {
  name: 'extract_pdf_text',
  description: 'Extract text, JSON, or Markdown from PDF files using layout-aware engine. Detects headings, tables, lists, and reading order. Scanned pages are flagged.',
  inputSchema: {
    type: 'object',
    properties: {
      pdfPath: {
        type: 'string',
        description: 'Path to the local PDF file (required)'
      },
      outputFormat: {
        type: 'string',
        enum: ['text', 'json', 'markdown'],
        description: 'Output format (default: text). "markdown" includes headings, tables, lists, and reading order.'
      },
      targetPages: {
        type: 'string',
        description: 'Pages to extract, e.g. "1-5,10,15-20" (default: all pages)'
      },
      maxPages: {
        type: 'number',
        description: 'Maximum number of pages to parse (default: 1000)'
      },
      password: {
        type: 'string',
        description: 'Password for encrypted PDF documents'
      }
    },
    required: ['pdfPath']
  }
};

const SCREENSHOT_PDF_TOOL: Tool = {
  name: 'screenshot_pdf',
  description: 'Generate page screenshots (PNG) from PDF files using LiteParse. Useful for LLM agents to extract visual information that text alone cannot capture.',
  inputSchema: {
    type: 'object',
    properties: {
      pdfPath: {
        type: 'string',
        description: 'Path to the local PDF file (required)'
      },
      targetPages: {
        type: 'string',
        description: 'Pages to screenshot, e.g. "1,3,5" or "1-5" (default: all pages)'
      },
      dpi: {
        type: 'number',
        description: 'Rendering DPI (default: 150)'
      },
      outputDir: {
        type: 'string',
        description: 'Output directory for screenshot files (default: current directory)'
      },
      password: {
        type: 'string',
        description: 'Password for encrypted PDF documents'
      }
    },
    required: ['pdfPath']
  }
};

const GENERATE_PRESENTATION_TOOL: Tool = {
  name: 'generate_presentation',
  description: 'Prepare a ppt-master project from Markdown/source material, or export an existing project to PPTX. NOTE: AI-driven SVG generation is not performed by this tool; populate svg_output/ first via the ppt-master SKILL.md workflow, then call this tool with projectDir to export.',
  inputSchema: {
    type: 'object',
    properties: {
      projectDir: {
        type: 'string',
        description: 'Existing project directory with svg_output/ (export mode)'
      },
      markdownContent: {
        type: 'string',
        description: 'Raw Markdown content (prepare mode)'
      },
      markdownPath: {
        type: 'string',
        description: 'Path to a Markdown file (prepare mode)'
      },
      sourceUrl: {
        type: 'string',
        description: 'URL to import as source (prepare mode)'
      },
      sourceFile: {
        type: 'string',
        description: 'Path to a source file: pdf/docx/xlsx/pptx/etc. (prepare mode)'
      },
      projectName: {
        type: 'string',
        description: 'Name for a newly created project'
      },
      outputDir: {
        type: 'string',
        description: 'Base directory for the new project (default: cwd)'
      },
      canvasFormat: {
        type: 'string',
        enum: ['ppt169', 'ppt43', 'wechat', 'xiaohongshu', 'moments', 'story', 'banner', 'a4'],
        description: 'Canvas format for new project (default: ppt169)'
      },
      outputPath: {
        type: 'string',
        description: 'Explicit PPTX output path (export mode)'
      },
      svgSource: {
        type: 'string',
        enum: ['output', 'final'],
        description: 'SVG source directory for export (default: output)'
      },
      transition: {
        type: 'string',
        description: 'Slide transition effect, e.g. fade'
      },
      animation: {
        type: 'string',
        description: 'Per-element animation effect, e.g. auto'
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 120000)'
      }
    }
  }
};

const GENERATE_IMAGE_TOOL: Tool = {
  name: 'generate_image',
  description: 'Generate an image using an AI image backend configured via environment variables (IMAGE_BACKEND, GEMINI_API_KEY, OPENAI_API_KEY, etc.). Supports 18+ backends including OpenAI, Gemini, Qwen, Zhipu, Volcengine, Agnes AI, Stability, and more.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Image generation prompt'
      },
      aspectRatio: {
        type: 'string',
        description: 'Aspect ratio (default: 16:9)'
      },
      imageSize: {
        type: 'string',
        description: 'Image size: 512px, 1K, 2K, 4K (default: 1K)'
      },
      backend: {
        type: 'string',
        description: 'Backend override, e.g. openai, gemini, qwen, zhipu, volcengine, agnes'
      },
      outputDir: {
        type: 'string',
        description: 'Output directory (default: cwd)'
      },
      filename: {
        type: 'string',
        description: 'Output filename without extension'
      },
      model: {
        type: 'string',
        description: 'Model override'
      },
      referenceImage: {
        type: 'string',
        description: 'Reference image URL for image-to-image generation (supported by agnes backend)'
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 120000)'
      }
    },
    required: ['prompt']
  }
};

const CONVERT_TO_MARKDOWN_TOOL: Tool = {
  name: 'convert_to_markdown',
  description: 'Convert PDF, Word (docx/doc/odt/rtf/epub), Excel (xlsx/xls/xlsb/ods/csv), PowerPoint (pptx/ppt/odp), or web pages to Markdown. Auto-detects source type from file extension or URL.',
  inputSchema: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: 'Source file path or URL'
      },
      sourceType: {
        type: 'string',
        enum: ['auto', 'pdf', 'doc', 'excel', 'ppt', 'web'],
        description: 'Source type (default: auto-detect from extension/URL)'
      },
      outputPath: {
        type: 'string',
        description: 'Output Markdown file path'
      },
      maxRows: {
        type: 'number',
        description: 'Excel max rows per sheet'
      },
      maxCols: {
        type: 'number',
        description: 'Excel max columns per sheet'
      },
      pdfImages: {
        type: 'string',
        enum: ['all', 'filtered', 'none'],
        description: 'PDF image extraction mode (default: filtered)'
      },
      renderVectorFigures: {
        type: 'boolean',
        description: 'Render PDF vector figures as PNG'
      },
      vectorFigureDpi: {
        type: 'number',
        description: 'DPI for rendered PDF vector figures (default: 150)'
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 120000)'
      }
    },
    required: ['source']
  }
};

class Md2PdfServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'general-tools-mcp-server',
        version: readPackageVersion(),
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    const handleSignal = async () => {
      await converter.cleanup();
      process.exit(0);
    };

    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [CONVERT_HTML_TO_PDF_TOOL, CONVERT_HTML_TO_IMAGE_TOOL, CONVERT_MD_TO_HTML_TOOL, CONVERT_MD_TO_PDF_TOOL, RECOGNIZE_TEXT_TOOL, EXTRACT_PDF_TEXT_TOOL, SCREENSHOT_PDF_TOOL, GENERATE_PRESENTATION_TOOL, GENERATE_IMAGE_TOOL, CONVERT_TO_MARKDOWN_TOOL, ...EXCEL_TOOLS, ...DOCX_TOOLS, ...PDF_TOOLS, ...PPT_TOOLS, ...IMAGE_TOOLS]
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (name === 'convert_html_to_pdf') {
        try {
          const options = args as ConvertOptions;
          const result = await converter.convertToPdf(options);

          if (result.success) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    message: 'PDF generated successfully',
                    outputPath: result.outputPath,
                    processingTime: `${result.details?.processingTime}ms`,
                    fileSize: result.details?.fileSize
                      ? `${(result.details.fileSize / 1024).toFixed(2)} KB`
                      : 'unknown'
                  }, null, 2)
                }
              ]
            };
          } else {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: false,
                    error: result.error,
                    processingTime: `${result.details?.processingTime}ms`
                  }, null, 2)
                }
              ],
              isError: true
            };
          }
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: error instanceof Error ? error.message : String(error)
                }, null, 2)
              }
            ],
            isError: true
          };
        }
      }

      if (name === 'convert_html_to_image') {
        try {
          const options = args as ConvertImageOptions;
          const result = await converter.convertToImage(options);

          if (result.success) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    message: 'Image generated successfully',
                    outputPath: result.outputPath,
                    processingTime: `${result.details?.processingTime}ms`,
                    fileSize: result.details?.fileSize
                      ? `${(result.details.fileSize / 1024).toFixed(2)} KB`
                      : 'unknown',
                    dimensions: result.details?.width && result.details?.height
                      ? `${result.details.width} × ${result.details.height}px`
                      : 'unknown'
                  }, null, 2)
                }
              ]
            };
          } else {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: false,
                    error: result.error,
                    processingTime: `${result.details?.processingTime}ms`
                  }, null, 2)
                }
              ],
              isError: true
            };
          }
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: error instanceof Error ? error.message : String(error)
                }, null, 2)
              }
            ],
            isError: true
          };
        }
      }

      if (name === 'convert_md_to_html') {
        try {
          const {
            mdPath: mdPathArg,
            mdContent,
            outputPath,
            embedImages,
            keepInlineToc,
            withJs,
            toc,
            mermaidSource,
          } = args as Record<string, unknown>;

          if (!mdPathArg && !mdContent) {
            throw new Error('Either mdPath or mdContent must be provided');
          }

          let mdText: string;
          let baseDir: string | undefined;

          if (mdPathArg) {
            const mdFilePath = path.resolve(mdPathArg as string);
            await fs.access(mdFilePath);
            mdText = await fs.readFile(mdFilePath, 'utf-8');
            baseDir = path.dirname(mdFilePath);
          } else {
            mdText = mdContent as string;
            baseDir = undefined;
          }

          const { html, stats } = await mdConverter.convertMdToHtml(mdText, {
            embedImages: embedImages as boolean | undefined,
            keepInlineToc: keepInlineToc as boolean | undefined,
            withJs: withJs as boolean | undefined,
            toc: toc as boolean | undefined,
            mermaidSource: mermaidSource as 'auto' | 'cdn' | 'local' | 'none' | undefined,
          }, baseDir);

          // Determine output path
          let htmlOutputPath = outputPath as string | undefined;
          if (!htmlOutputPath) {
            if (mdPathArg) {
              const parsed = path.parse(mdPathArg as string);
              htmlOutputPath = path.join(parsed.dir, `${parsed.name}.html`);
            } else {
              const timestamp = Date.now();
              htmlOutputPath = `md-report-${timestamp}.html`;
            }
          }
          htmlOutputPath = path.resolve(htmlOutputPath);

          await fs.writeFile(htmlOutputPath, html, 'utf-8');

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Markdown converted to HTML successfully',
                  outputPath: htmlOutputPath,
                  stats,
                }, null, 2)
              }
            ]
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: error instanceof Error ? error.message : String(error)
                }, null, 2)
              }
            ],
            isError: true
          };
        }
      }

      if (name === 'convert_md_to_pdf') {
        try {
          const options = args as MdToPdfOptions;
          const result = await mdConverter.convertMdToPdf(options, converter);

          if (result.success) {
            const response: Record<string, unknown> = {
              success: true,
              message: 'Markdown converted to PDF successfully',
              outputPath: result.outputPath,
              processingTime: `${result.details?.processingTime}ms`,
              fileSize: result.details?.fileSize
                ? `${(result.details.fileSize / 1024).toFixed(2)} KB`
                : 'unknown',
            };
            if (result.details?.stats) {
              response.stats = result.details.stats;
            }
            if (result.details?.pageCount !== undefined) {
              response.pageCount = result.details.pageCount;
            }
            if (result.details?.pageSize) {
              response.pageSize = `${result.details.pageSize.width}x${result.details.pageSize.height}pt`;
            }
            if (result.details?.blankPages && result.details.blankPages.length > 0) {
              response.blankPages = result.details.blankPages;
            }
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(response, null, 2)
                }
              ]
            };
          } else {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: false,
                    error: result.error,
                    processingTime: `${result.details?.processingTime}ms`
                  }, null, 2)
                }
              ],
              isError: true
            };
          }
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: error instanceof Error ? error.message : String(error)
                }, null, 2)
              }
            ],
            isError: true
          };
        }
      }

      if (name === 'recognize_text') {
        try {
          const options = args as unknown as OcrOptions;
          const result = await ocrService.recognize(options);

          if (result.success) {
            const response: Record<string, unknown> = {
              success: true,
              text: result.text,
              wordsResultNum: result.wordsResultNum,
              processingTime: `${result.details?.processingTime}ms`,
            };
            if (result.language) {
              response.language = result.language;
            }
            if (result.direction !== undefined) {
              response.direction = result.direction;
            }
            if (result.wordsResult && result.wordsResult.length > 0) {
              response.wordsResult = result.wordsResult;
            }
            if (result.apiUsed) {
              response.apiUsed = result.apiUsed;
            }
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(response, null, 2)
                }
              ]
            };
          } else {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: false,
                    error: result.error,
                    processingTime: `${result.details?.processingTime}ms`
                  }, null, 2)
                }
              ],
              isError: true
            };
          }
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: error instanceof Error ? error.message : String(error)
                }, null, 2)
              }
            ],
            isError: true
          };
        }
      }

      if (name === 'extract_pdf_text') {
        try {
          const options = args as unknown as PdfExtractOptions;
          const result = await extractPdf(options);

          if (result.success) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    text: result.text,
                    pageCount: result.pageCount,
                    processingTime: `${result.details?.processingTime}ms`,
                  }, null, 2)
                }
              ]
            };
          } else {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: false,
                    error: result.error,
                    processingTime: `${result.details?.processingTime}ms`
                  }, null, 2)
                }
              ],
              isError: true
            };
          }
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: error instanceof Error ? error.message : String(error)
                }, null, 2)
              }
            ],
            isError: true
          };
        }
      }

      if (name === 'screenshot_pdf') {
        try {
          const options = args as unknown as PdfScreenshotOptions;
          const result = await pdfExtractor.screenshot(options);

          if (result.success) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    screenshots: result.screenshots,
                    processingTime: `${result.details?.processingTime}ms`,
                  }, null, 2)
                }
              ]
            };
          } else {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: false,
                    error: result.error,
                    processingTime: `${result.details?.processingTime}ms`
                  }, null, 2)
                }
              ],
              isError: true
            };
          }
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: error instanceof Error ? error.message : String(error)
                }, null, 2)
              }
            ],
            isError: true
          };
        }
      }

      if (name === 'generate_presentation') {
        try {
          const options = args as GeneratePresentationOptions;
          const result = await getPptService().generatePresentation(options);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            isError: !result.success,
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }, null, 2) }],
            isError: true,
          };
        }
      }

      if (name === 'generate_image') {
        try {
          const options = args as unknown as GenerateImageOptions;
          const result = await getPptService().generateImage(options);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            isError: !result.success,
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }, null, 2) }],
            isError: true,
          };
        }
      }

      if (name === 'convert_to_markdown') {
        try {
          const options = args as unknown as ConvertToMarkdownOptions;
          const result = await getPptService().convertToMarkdown(options);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            isError: !result.success,
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }, null, 2) }],
            isError: true,
          };
        }
      }

      const excelAction = EXCEL_ACTION_MAP[name];
      if (excelAction) {
        try {
          const result = await getExcelService().call(excelAction, (args as Record<string, unknown>) ?? {});
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            isError: !result.success,
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }, null, 2) }],
            isError: true,
          };
        }
      }

      const docxAction = DOCX_ACTION_MAP[name];
      if (docxAction) {
        try {
          const argsObj = (args as Record<string, unknown>) ?? {};
          let result: unknown;
          if (docxAction.startsWith('edit:')) {
            // python-docx 子进程编辑已有文档
            result = await getDocxService().editDocument(docxAction.slice(5), argsObj);
          } else if (docxAction.startsWith('pdf:')) {
            // pdf-lib 水印/二维码（纯 JS）
            const method = docxAction.slice(4) as 'add_watermark' | 'add_qrcode';
            if (method === 'add_watermark') {
              result = await pdfPostProcessor.addWatermark(argsObj.pdfPath as string, argsObj);
            } else {
              result = await pdfPostProcessor.addQrCode(argsObj.pdfPath as string, argsObj.qrCodePath as string, argsObj);
            }
          } else {
            // 纯 JS docx 生成
            const svc = getDocxService();
            switch (docxAction) {
              case 'create_document':
                result = await svc.createDocument(argsObj.content as string, argsObj.outputPath as string | undefined, { title: argsObj.title as string | undefined });
                break;
              case 'convert_md_to_docx': {
                const mdPathArg = argsObj.mdPath as string | undefined;
                const mdContentArg = argsObj.mdContent as string | undefined;
                if (!mdPathArg && !mdContentArg) {
                  throw new Error('Either mdPath or mdContent must be provided');
                }
                let mdText: string;
                let baseDir: string | undefined;
                if (mdPathArg) {
                  const mdFilePath = path.resolve(mdPathArg);
                  await fs.access(mdFilePath);
                  mdText = await fs.readFile(mdFilePath, 'utf-8');
                  baseDir = path.dirname(mdFilePath);
                } else {
                  mdText = mdContentArg as string;
                  baseDir = undefined;
                }
                let docxOutputPath = argsObj.outputPath as string | undefined;
                if (!docxOutputPath && mdPathArg) {
                  const parsed = path.parse(mdPathArg);
                  docxOutputPath = path.join(parsed.dir, `${parsed.name}.docx`);
                }
                result = await svc.convertMdToDocx(
                  mdText,
                  baseDir,
                  docxOutputPath,
                  {
                    title: argsObj.title as string | undefined,
                    embedImages: argsObj.embedImages as boolean | undefined,
                  },
                  // 有 mermaid 时用共享浏览器渲染为图片；失败由 DocxService 降级
                  (html: string) => converter.renderMermaidBlocks(html),
                );
                break;
              }
              case 'convert_html_to_docx':
                result = await svc.convertHtmlToDocx(argsObj.htmlContent as string, argsObj.outputPath as string | undefined);
                break;
              default:
                throw new Error(`Unknown docx action: ${docxAction}`);
            }
          }
          const ok = (result as { success?: boolean } | undefined)?.success !== false;
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            isError: !ok,
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }, null, 2) }],
            isError: true,
          };
        }
      }

      const pdfAction = PDF_ACTION_MAP[name];
      if (pdfAction) {
        try {
          const argsObj = (args as Record<string, unknown>) ?? {};
          let result: unknown;
          if (pdfAction === 'encrypt' || pdfAction === 'decrypt') {
            // PyMuPDF 子进程加密/解密
            result = await getPdfService().call(pdfAction, argsObj);
          } else {
            // 纯 JS pdf-lib 操作
            switch (pdfAction) {
              case 'merge':
                result = await mergePdfs(argsObj.pdfPaths as string[], argsObj.outputPath as string);
                break;
              case 'split':
                result = await splitPdf(argsObj.pdfPath as string, argsObj.pageRanges as string, argsObj.outputDir as string | undefined, argsObj.outputNamePrefix as string | undefined);
                break;
              case 'extract':
                result = await extractPages(argsObj.pdfPath as string, argsObj.pageRanges as string, argsObj.outputPath as string);
                break;
              case 'compress':
                result = await compressPdf(argsObj.pdfPath as string, argsObj.outputPath as string | undefined, (argsObj.useObjectStreams as boolean | undefined) ?? true);
                break;
              default:
                throw new Error(`Unknown pdf action: ${pdfAction}`);
            }
          }
          const ok = result != null && (result as { success?: boolean }).success === true;
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            isError: !ok,
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }) }],
            isError: true,
          };
        }
      }

      const pptAction = PPT_ACTION_MAP[name];
      if (pptAction) {
        try {
          const result = await getPptEditService().call(pptAction, (args as Record<string, unknown>) ?? {});
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            isError: !result.success,
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }) }],
            isError: true,
          };
        }
      }

      const imageAction = IMAGE_ACTION_MAP[name];
      if (imageAction) {
        try {
          const result = await getImageService().call(imageAction, (args as Record<string, unknown>) ?? {});
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            isError: !result.success,
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }) }],
            isError: true,
          };
        }
      }

      throw new Error(`Unknown tool: ${name}`);
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('General Tools MCP Server running on stdio');

    // Exit when parent closes stdin (EOF), so the process doesn't hang
    process.stdin.on('end', async () => {
      await converter.cleanup();
      process.exit(0);
    });
    process.stdin.resume(); // Ensure stdin stays open so we can detect EOF
  }
}

const server = new Md2PdfServer();
server.run().catch(console.error);
