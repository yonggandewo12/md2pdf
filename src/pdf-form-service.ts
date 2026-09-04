/**
 * PDF 表单服务：pdf_fill_form 工具的实现后端。
 *
 * 基于 pdf-lib（已在依赖中），零新增依赖。支持：
 * - 只读模式：不传 fields 时列出 PDF 的全部表单字段（名称/类型/当前值/选项）；
 * - 填充模式：按字段名写入 TextField/CheckBox/RadioGroup/Dropdown/OptionList；
 * - 可选 flatten：填充后扁平化表单，移除可编辑性（保留填写的文本，形同打印件）。
 *
 * 不依赖任何云服务与外部进程，纯 JS。
 *
 * @author Liang.Xu
 */
import { promises as fs, existsSync } from 'fs';
import * as path from 'path';
import {
  PDFDocument,
  PDFCheckBox,
  PDFDropdown,
  PDFField,
  PDFFont,
  PDFOptionList,
  PDFRadioGroup,
  PDFHexString,
  PDFTextField,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

/** 文本是否含 WinAnsi 之外字符（中文等，需嵌入字体才能生成 appearance）。 */
function needsCjk(text: string): boolean {
  return /[^\u0000-\u00ff]/.test(text);
}

/** 跨平台查找一个系统中文字体文件路径。 */
function findCjkFontPath(): string | undefined {
  // 候选含 TTF/OTF/TTC：TTC（字体集合）需经 fontkit 取出单个 face 后才能
  // 供 pdf-lib embedFont 子集化，embedCjkFont 会自动处理。
  const candidates: string[] =
    process.platform === 'darwin'
      ? ['/System/Library/Fonts/Supplemental/Arial Unicode.ttf']
      : process.platform === 'win32'
        ? ['C:\\Windows\\Fonts\\simhei.ttf', 'C:\\Windows\\Fonts\\msyh.ttf', 'C:\\Windows\\Fonts\\simsun.ttc']
        : [
            '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
            '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
            '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
          ];
  return candidates.find((c) => existsSync(c));
}

/**
 * 嵌入系统中文字体（子集化）供手动生成文本字段 appearance 使用。
 * pdf-lib 的 default appearance 字体硬编码为 Helvetica（WinAnsi），无法编码
 * 中文；因此中文文本字段需用此字体 + acroField.setValue + updateWidgetAppearance
 * 自行生成 appearance。
 *
 * TTC（字体集合）经 fontkit 解析为 Collection，需取出单个 face 后再 embedFont。
 */
async function embedCjkFont(doc: PDFDocument): Promise<PDFFont> {
  const fontPath = findCjkFontPath();
  if (!fontPath) {
    throw new Error('检测到中文字符，但未找到系统中文字体。请安装中文字体（如 Noto Sans CJK）后重试');
  }
  doc.registerFontkit(fontkit);
  const fontBytes = await fs.readFile(fontPath);
  // TTC 文件需先解析为 Collection 取出单个 face；TTF/OTF 直接 embedFont
  if (path.extname(fontPath).toLowerCase() === '.ttc') {
    const collection = (fontkit as unknown as { create: (data: Buffer) => { getFont: (index: number) => unknown } }).create(fontBytes);
    const face = collection.getFont(0);
    return doc.embedFont(face as ArrayBuffer, { subset: true });
  }
  return doc.embedFont(fontBytes, { subset: true });
}

export interface PdfFormFieldInfo {
  name: string;
  type: string;
  currentValue?: string | string[];
  options?: string[];
  required?: boolean;
  readOnly?: boolean;
}

export interface PdfFormFillOptions {
  pdfPath: string;
  outputPath?: string;
  /** name → value。value 为数组时用于多选（OptionList）。 */
  fields?: { name: string; value: string | string[] }[];
  /** 填充后扁平化表单（默认 false）。 */
  flatten?: boolean;
}

export interface PdfFormFillResult {
  success: boolean;
  outputPath?: string;
  fields?: PdfFormFieldInfo[];
  filledCount?: number;
  invalidFields?: string[];
  error?: string;
  details?: { processingTime: number };
}

function fieldTypeOf(field: PDFField): string {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'optionlist';
  return 'unknown';
}

function currentValueOf(field: PDFField): string | string[] | undefined {
  if (field instanceof PDFTextField) return field.getText() ?? undefined;
  if (field instanceof PDFCheckBox) return field.isChecked() ? 'checked' : 'unchecked';
  if (field instanceof PDFRadioGroup) {
    const selected = field.getSelected();
    return selected ?? undefined;
  }
  if (field instanceof PDFDropdown) return field.getSelected() ?? undefined;
  if (field instanceof PDFOptionList) return field.getSelected();
  return undefined;
}

function optionsOf(field: PDFField): string[] | undefined {
  if (field instanceof PDFRadioGroup) return field.getOptions();
  if (field instanceof PDFDropdown) return field.getOptions();
  if (field instanceof PDFOptionList) return field.getOptions();
  return undefined;
}

/** 是否为「勾选」语义：true/1/yes/on/x/✓ 等。 */
function isTruthy(value: string): boolean {
  const v = value.trim().toLowerCase();
  return ['true', '1', 'yes', 'y', 'on', 'x', 'checked', '✓', '是', '勾选'].includes(v);
}

function describeField(field: PDFField): PdfFormFieldInfo {
  const info: PdfFormFieldInfo = {
    name: field.getName(),
    type: fieldTypeOf(field),
  };
  const current = currentValueOf(field);
  if (current !== undefined) info.currentValue = current;
  const opts = optionsOf(field);
  if (opts && opts.length > 0) info.options = opts;
  // pdf-lib 类型未暴露 isRequired/isReadOnly，以 duck-typing 安全探测
  const acro = field.acroField as unknown as {
    isRequired?: () => boolean;
    isReadOnly?: () => boolean;
  };
  info.required = acro.isRequired?.() ?? false;
  info.readOnly = acro.isReadOnly?.() ?? false;
  return info;
}

function applyValue(field: PDFField, value: string | string[]): void {
  if (field instanceof PDFCheckBox) {
    if (Array.isArray(value)) {
      if (value.length > 0) field.check();
    } else if (isTruthy(String(value))) {
      field.check();
    } else {
      field.uncheck();
    }
    return;
  }
  if (field instanceof PDFRadioGroup) {
    const selected = Array.isArray(value) ? value[0] : value;
    field.select(String(selected));
    return;
  }
  throw new Error(`不支持的表单字段类型: ${field.getName()}`);
}

/**
 * 列出或填充 PDF 表单字段。
 * - 不传 fields：只返回字段清单（不写文件，outputPath 可省略）；
 * - 传 fields：先校验所有字段名存在，再逐个填充，写出到 outputPath。
 */
export async function fillPdfForm(options: PdfFormFillOptions): Promise<PdfFormFillResult> {
  const start = Date.now();
  const details = () => ({ processingTime: Date.now() - start });
  try {
    const { pdfPath, outputPath, fields, flatten } = options;
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(pdfPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new Error(code === 'ENOENT' ? `PDF 文件不存在: ${pdfPath}` : `PDF 文件读取失败 (${code ?? 'UNKNOWN'}): ${pdfPath}`);
    }

    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const form = doc.getForm();
    const formFields = form.getFields();

    // 读取模式：仅列出字段
    if (!fields || fields.length === 0) {
      return {
        success: true,
        fields: formFields.map(describeField),
        filledCount: 0,
        details: details(),
      };
    }

    if (!outputPath) {
      throw new Error('填充模式必须提供 outputPath');
    }

    // 校验字段名
    const nameSet = new Set(formFields.map((f) => f.getName()));
    const invalid = fields.filter((f) => !nameSet.has(f.name)).map((f) => f.name);
    if (invalid.length > 0) {
      throw new Error(`找不到表单字段: ${invalid.join(', ')}。可用字段: ${[...nameSet].join(', ') || '(无)'}`);
    }

    const fieldMap = new Map(formFields.map((f) => [f.getName(), f]));
    // save 时 pdf-lib 对 dirty 字段统一用 Helvetica 重建 appearance，
    // 而 Helvetica（WinAnsi）无法编码中文。因此值含中文的 text/dropdown/
    // optionlist 字段在填充后必须立即用嵌入的 CJK 字体预生成 appearance
    // （defaultUpdateAppearances 会 markAsClean，save 时跳过重建）。
    let cjkFont: PDFFont | null = null;
    const ensureCjkFont = async (): Promise<PDFFont> => {
      cjkFont ??= await embedCjkFont(doc);
      return cjkFont;
    };
    for (const { name, value } of fields) {
      const field = fieldMap.get(name)!;
      if (field instanceof PDFTextField) {
        const text = Array.isArray(value) ? value.join(', ') : String(value);
        if (needsCjk(text)) {
          // PDFHexString UTF-16BE 编码：acroField 的 PDFString.of 对非
          // Latin-1 字符序列化时截断高字节（'张'=0x5F20 → 0x20 空格）
          (field.acroField as unknown as { setValue: (v: PDFHexString) => void }).setValue(
            PDFHexString.fromText(text),
          );
          field.defaultUpdateAppearances(await ensureCjkFont());
        } else {
          field.setText(text);
        }
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
        const vals = Array.isArray(value) ? value : [String(value)];
        field.select(vals);
        if (vals.some((v) => needsCjk(v))) {
          field.defaultUpdateAppearances(await ensureCjkFont());
        }
      } else {
        applyValue(field, value);
      }
    }

    // 字段状态须在 flatten 前采集：flatten 会移除 widget，此后
    // describeField 读取 checkbox onValue 会因 Kids 引用失效而抛错
    const resultFields = formFields.map(describeField);

    if (flatten) {
      form.flatten();
    }

    const resolvedOutput = path.resolve(outputPath);
    await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });
    await fs.writeFile(resolvedOutput, await doc.save({ useObjectStreams: true }));

    return {
      success: true,
      outputPath: resolvedOutput,
      fields: resultFields,
      filledCount: fields.length,
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
