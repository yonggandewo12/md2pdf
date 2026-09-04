/**
 * 二维码服务：qrcode_generate 工具的实现后端。
 *
 * 基于 qrcode（纯 JS，零原生依赖）。支持：
 * - 输出 PNG 文件 / SVG 文件 / base64 Data URL；
 * - 自定义宽度、容错等级、边距与前景/背景色；
 * - UTF-8 内容（含中文）自动使用字节模式编码。
 *
 * 与 pdf_add_qrcode 互补：后者只能把已有二维码图片嵌入 PDF，本工具负责从零生成。
 *
 * @author Liang.Xu
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import qrcode from 'qrcode';

export interface QrcodeOptions {
  text: string;
  outputPath?: string;
  /** png / svg / dataURL（默认按 outputPath 扩展名，否则 png）。 */
  format?: 'png' | 'svg' | 'dataURL';
  width?: number;
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
  margin?: number;
  /** 前景色，如 '#000000'（SVG/dataURL 下生效）。 */
  colorDark?: string;
  /** 背景色，如 '#FFFFFF'。 */
  colorLight?: string;
}

export interface QrcodeResult {
  success: boolean;
  outputPath?: string;
  format?: string;
  width?: number;
  dataURL?: string;
  error?: string;
  details?: { processingTime: number };
}

export async function generateQrcode(options: QrcodeOptions): Promise<QrcodeResult> {
  const start = Date.now();
  const details = () => ({ processingTime: Date.now() - start });
  try {
    if (!options.text) {
      throw new Error('text 不能为空');
    }
    const text = typeof options.text === 'string' ? options.text : JSON.stringify(options.text);

    let format = options.format;
    if (!format) {
      const ext = options.outputPath ? path.extname(options.outputPath).toLowerCase() : '';
      format = ext === '.svg' ? 'svg' : ext === '.png' ? 'png' : 'png';
    }

    const qrOptions: qrcode.QRCodeToFileOptions = {
      width: options.width ?? 300,
      errorCorrectionLevel: options.errorCorrectionLevel ?? 'M',
      margin: options.margin ?? 2,
      ...(options.colorDark ? { color: { dark: options.colorDark, ...(options.colorLight ? { light: options.colorLight } : {}) } } : {}),
    };

    if (format === 'dataURL') {
      const dataUrl = await qrcode.toDataURL(text, {
        width: options.width ?? 300,
        errorCorrectionLevel: options.errorCorrectionLevel ?? 'M',
        margin: options.margin ?? 2,
        ...(options.colorDark || options.colorLight
          ? {
              color: {
                dark: options.colorDark ?? '#000000',
                light: options.colorLight ?? '#FFFFFF',
              },
            }
          : {}),
      });
      return { success: true, format: 'dataURL', dataURL: dataUrl, details: details() };
    }

    if (!options.outputPath) {
      throw new Error('输出 png/svg 时必须提供 outputPath');
    }
    const resolvedOutput = path.resolve(options.outputPath);
    await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });

    if (format === 'svg') {
      const svg = await qrcode.toString(text, {
        type: 'svg',
        errorCorrectionLevel: options.errorCorrectionLevel ?? 'M',
        margin: options.margin ?? 2,
        ...(options.colorDark || options.colorLight
          ? {
              color: {
                dark: options.colorDark ?? '#000000',
                light: options.colorLight ?? '#FFFFFF',
              },
            }
          : {}),
      });
      await fs.writeFile(resolvedOutput, svg);
    } else {
      await qrcode.toFile(resolvedOutput, text, qrOptions);
    }

    const fileSize = (await fs.stat(resolvedOutput)).size;
    return {
      success: true,
      outputPath: resolvedOutput,
      format,
      width: options.width ?? 300,
      details: details(),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      details: details(),
    };
  }
}
