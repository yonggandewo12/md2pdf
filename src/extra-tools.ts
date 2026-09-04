/**
 * 补充工具定义（MCP schema）：PDF 表单填充、ePub 生成、二维码生成、归档压缩/解压。
 * 与各 extra service 一一对应，dispatch 在 index.ts 中按 name 分发。
 *
 * @author Liang.Xu
 */
import { Tool } from '@modelcontextprotocol/sdk/types.js';

export const EXTRA_TOOLS: Tool[] = [
  {
    name: 'pdf_fill_form',
    description:
      'List or fill PDF form fields (AcroForm). Without `fields`, lists all fields (name/type/current value/options). With `fields`, validates field names then fills text/checkbox/radio/dropdown/optionlist values and writes a new PDF.',
    inputSchema: {
      type: 'object',
      properties: {
        pdfPath: { type: 'string', description: 'Path to the PDF file (absolute or relative to cwd)' },
        outputPath: { type: 'string', description: 'Output PDF file path (required when filling; optional when only listing fields)' },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Form field name' },
              value: {
                description: 'Value to fill: string for text/radio/dropdown, "true"/"false" for checkbox, array of strings for multi-select option list',
                oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
              },
            },
            required: ['name', 'value'],
          },
          description: 'Field values to fill. Omit to only list fields.',
        },
        flatten: { type: 'boolean', description: 'Flatten the form after filling to remove editability (default: false)' },
      },
      required: ['pdfPath'],
    },
  },
  {
    name: 'md_to_epub',
    description:
      'Convert Markdown file or content to an EPUB e-book. Reuses markdown-it for HTML rendering; relative-path images are embedded into the EPUB package (offline). Optionally split into chapters by h1 headings.',
    inputSchema: {
      type: 'object',
      properties: {
        mdPath: { type: 'string', description: 'Path to Markdown file (absolute or relative to cwd)' },
        mdContent: { type: 'string', description: 'Markdown content string (alternative to mdPath)' },
        outputPath: { type: 'string', description: 'Output .epub file path (required)' },
        title: { type: 'string', description: 'Book title (default: first h1 heading)' },
        author: { type: 'string', description: 'Author name' },
        publisher: { type: 'string', description: 'Publisher name' },
        cover: { type: 'string', description: 'Cover image path (absolute)' },
        splitByHeading: { type: 'boolean', description: 'Split into chapters by h1 headings (default: false)' },
        embedImages: { type: 'boolean', description: 'Embed relative-path images into the EPUB package via file:// URLs (default: true)' },
        version: { type: 'number', description: 'EPUB version 2 or 3 (default: 3)', enum: [2, 3] },
      },
      required: ['outputPath'],
    },
  },
  {
    name: 'qrcode_generate',
    description:
      'Generate a QR code image from text (UTF-8, Chinese supported). Outputs PNG/SVG file or a base64 data URL. Complements pdf_add_qrcode (which embeds an existing QR image into a PDF).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Content to encode (required)' },
        outputPath: { type: 'string', description: 'Output file path (.png or .svg; omitted for dataURL)' },
        format: { type: 'string', enum: ['png', 'svg', 'dataURL'], description: 'Output format (default: by output extension, else png)' },
        width: { type: 'number', description: 'QR code width in pixels (default: 300)' },
        errorCorrectionLevel: { type: 'string', enum: ['L', 'M', 'Q', 'H'], description: 'Error correction level (default: M)' },
        margin: { type: 'number', description: 'Quiet zone margin in modules (default: 2)' },
        colorDark: { type: 'string', description: 'Foreground color hex (default: #000000)' },
        colorLight: { type: 'string', description: 'Background color hex (default: #FFFFFF)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'archive_compress',
    description:
      'Compress files or directories into a zip or tar archive. Directories are collected recursively; relative paths are preserved. Pure JS (fflate), no native dependencies.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'File or directory paths to archive (required)' },
        outputPath: { type: 'string', description: 'Output archive path, e.g. out.zip / out.tar (required)' },
        format: { type: 'string', enum: ['zip', 'tar'], description: 'Archive format (default: zip)' },
        level: { type: 'number', description: 'zip compression level 0-9 (default: 6)' },
      },
      required: ['paths', 'outputPath'],
    },
  },
  {
    name: 'archive_extract',
    description:
      'Extract a zip archive into a directory. Path traversal entries (../, absolute paths) are safely discarded.',
    inputSchema: {
      type: 'object',
      properties: {
        archivePath: { type: 'string', description: 'Path to the .zip archive (required)' },
        outputDir: { type: 'string', description: 'Output directory (required)' },
      },
      required: ['archivePath', 'outputDir'],
    },
  },
  {
    name: 'sqlite_query',
    description:
      'Run a SELECT statement against a SQLite database file and return all rows. Use `params` for parameterized binding to avoid SQL injection.',
    inputSchema: {
      type: 'object',
      properties: {
        dbPath: { type: 'string', description: 'Path to the .db/.sqlite file (must exist)' },
        sql: { type: 'string', description: 'SQL SELECT statement' },
        params: { type: 'array', description: 'Positional bind parameters, e.g. ["x", 42]' },
      },
      required: ['dbPath', 'sql'],
    },
  },
  {
    name: 'sqlite_exec',
    description:
      'Run a write statement (INSERT/UPDATE/DELETE/DDL) against a SQLite database file. Returns affected row count and lastInsertRowid.',
    inputSchema: {
      type: 'object',
      properties: {
        dbPath: { type: 'string', description: 'Path to the .db/.sqlite file (must exist)' },
        sql: { type: 'string', description: 'SQL write statement' },
        params: { type: 'array', description: 'Positional bind parameters' },
      },
      required: ['dbPath', 'sql'],
    },
  },
  {
    name: 'sqlite_tables',
    description: 'List all user tables in a SQLite database with their CREATE statements.',
    inputSchema: {
      type: 'object',
      properties: {
        dbPath: { type: 'string', description: 'Path to the .db/.sqlite file (must exist)' },
      },
      required: ['dbPath'],
    },
  },
  {
    name: 'formula_ocr',
    description:
      'Recognize a mathematical formula from an image and return LaTeX code. Fully local ONNX inference (RapidLaTeXOCR / LaTeX-OCR model, ~180MB downloaded once to the user cache on first use, offline afterwards). CPU-only; complex formulas may take tens of seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        imagePath: { type: 'string', description: 'Path to the formula image (PNG/JPEG; either imagePath or imageBase64 required)' },
        imageBase64: { type: 'string', description: 'Base64-encoded image content (alternative to imagePath)' },
        outputPath: { type: 'string', description: 'Optional path to save the recognized LaTeX as a text file' },
      },
    },
  },
];
