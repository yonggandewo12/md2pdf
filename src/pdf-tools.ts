import { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * PDF 操作 MCP 工具定义与 action 映射。
 *
 * 分发方式：
 *  - merge / split / extract / compress → 纯 JS（src/pdf-ops.ts），不走子进程
 *  - encrypt / decrypt → scripts/pdf/run.py 的 action
 *
 * 在 src/index.ts 的 dispatch 中，先查 PDF_ACTION_MAP 拿 action 名，
 * 再按 action 名路由到纯 JS 或 Python 子进程。
 */
export const PDF_ACTION_MAP: Record<string, string> = {
  pdf_merge_pdfs: 'merge',
  pdf_split_pdf: 'split',
  pdf_extract_pages: 'extract',
  pdf_compress_pdf: 'compress',
  pdf_encrypt_pdf: 'encrypt',
  pdf_decrypt_pdf: 'decrypt',
};

const pdfPathProp = {
  type: 'string',
  description: 'Path to PDF file (absolute or relative to cwd)',
};

export const PDF_TOOLS: Tool[] = [
  {
    name: 'pdf_merge_pdfs',
    description: 'Merge multiple PDF files into a single output file.',
    inputSchema: {
      type: 'object',
      properties: {
        pdfPaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Paths to PDF files to merge, in order',
        },
        outputPath: {
          type: 'string',
          description: 'Output PDF file path (absolute or relative to cwd)',
        },
      },
      required: ['pdfPaths', 'outputPath'],
    },
  },
  {
    name: 'pdf_split_pdf',
    description:
      'Split a PDF by page ranges into multiple files. Ranges use 1-based inclusive syntax like "1-3,5,7-9".',
    inputSchema: {
      type: 'object',
      properties: {
        pdfPath: pdfPathProp,
        pageRanges: {
          type: 'string',
          description: 'Page ranges, e.g. "1-3,5,7-9" (1-based, inclusive)',
        },
        outputDir: {
          type: 'string',
          description: 'Output directory (default: <source>_split/ next to source)',
        },
        outputNamePrefix: {
          type: 'string',
          description: 'Prefix for output filenames (default: source stem)',
        },
      },
      required: ['pdfPath', 'pageRanges'],
    },
  },
  {
    name: 'pdf_extract_pages',
    description:
      'Extract specific pages from a PDF into a single output file. Ranges use 1-based inclusive syntax like "1-3,5,7-9".',
    inputSchema: {
      type: 'object',
      properties: {
        pdfPath: pdfPathProp,
        pageRanges: {
          type: 'string',
          description: 'Page ranges, e.g. "1-3,5,7-9" (1-based, inclusive)',
        },
        outputPath: {
          type: 'string',
          description: 'Output PDF file path (absolute or relative to cwd)',
        },
      },
      required: ['pdfPath', 'pageRanges', 'outputPath'],
    },
  },
  {
    name: 'pdf_compress_pdf',
    description:
      'Re-compress a PDF by re-saving its object streams (removes incremental updates, re-packs objects). Overwrites in place unless outputPath is given.',
    inputSchema: {
      type: 'object',
      properties: {
        pdfPath: pdfPathProp,
        outputPath: {
          type: 'string',
          description: 'Optional output file path; default overwrites input in place',
        },
        useObjectStreams: {
          type: 'boolean',
          description: 'Pack objects into object streams (default: true)',
        },
      },
      required: ['pdfPath'],
    },
  },
  {
    name: 'pdf_encrypt_pdf',
    description:
      'Encrypt a PDF with a user password and optional owner password / permission restrictions. Overwrites in place unless outputPath is given.',
    inputSchema: {
      type: 'object',
      properties: {
        pdfPath: pdfPathProp,
        outputPath: {
          type: 'string',
          description: 'Optional output file path; default overwrites input in place',
        },
        userPassword: {
          type: 'string',
          description: 'Password required to open the PDF (default: empty)',
        },
        ownerPassword: {
          type: 'string',
          description: 'Owner password controlling permissions (default: random)',
        },
        permissions: {
          type: 'object',
          description: 'Permission flags granted to users (all default false): printing, modifying, copying, annotating, fillingForms, contentAccessibility, documentAssembly',
          properties: {
            printing: { type: 'boolean' },
            modifying: { type: 'boolean' },
            copying: { type: 'boolean' },
            annotating: { type: 'boolean' },
            fillingForms: { type: 'boolean' },
            contentAccessibility: { type: 'boolean' },
            documentAssembly: { type: 'boolean' },
          },
        },
      },
      required: ['pdfPath'],
    },
  },
  {
    name: 'pdf_decrypt_pdf',
    description:
      'Decrypt an encrypted PDF given its password, writing a plaintext copy. Overwrites in place unless outputPath is given.',
    inputSchema: {
      type: 'object',
      properties: {
        pdfPath: pdfPathProp,
        password: {
          type: 'string',
          description: 'Password of the encrypted PDF',
        },
        outputPath: {
          type: 'string',
          description: 'Optional output file path; default overwrites input in place',
        },
      },
      required: ['pdfPath', 'password'],
    },
  },
];
