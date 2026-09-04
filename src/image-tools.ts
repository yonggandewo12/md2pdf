import { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * 图片处理 MCP 工具定义与 action 映射。
 * 每个 MCP 工具名映射到 scripts/ppt-master/scripts/image_mcp/run.py 的 action。
 */

export const IMAGE_ACTION_MAP: Record<string, string> = {
  image_info: 'info',
  image_convert: 'convert',
  image_resize: 'resize',
  image_compress: 'compress',
  image_rotate: 'rotate',
  image_crop: 'crop',
  image_watermark: 'watermark',
  image_gif: 'gif',
  image_quantize: 'quantize',
  image_edit_exif: 'edit_exif',
};

const imagePathProp = {
  type: 'string',
  description: 'Path to the input image file (absolute or relative to cwd)',
};
const outputPathProp = {
  type: 'string',
  description: 'Path to the output image file (absolute or relative to cwd)',
};

export const IMAGE_TOOLS: Tool[] = [
  {
    name: 'image_info',
    description: 'Read image metadata: format, mode, dimensions, file size, EXIF orientation.',
    inputSchema: {
      type: 'object',
      properties: { imagePath: imagePathProp },
      required: ['imagePath'],
    },
  },
  {
    name: 'image_convert',
    description: 'Convert an image to another format. Target format is determined by the output file extension (PNG/JPEG/WEBP/GIF/BMP/TIFF/ICO).',
    inputSchema: {
      type: 'object',
      properties: {
        imagePath: imagePathProp,
        outputPath: outputPathProp,
        quality: { type: 'number', description: 'Quality for JPEG/WEBP (default: 90, range 0-100)' },
        stripMetadata: { type: 'boolean', description: 'Strip EXIF/ICC metadata (default: false)' },
      },
      required: ['imagePath', 'outputPath'],
    },
  },
  {
    name: 'image_resize',
    description: 'Resize an image. mode=fit keeps aspect ratio fitting inside; fill crops to fill; pad adds background; stretch ignores aspect ratio.',
    inputSchema: {
      type: 'object',
      properties: {
        imagePath: imagePathProp,
        outputPath: outputPathProp,
        width: { type: 'number', description: 'Target width in pixels' },
        height: { type: 'number', description: 'Target height in pixels' },
        mode: { type: 'string', enum: ['fit', 'fill', 'pad', 'stretch'], description: 'Resize mode (default: fit)' },
        keepAspect: { type: 'boolean', description: 'Keep aspect ratio (default: true)' },
        background: { type: 'string', description: 'Background hex color for pad mode (default: #FFFFFF)' },
      },
      required: ['imagePath', 'outputPath'],
    },
  },
  {
    name: 'image_compress',
    description: 'Compress an image via quality reduction and optional max dimension limit.',
    inputSchema: {
      type: 'object',
      properties: {
        imagePath: imagePathProp,
        outputPath: outputPathProp,
        quality: { type: 'number', description: 'Quality (default: 75, range 0-100)' },
        maxWidth: { type: 'number', description: 'Max width in pixels' },
        maxHeight: { type: 'number', description: 'Max height in pixels' },
        format: { type: 'string', enum: ['jpeg', 'webp', 'png'], description: 'Output format (default: keep source)' },
      },
      required: ['imagePath', 'outputPath'],
    },
  },
  {
    name: 'image_rotate',
    description: 'Rotate an image by arbitrary degrees (clockwise). When fixExif is true, apply EXIF orientation correction first, then rotate by degrees (omit degrees or use 0 to only fix orientation).',
    inputSchema: {
      type: 'object',
      properties: {
        imagePath: imagePathProp,
        outputPath: outputPathProp,
        degrees: { type: 'number', description: 'Rotation degrees clockwise (default: 0)' },
        expand: { type: 'boolean', description: 'Expand canvas to fit rotation (default: true)' },
        fixExif: { type: 'boolean', description: 'Apply EXIF orientation correction before rotating (default: false)' },
      },
      required: ['imagePath', 'outputPath'],
    },
  },
  {
    name: 'image_crop',
    description: 'Crop an image by pixel coordinates (left/top/right/bottom).',
    inputSchema: {
      type: 'object',
      properties: {
        imagePath: imagePathProp,
        outputPath: outputPathProp,
        left: { type: 'number', description: 'Left edge (pixels)' },
        top: { type: 'number', description: 'Top edge (pixels)' },
        right: { type: 'number', description: 'Right edge (pixels)' },
        bottom: { type: 'number', description: 'Bottom edge (pixels)' },
      },
      required: ['imagePath', 'outputPath', 'left', 'top', 'right', 'bottom'],
    },
  },
  {
    name: 'image_watermark',
    description:
      'Add a text or image watermark to an image. Text watermark uses a CJK-capable font when available. position supports tile for repeating.',
    inputSchema: {
      type: 'object',
      properties: {
        imagePath: imagePathProp,
        outputPath: outputPathProp,
        text: { type: 'string', description: 'Watermark text (either text or textImage required)' },
        textImage: { type: 'string', description: 'Watermark image path (either text or textImage required)' },
        position: {
          type: 'string',
          enum: ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center', 'tile'],
          description: 'Position (default: bottom-right)',
        },
        opacity: { type: 'number', description: 'Opacity 0-1 (default: 0.3)' },
        fontSize: { type: 'number', description: 'Text font size (default: 32)' },
        color: { type: 'string', description: 'Text hex color (default: #FFFFFF)' },
        margin: { type: 'number', description: 'Margin from edges in pixels (default: 16)' },
        fontPath: { type: 'string', description: 'Custom TTF/OTF font path (default: auto-detect CJK font)' },
      },
      required: ['imagePath', 'outputPath'],
    },
  },
  {
    name: 'image_gif',
    description:
      'Compose multiple images into an animated GIF. Frames follow the input order; transparency is preserved.',
    inputSchema: {
      type: 'object',
      properties: {
        imagePaths: { type: 'array', items: { type: 'string' }, description: 'Frame image paths in order (required)' },
        outputPath: { type: 'string', description: 'Output .gif file path (required)' },
        duration: { type: 'number', description: 'Milliseconds per frame (default: 500)' },
        loop: { type: 'number', description: 'Loop count; 0 means infinite (default: 0)' },
      },
      required: ['imagePaths', 'outputPath'],
    },
  },
  {
    name: 'image_quantize',
    description:
      'Reduce the color palette of an image (color quantization) to shrink file size. Output format follows the output extension.',
    inputSchema: {
      type: 'object',
      properties: {
        imagePath: imagePathProp,
        outputPath: outputPathProp,
        colors: { type: 'number', description: 'Palette size 2-256 (default: 256)' },
        method: {
          type: 'string',
          enum: ['mediancut', 'maxcoverage', 'fastoctree', 'libimagequant'],
          description: 'Quantization method (default: Pillow auto)',
        },
      },
      required: ['imagePath', 'outputPath'],
    },
  },
  {
    name: 'image_edit_exif',
    description:
      'Read, edit, or strip EXIF metadata of a JPEG/TIFF/WebP image. Without exif and strip: returns current EXIF. With exif: writes given tags. With strip: removes all EXIF. PNG is not supported.',
    inputSchema: {
      type: 'object',
      properties: {
        imagePath: imagePathProp,
        outputPath: outputPathProp,
        exif: {
          type: 'object',
          additionalProperties: true,
          description:
            'Tags to write: keys are tag names (make/model/orientation/dateTime/artist/copyright/software/imageDescription) or numeric tag ids; values are string/number',
        },
        strip: { type: 'boolean', description: 'Remove all EXIF metadata (default: false)' },
      },
      required: ['imagePath', 'outputPath'],
    },
  },
];
