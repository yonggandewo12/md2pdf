import { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * DOCX MCP 工具定义与 action 映射。
 *
 * 生成类工具（docx_create_document / docx_convert_md_to_docx /
 * docx_convert_html_to_docx）由纯 JS docx-service 处理；
 * 编辑类工具（docx_edit_document）映射到 scripts/docx/run.py 的 action；
 * PDF 后处理工具（pdf_add_watermark / pdf_add_qrcode）由 pdf-postprocess 处理。
 *
 * DOCX_ACTION_MAP 的值在 index.ts dispatch 时区分走哪条后端：
 *  - 前缀 `edit:` → python-docx 子进程 action
 *  - 其余 → 纯 JS docx-service 方法名
 *  - `pdf:*` → pdf-postprocess 方法名
 */

const docxPathProp = {
  type: 'string',
  description: 'Path to the .docx file (absolute or relative to cwd)',
};

const outputPathProp = {
  type: 'string',
  description: 'Output file path (absolute or relative to cwd; default: auto-generated in cwd)',
};

export const DOCX_ACTION_MAP: Record<string, string> = {
  docx_create_document: 'create_document',
  docx_convert_md_to_docx: 'convert_md_to_docx',
  docx_convert_html_to_docx: 'convert_html_to_docx',
  docx_read_document: 'edit:read_document',
  docx_edit_paragraph: 'edit:edit_paragraph',
  docx_add_paragraph: 'edit:add_paragraph',
  docx_insert_image: 'edit:insert_image',
  docx_insert_table: 'edit:insert_table',
  docx_change_style: 'edit:change_style',
  docx_list_tables: 'edit:list_tables',
  docx_available_styles: 'edit:available_styles',
  pdf_add_watermark: 'pdf:add_watermark',
  pdf_add_qrcode: 'pdf:add_qrcode',
};

export const DOCX_TOOLS: Tool[] = [
  {
    name: 'docx_create_document',
    description: 'Create a .docx Word document from HTML content (or plain text, auto-wrapped). Preserves headings, bold/italic, lists, tables, blockquotes, code blocks.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'HTML content (or plain text — wrapped automatically)' },
        outputPath: outputPathProp,
        title: { type: 'string', description: 'Document title (default: Document)' },
      },
      required: ['content'],
    },
  },
  {
    name: 'docx_convert_md_to_docx',
    description: 'Convert Markdown file or content to a .docx Word document. Renders markdown to styled HTML then to DOCX. Mermaid code blocks are rendered as images via a headless browser (falls back to source text if rendering fails). Local images are embedded as base64.',
    inputSchema: {
      type: 'object',
      properties: {
        mdPath: { type: 'string', description: 'Path to Markdown file (absolute or relative to cwd)' },
        mdContent: { type: 'string', description: 'Markdown content string' },
        outputPath: outputPathProp,
        title: { type: 'string', description: 'Document title (default: document)' },
        embedImages: { type: 'boolean', description: 'Embed local images as base64 (default: true)' },
      },
    },
  },
  {
    name: 'docx_convert_html_to_docx',
    description: 'Convert HTML content to a .docx Word document with style preservation. Images (data URIs or file paths) are embedded as ImageRun; unsupported formats (svg/webp) are silently skipped.',
    inputSchema: {
      type: 'object',
      properties: {
        htmlContent: { type: 'string', description: 'HTML content string' },
        outputPath: outputPathProp,
      },
      required: ['htmlContent'],
    },
  },
  {
    name: 'docx_read_document',
    description: 'Read a .docx file: list paragraph text, styles, alignment, table/section counts, inline images. Requires python-docx (bundled with runtime).',
    inputSchema: {
      type: 'object',
      properties: {
        path: docxPathProp,
      },
      required: ['path'],
    },
  },
  {
    name: 'docx_edit_paragraph',
    description: 'Modify the text (and optionally style) of a paragraph in an existing .docx file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: docxPathProp,
        index: { type: 'number', description: 'Paragraph index (0-based)' },
        text: { type: 'string', description: 'New paragraph text' },
        style: { type: 'string', description: 'Paragraph style name, e.g. Heading 1, Normal (optional)' },
      },
      required: ['path', 'index', 'text'],
    },
  },
  {
    name: 'docx_add_paragraph',
    description: 'Append a new paragraph to the end of a .docx file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: docxPathProp,
        text: { type: 'string', description: 'Paragraph text' },
        style: { type: 'string', description: 'Paragraph style name (optional)' },
        bold: { type: 'boolean', description: 'Bold (default: false)' },
        italic: { type: 'boolean', description: 'Italic (default: false)' },
        font_size: { type: 'number', description: 'Font size in points (optional)' },
        alignment: { type: 'string', enum: ['left', 'center', 'right', 'justify'], description: 'Alignment (optional)' },
      },
      required: ['path', 'text'],
    },
  },
  {
    name: 'docx_insert_image',
    description: 'Insert an image into a .docx file at a paragraph (or append to end). Width/height in inches.',
    inputSchema: {
      type: 'object',
      properties: {
        path: docxPathProp,
        image_path: { type: 'string', description: 'Path to image file (PNG/JPG)' },
        index: { type: 'number', description: 'Insert image as a new paragraph AFTER this paragraph index (default: append to end)' },
        width_inches: { type: 'number', description: 'Image width in inches (default: original size)' },
        height_inches: { type: 'number', description: 'Image height in inches (default: original size)' },
      },
      required: ['path', 'image_path'],
    },
  },
  {
    name: 'docx_insert_table',
    description: 'Insert a table into a .docx file (appended to end). Provide data as 2D array, or rows/cols for empty grid.',
    inputSchema: {
      type: 'object',
      properties: {
        path: docxPathProp,
        data: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: '2D array of cell values (priority; rows/cols ignored when provided)' },
        rows: { type: 'number', description: 'Row count when data not provided (default: 2)' },
        cols: { type: 'number', description: 'Column count when data not provided (default: 2)' },
        header_row: { type: 'boolean', description: 'Add header row when empty grid (default: true)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'docx_change_style',
    description: 'Change the style (e.g. Heading 1, Title, Normal) of a paragraph in a .docx file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: docxPathProp,
        index: { type: 'number', description: 'Paragraph index (0-based)' },
        style: { type: 'string', description: 'Style name to apply' },
      },
      required: ['path', 'index', 'style'],
    },
  },
  {
    name: 'docx_list_tables',
    description: 'List all tables in a .docx file with dimensions and preview content.',
    inputSchema: {
      type: 'object',
      properties: {
        path: docxPathProp,
      },
      required: ['path'],
    },
  },
  {
    name: 'docx_available_styles',
    description: 'List all available style names in a .docx file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: docxPathProp,
      },
      required: ['path'],
    },
  },
  {
    name: 'pdf_add_watermark',
    description: 'Add a text or image watermark to a PDF. Text watermarks are tiled diagonally (-30°); image watermarks support 6 anchor positions. Overwrites the file in place.',
    inputSchema: {
      type: 'object',
      properties: {
        pdfPath: { type: 'string', description: 'Path to PDF file (overwritten in place)' },
        watermarkText: { type: 'string', description: 'Watermark text (highest priority; default: CONFIDENTIAL)' },
        watermarkImage: { type: 'string', description: 'Image path (PNG) used if no text given' },
        watermarkImageScale: { type: 'number', description: 'Image scale (default: 0.25)' },
        watermarkImageOpacity: { type: 'number', description: 'Image opacity 0-1 (default: 0.3)' },
        watermarkImagePosition: { type: 'string', enum: ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center', 'fullscreen'], description: 'Image position (default: top-right)' },
        watermarkFontSize: { type: 'number', description: 'Text font size (default: 8)' },
        watermarkTextOpacity: { type: 'number', description: 'Text opacity 0-1 (default: 0.3)' },
      },
      required: ['pdfPath'],
    },
  },
  {
    name: 'pdf_add_qrcode',
    description: 'Embed a QR code image on the last page of a PDF, with optional caption text. Overwrites the file in place.',
    inputSchema: {
      type: 'object',
      properties: {
        pdfPath: { type: 'string', description: 'Path to PDF file (overwritten in place)' },
        qrCodePath: { type: 'string', description: 'QR code image path (PNG)' },
        qrScale: { type: 'number', description: 'Scale ratio (default: 0.15)' },
        qrOpacity: { type: 'number', description: 'Opacity 0-1 (default: 1.0)' },
        qrPosition: { type: 'string', enum: ['top-left', 'top-right', 'top-center', 'bottom-left', 'bottom-right', 'bottom-center', 'center'], description: 'Anchor (default: bottom-center)' },
        addText: { type: 'boolean', description: 'Add caption below QR (default: true)' },
        customText: { type: 'string', description: 'Caption text (default: "Scan QR code for more information")' },
        textSize: { type: 'number', description: 'Caption font size (default: 8)' },
        textColor: { type: 'string', description: 'Caption hex color (default: #000000)' },
      },
      required: ['pdfPath', 'qrCodePath'],
    },
  },
];
