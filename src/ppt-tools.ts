import { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * PPTX 读取/编辑 MCP 工具定义与 action 映射。
 * 每个 MCP 工具名映射到 scripts/ppt-master/scripts/ppt_mcp/run.py 的 action。
 */

export const PPT_ACTION_MAP: Record<string, string> = {
  pptx_read_presentation: 'read_presentation',
  pptx_read_slide_details: 'read_slide_details',
  pptx_extract_text: 'extract_text',
  pptx_to_images: 'to_images',
  pptx_apply_plan: 'apply_plan',
  pptx_replace_text: 'replace_text',
  pptx_replace_table_cells: 'replace_table_cells',
  pptx_duplicate_slide: 'duplicate_slide',
  pptx_add_notes: 'add_notes',
  pptx_set_transitions: 'set_transitions',
};

const pptxPathProp = {
  type: 'string',
  description: 'Path to the .pptx file (absolute or relative to cwd)',
};
const outputPathProp = {
  type: 'string',
  description: 'Output .pptx file path (absolute or relative to cwd)',
};

export const PPT_TOOLS: Tool[] = [
  {
    name: 'pptx_read_presentation',
    description: 'Read a PowerPoint presentation overview: slide count, dimensions, per-slide title and shape count.',
    inputSchema: {
      type: 'object',
      properties: {
        pptxPath: pptxPathProp,
      },
      required: ['pptxPath'],
    },
  },
  {
    name: 'pptx_read_slide_details',
    description: 'Read detailed shape information for one slide: name, type, position, size, text, tables.',
    inputSchema: {
      type: 'object',
      properties: {
        pptxPath: pptxPathProp,
        slideIndex: { type: 'number', description: 'Slide index, 1-based' },
      },
      required: ['pptxPath', 'slideIndex'],
    },
  },
  {
    name: 'pptx_extract_text',
    description: 'Extract the full presentation to Markdown text (titles, bullets, tables, speaker notes preserved). Optionally writes a .md file.',
    inputSchema: {
      type: 'object',
      properties: {
        pptxPath: pptxPathProp,
        outputPath: {
          type: 'string',
          description: 'Optional output .md file path (default: <source>.md next to source)',
        },
      },
      required: ['pptxPath'],
    },
  },
  {
    name: 'pptx_to_images',
    description: 'Render each slide of a PowerPoint to a PNG/JPEG image. Slides use 1-based range syntax like "1-3,5".',
    inputSchema: {
      type: 'object',
      properties: {
        pptxPath: pptxPathProp,
        outputDir: {
          type: 'string',
          description: 'Output directory (default: <source>_images/ next to source)',
        },
        dpi: { type: 'number', description: 'Render DPI (default: 150)' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'Output format (default: png)' },
        slides: {
          type: 'string',
          description: 'Slide ranges, e.g. "1-3,5,7-9" (1-based; default: all)',
        },
      },
      required: ['pptxPath'],
    },
  },
  {
    name: 'pptx_apply_plan',
    description:
      'Apply a generic template_fill_pptx fill plan to a PowerPoint. Each plan slide has source_slide plus optional replacements, table_edits, chart_edits, notes, transition.',
    inputSchema: {
      type: 'object',
      properties: {
        pptxPath: pptxPathProp,
        outputPath: outputPathProp,
        plan: {
          type: 'object',
          description: 'Fill plan: { slides: [{ source_slide, replacements?, table_edits?, chart_edits?, notes?, transition? }] }',
        },
        transition: { type: 'string', description: 'Default transition effect (default: fade)' },
        transitionDuration: { type: 'number', description: 'Transition duration in seconds (default: 0.5)' },
      },
      required: ['pptxPath', 'outputPath', 'plan'],
    },
  },
  {
    name: 'pptx_replace_text',
    description:
      'Replace text in a specific slide by shape selector. Each replacement uses one of slot_id, shape_id, or shape_name plus text.',
    inputSchema: {
      type: 'object',
      properties: {
        pptxPath: pptxPathProp,
        outputPath: outputPathProp,
        sourceSlide: { type: 'number', description: 'Slide index to edit, 1-based (default: 1)' },
        replacements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              slot_id: { type: 'string' },
              shape_id: { type: 'number' },
              shape_name: { type: 'string' },
              text: { type: 'string' },
            },
          },
          description: 'Text replacements targeting shapes',
        },
      },
      required: ['pptxPath', 'outputPath', 'replacements'],
    },
  },
  {
    name: 'pptx_replace_table_cells',
    description:
      'Replace cells in tables of a specific slide. Each edit has a table selector (table_id/shape_id/shape_name) plus row, col, text.',
    inputSchema: {
      type: 'object',
      properties: {
        pptxPath: pptxPathProp,
        outputPath: outputPathProp,
        sourceSlide: { type: 'number', description: 'Slide index to edit, 1-based (default: 1)' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              table_id: { type: 'string' },
              shape_id: { type: 'number' },
              shape_name: { type: 'string' },
              row: { type: 'number' },
              col: { type: 'number' },
              text: { type: 'string' },
            },
          },
          description: 'Table cell edits',
        },
      },
      required: ['pptxPath', 'outputPath', 'edits'],
    },
  },
  {
    name: 'pptx_duplicate_slide',
    description: 'Duplicate a slide (appended after existing slides), preserving all original slides.',
    inputSchema: {
      type: 'object',
      properties: {
        pptxPath: pptxPathProp,
        outputPath: outputPathProp,
        slideIndex: { type: 'number', description: 'Slide index to duplicate, 1-based' },
        count: { type: 'number', description: 'How many copies to append (default: 1)' },
      },
      required: ['pptxPath', 'outputPath', 'slideIndex'],
    },
  },
  {
    name: 'pptx_add_notes',
    description: 'Add speaker notes to one or more slides. notes: [{ slideIndex, text }].',
    inputSchema: {
      type: 'object',
      properties: {
        pptxPath: pptxPathProp,
        outputPath: outputPathProp,
        notes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              slideIndex: { type: 'number' },
              text: { type: 'string' },
            },
          },
          description: 'Speaker notes per slide',
        },
      },
      required: ['pptxPath', 'outputPath', 'notes'],
    },
  },
  {
    name: 'pptx_set_transitions',
    description: 'Set slide transition effects for all slides or a specific subset.',
    inputSchema: {
      type: 'object',
      properties: {
        pptxPath: pptxPathProp,
        outputPath: outputPathProp,
        transition: {
          type: 'string',
          description: 'Transition effect, e.g. fade, push, wipe, morph, cut',
        },
        duration: { type: 'number', description: 'Transition duration in seconds (default: 0.5)' },
        slides: {
          type: 'array',
          items: { type: 'number' },
          description: 'Slide indices to apply to (1-based; default: all slides)',
        },
      },
      required: ['pptxPath', 'outputPath', 'transition'],
    },
  },
];
