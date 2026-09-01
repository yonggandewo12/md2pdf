/**
 * HTML → DOCX 转换器（doc-ops-mcp MIT 许可移植）。
 *
 * 用 cheerio 解析 HTML，将 h1-h6 / p / strong / em / u / blockquote / pre /
 * code / ul / ol / table / img 映射为 docx 包的 Paragraph / TextRun / Table /
 * ImageRun，保留内联样式（字号/颜色/加粗/斜体/下划线/对齐）。含 XSS 清洗。
 */
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, UnderlineType, Table, TableRow, TableCell, WidthType, ImageRun } from 'docx';
import { imageSize } from 'image-size';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as cheerio from 'cheerio';

interface StyleMapping {
  heading?: (typeof HeadingLevel)[keyof typeof HeadingLevel];
  size?: number;
  bold?: boolean;
  italics?: boolean;
  underline?: any;
  color?: string;
  highlight?: 'none' | 'black' | 'blue' | 'cyan' | 'darkBlue' | 'darkCyan' | 'darkGray' | 'darkGreen' | 'darkMagenta' | 'darkRed' | 'darkYellow' | 'green' | 'lightGray' | 'magenta' | 'red' | 'white' | 'yellow';
  alignment?: (typeof AlignmentType)[keyof typeof AlignmentType];
}

interface ParsedElement {
  tag: string;
  text: string;
  html: string;
  styles: any;
  src?: string;
}

const FONT_FALLBACK =
  'Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, Microsoft YaHei, SimHei, Arial, sans-serif';

export class HtmlToDocxConverter {
  private styleMap: Map<string, StyleMapping> = new Map();

  constructor() {
    this.initializeStyles();
  }

  /** 清理 HTML 内容，移除危险标签与内联事件/协议。 */
  private sanitizeHtml(html: string): string {
    if (!html || typeof html !== 'string') return '';
    // 先屏蔽 data:image URI：on\w+= 正则会把以 "on<单词>=" 结尾的 base64 当事件属性
    // 误伤（base64 字符集含 "on" 前缀字母），清洗完成后还原，避免破坏内嵌图片。
    // nonce 防止用户正文里的字面量 "__IMG_0__" 在还原时被替换成图片 URI。
    const nonce = Math.random().toString(36).slice(2, 8);
    const placeholders: string[] = [];
    const shielded = html.replace(/data:image\/[a-z0-9.+-]+;base64,[a-zA-Z0-9+/=]+/gi, (uri) => {
      placeholders.push(uri);
      return `__IMG_${nonce}_${placeholders.length - 1}__`;
    });
    const cleaned = shielded
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '')
      .replace(/<object[^>]*>[\s\S]*?<\/object>/gi, '')
      .replace(/<embed[^>]*>/gi, '')
      .replace(/<link[^>]*>/gi, '')
      .replace(/on\w+\s*=\s*["'][^"']{0,500}?["']/gi, '')
      .replace(/javascript:/gi, '')
      .replace(/vbscript:/gi, '')
      // 仅清除非图片的 data: URI（如 data:text/html 的 XSS 载体），
      // 保留 <img src="data:image/..."> 的内嵌图片。
      .replace(/data:(?!image\/)/gi, '')
      .replace(/<meta[^>]*>/gi, '');
    return cleaned.replace(new RegExp(`__IMG_${nonce}_(\\d+)__`, 'g'), (_m, i) => placeholders[Number(i)] ?? '');
  }

  private initializeStyles(): void {
    this.styleMap.set('h1', { heading: HeadingLevel.HEADING_1, size: 32, bold: true, color: '2F5496' });
    this.styleMap.set('h2', { heading: HeadingLevel.HEADING_2, size: 28, bold: true, color: '2F5496' });
    this.styleMap.set('h3', { heading: HeadingLevel.HEADING_3, size: 24, bold: true, color: '1F3763' });
    this.styleMap.set('h4', { heading: HeadingLevel.HEADING_4, size: 22, bold: true, color: '1F3763' });
    this.styleMap.set('h5', { heading: HeadingLevel.HEADING_5, size: 20, bold: true, color: '1F3763' });
    this.styleMap.set('h6', { heading: HeadingLevel.HEADING_6, size: 18, bold: true, color: '1F3763' });
    this.styleMap.set('p', { size: 22, color: '000000' });
    this.styleMap.set('strong', { bold: true });
    this.styleMap.set('b', { bold: true });
    this.styleMap.set('em', { italics: true });
    this.styleMap.set('i', { italics: true });
    this.styleMap.set('u', { underline: { type: UnderlineType.SINGLE } });
    this.styleMap.set('blockquote', { size: 22, italics: true, color: '666666' });
    this.styleMap.set('pre', { size: 18, color: '000000' });
    this.styleMap.set('code', { size: 18, color: 'd73a49' });
  }

  /** 将 HTML 内容转为 DOCX Buffer。 */
  async convertHtmlToDocx(htmlContent: string): Promise<Buffer> {
    const $ = cheerio.load(htmlContent);
    const docElements: any[] = [];
    const elements = this.parseHtmlElements($);

    for (const element of elements) {
      const docxElement = this.createDocxElement(element, $);
      if (docxElement) {
        if (Array.isArray(docxElement)) {
          docElements.push(...docxElement);
        } else {
          docElements.push(docxElement);
        }
      }
    }

    const doc = new Document({
      sections: [{ properties: {}, children: docElements }],
    });
    return await Packer.toBuffer(doc);
  }

  /** 无语义容器标签：递归下钻取其子节点（MdConverter 等工具会包一层 div.layout）。 */
  private static readonly CONTAINER_TAGS = new Set([
    'div', 'main', 'section', 'article', 'header', 'footer', 'nav', 'aside', 'center',
  ]);

  /** 渲染层/元数据标签：不产出 docx 内容（脚本、样式、表单等）。 */
  private static readonly SKIP_TAGS = new Set([
    'script', 'style', 'link', 'meta', 'title', 'head', 'iframe', 'noscript', 'template',
  ]);

  private parseHtmlElements($: any): ParsedElement[] {
    const elements: ParsedElement[] = [];
    const collect = (elem: any): void => {
      const tagName = elem.tagName.toLowerCase();
      if (HtmlToDocxConverter.SKIP_TAGS.has(tagName)) {
        return;
      }
      if (HtmlToDocxConverter.CONTAINER_TAGS.has(tagName)) {
        // 容器无元素子节点但有文本时按普通元素处理（保留容器内联样式），避免内容
        // （如 mermaid 渲染失败后降级保留的 <div class="mermaid"> 源码）被静默丢弃。
        if ($(elem).children('*').length === 0 && $(elem).text().trim()) {
          this.pushElement(elements, $, elem, tagName);
          return;
        }
        // 混合内容容器按文档顺序展开：顶层直接文本节点产出段落（继承容器内联
        // 样式），元素子节点递归。若只按 children() 下钻，这些直接文本会丢失。
        const containerStyles = this.extractStyles($(elem));
        $(elem).contents().each((_i: number, node: any) => {
          if (node.type === 'text') {
            const text = $(node).text();
            if (text.trim()) {
              elements.push({ tag: 'p', text, html: '', styles: containerStyles });
            }
            return;
          }
          if (node.type === 'tag') collect(node);
        });
        return;
      }
      this.pushElement(elements, $, elem, tagName);
    };
    $('body')
      .children()
      .each((_i: number, elem: any) => collect(elem));
    return elements;
  }

  private pushElement(elements: ParsedElement[], $: any, elem: any, tagName: string): void {
    const $elem = $(elem);
    elements.push({
      tag: tagName,
      text: $elem.text(),
      html: $elem.html(),
      styles: this.extractStyles($elem),
      src: tagName === 'img' ? ($elem.attr('src') ?? undefined) : undefined,
    });
  }

  private extractStyles($elem: any): any {
    const styles: any = {};
    const inlineStyle = $elem.attr('style');
    if (inlineStyle) {
      for (const rule of inlineStyle.split(';')) {
        const [property, value] = rule.split(':').map((s: string) => s.trim());
        if (property && value) {
          styles[property] = value;
        }
      }
    }
    const className = $elem.attr('class');
    if (className) {
      styles.className = className;
    }
    return styles;
  }

  private createDocxElement(element: ParsedElement, $: any): any {
    const baseStyle = this.styleMap.get(element.tag) ?? {};
    const customStyle = this.convertCssToDocx(element.styles);
    const finalStyle = { ...baseStyle, ...customStyle };

    switch (element.tag) {
      case 'img':
        return this.createImageParagraph(element);
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return new Paragraph({
          heading: finalStyle.heading,
          alignment: finalStyle.alignment ?? AlignmentType.LEFT,
          spacing: { before: 360, after: 360, line: 300, lineRule: 'auto' },
          children: [
            new TextRun({
              text: element.text,
              bold: finalStyle.bold !== false,
              size: finalStyle.size,
              color: finalStyle.color ?? '2c3e50',
              italics: finalStyle.italics,
              font: { name: FONT_FALLBACK },
            }),
          ],
        });
      case 'p':
        return new Paragraph({
          alignment: finalStyle.alignment ?? AlignmentType.LEFT,
          spacing: { line: 300, lineRule: 'auto', after: 240, before: 120 },
          children: this.createTextRuns(element, finalStyle, $),
        });
      case 'pre':
        return this.createCodeBlock(element, $);
      case 'blockquote':
        return new Paragraph({
          alignment: finalStyle.alignment ?? AlignmentType.LEFT,
          spacing: { line: 300, lineRule: 'auto', before: 360, after: 360 },
          indent: { left: 720, right: 360 },
          border: { left: { style: 'single', size: 12, color: '3498db' } },
          children: [
            new TextRun({
              text: element.text,
              italics: true,
              size: finalStyle.size ?? 22,
              color: finalStyle.color ?? '5a6c7d',
              font: { name: FONT_FALLBACK },
            }),
          ],
        });
      case 'ul':
      case 'ol':
        return this.createListElements(element, finalStyle, $);
      case 'table':
        return this.createTableElements(element, finalStyle, $);
      default:
        if (element.text.trim()) {
          const runOptions: any = {
            text: element.text,
            bold: finalStyle.bold,
            italics: finalStyle.italics,
            size: finalStyle.size,
            color: finalStyle.color,
            font: { name: FONT_FALLBACK },
          };
          if (finalStyle.underline) {
            runOptions.underline = finalStyle.underline;
          }
          return new Paragraph({
            spacing: { line: 300, lineRule: 'auto', after: 240, before: 120 },
            children: [new TextRun(runOptions)],
          });
        }
        return null;
    }
  }

  /** 创建图片段落。支持 data:image URI 和文件路径。失败时返回 null（不崩溃）。 */
  private createImageParagraph(element: ParsedElement): any {
    try {
      const run = this.createImageRun(element.src);
      if (!run) return null;
      return new Paragraph({
        spacing: { before: 200, after: 200 },
        children: [run],
      });
    } catch {
      return null;
    }
  }

  /** 从 src 创建 docx ImageRun；支持 data:image URI 和文件路径，失败返回 null。 */
  private createImageRun(src: string | undefined): ImageRun | null {
    try {
      if (!src) return null;

      // 解析图片二进制数据
      let imgData: Buffer;
      if (src.startsWith('data:image/')) {
        // data URI → base64 → Buffer
        const headerEnd = src.indexOf(',');
        if (headerEnd === -1) return null;
        imgData = Buffer.from(src.slice(headerEnd + 1), 'base64');
      } else {
        // 文件路径
        const resolved = path.isAbsolute(src) ? src : path.resolve(process.cwd(), src);
        imgData = readFileSync(resolved);
      }

      // 由内容签名探测尺寸与类型（不信任 mime/扩展名，防止伪造后缀的文件
      // 以错误格式嵌入 docx 导致图片损坏）。
      const dims = imageSize(imgData);
      if (!dims || !dims.width || !dims.height) return null;
      const type = dims.type === 'jpeg' ? 'jpg' : dims.type;
      // docx ImageRun 仅支持 png/jpg/gif/bmp；svg/webp 等静默跳过（不崩溃）
      if (type !== 'png' && type !== 'jpg' && type !== 'gif' && type !== 'bmp') return null;

      // 限制最大宽度为 600px（DOCX 页面可读范围），按比例缩放
      const maxW = 600;
      let w = dims.width;
      let h = dims.height;
      if (w > maxW) {
        h = Math.round(h * (maxW / w));
        w = maxW;
      }

      return new ImageRun({
        type,
        data: imgData,
        transformation: { width: w, height: h },
      });
    } catch {
      return null;
    }
  }

  private createTextRuns(element: ParsedElement, baseStyle: StyleMapping, $: any): any[] {
    const runs: any[] = [];
    const { html } = element;
    if (!html) {
      return [this.createSimpleTextRun(element.text, baseStyle)];
    }
    const sanitizedHtml = this.sanitizeHtml(html);
    if (!sanitizedHtml.includes('<')) {
      return [this.createSimpleTextRun(element.text, baseStyle)];
    }
    const $content = $('<div>' + sanitizedHtml + '</div>');
    if ($content.length === 0) {
      return [this.createSimpleTextRun(element.text, baseStyle)];
    }
    $content.contents().each((_i: number, node: any) => {
      this.processHtmlNode(node, baseStyle, runs, $);
    });
    return runs.length > 0 ? runs : [this.createSimpleTextRun(element.text, baseStyle)];
  }

  private createSimpleTextRun(text: string, baseStyle: StyleMapping): any {
    const { highlight, ...safeStyle } = baseStyle;
    return new TextRun({ text, ...safeStyle, ...(highlight && { highlight }) });
  }

  private processHtmlNode(node: any, baseStyle: StyleMapping, runs: any[], $: any): void {
    if (node.type === 'text') {
      this.processTextNode(node, baseStyle, runs);
    } else if (node.type === 'tag') {
      this.processTagNode(node, baseStyle, runs, $);
    }
  }

  private processTextNode(node: any, baseStyle: StyleMapping, runs: any[]): void {
    if (!node.data) return;
    const text = node.data;
    if (text.includes('\n')) {
      const parts = text.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (parts[i] || i === 0) {
          runs.push(this.nodeOptionsToRun({ text: parts[i], ...baseStyle }));
        }
        if (i < parts.length - 1) {
          runs.push(new TextRun({ text: '', break: 1 }));
        }
      }
    } else if (text.trim() || text.includes(' ')) {
      runs.push(this.nodeOptionsToRun({ text, ...baseStyle }));
    }
  }

  private nodeOptionsToRun(opts: any): TextRun {
    const font = { name: 'Microsoft YaHei, SimHei, Arial, sans-serif' };
    const { underline, text, bold, italics, size, color } = opts;
    return new TextRun({
      text,
      bold,
      italics,
      size,
      color,
      font,
      ...(underline && { underline }),
    });
  }

  private processTagNode(node: any, baseStyle: StyleMapping, runs: any[], $: any): void {
    // 行内图片：markdown ![](x) 渲染为 <p><img></p>，需产出 ImageRun
    if (node.name === 'img') {
      const src = $(node).attr('src');
      const run = this.createImageRun(src);
      if (run) runs.push(run);
      return;
    }
    const tagStyle = this.applyTagStyles(node, baseStyle, $);
    // cheerio 的 .text() 已完成 HTML 实体解码，无需再手动 decode
    const text = $(node).text();
    if (text.trim()) {
      runs.push(this.createNodeOptions(text, tagStyle, node.name));
    }
  }

  private applyTagStyles(node: any, baseStyle: StyleMapping, $: any): StyleMapping {
    const tagStyle = { ...baseStyle };
    const $node = $(node);
    this.applyBasicTagStyles(node.name, tagStyle);
    const nodeStyles = this.extractStyles($node);
    const nodeDocxStyle = this.convertCssToDocx(nodeStyles);
    Object.assign(tagStyle, nodeDocxStyle);
    return tagStyle;
  }

  private applyBasicTagStyles(tagName: string, tagStyle: StyleMapping): void {
    switch (tagName) {
      case 'strong':
      case 'b':
        tagStyle.bold = true;
        break;
      case 'em':
      case 'i':
        tagStyle.italics = true;
        break;
      case 'u':
        tagStyle.underline = { type: UnderlineType.SINGLE };
        break;
      case 'del':
      case 'strike':
        (tagStyle as any).strike = true;
        break;
      case 'code':
        tagStyle.size = 18;
        tagStyle.color = 'd73a49';
        break;
    }
  }

  private createNodeOptions(text: string, tagStyle: StyleMapping, tagName: string): any {
    const nodeOptions: any = {
      text,
      bold: tagStyle.bold,
      italics: tagStyle.italics,
      size: tagStyle.size,
      color: tagStyle.color,
    };
    nodeOptions.font = tagName === 'code' ? { name: 'Consolas' } : { name: FONT_FALLBACK };
    if (tagStyle.underline) {
      nodeOptions.underline = tagStyle.underline;
    }
    if ((tagStyle as any).strike) {
      nodeOptions.strike = (tagStyle as any).strike;
    }
    return nodeOptions;
  }

  private createListElements(element: ParsedElement, baseStyle: StyleMapping, $: any): any[] {
    const paragraphs: any[] = [];
    const sanitizedHtml = this.sanitizeHtml(element.html);
    const $list = $('<div>' + sanitizedHtml + '</div>');
    $list.find('li').each((i: number, li: any) => {
      const $li = $(li);
      const text = $li.text();
      const bullet = element.tag === 'ul' ? '• ' : `${i + 1}. `;
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({ text: bullet + text, size: baseStyle.size, color: baseStyle.color }),
          ],
          indent: { left: 720 },
        })
      );
    });
    return paragraphs;
  }

  /** HTML 表格 → 真正的 docx Table（等宽网格 + 表头加粗底纹）。 */
  private createTableElements(element: ParsedElement, baseStyle: StyleMapping, $: any): any {
    const sanitizedHtml = this.sanitizeHtml(element.html);
    const $table = $('<div>' + sanitizedHtml + '</div>');
    const cellTexts: string[][] = [];
    const headerFlags: boolean[] = [];
    let maxCols = 0;
    $table.find('tr').each((_i: number, tr: any) => {
      const $tr = $(tr);
      const cells: string[] = [];
      let hasTh = false;
      $tr.children('td, th').each((_j: number, cell: any) => {
        if (cell.tagName && cell.tagName.toLowerCase() === 'th') hasTh = true;
        cells.push($(cell).text().trim());
      });
      if (cells.length > 0) {
        cellTexts.push(cells);
        headerFlags.push(hasTh);
        maxCols = Math.max(maxCols, cells.length);
      }
    });
    if (cellTexts.length === 0 || maxCols === 0) return null;

    const rows = cellTexts.map((cells, i) => {
      // 补齐短行，保持网格矩形
      const padded = [...cells, ...Array(maxCols - cells.length).fill('')];
      const isHeader = headerFlags[i] || i === 0;
      return new TableRow({
        tableHeader: i === 0,
        children: padded.map(
          (text) =>
            new TableCell({
              shading: isHeader ? { fill: 'EDEDED' } : undefined,
              children: [
                new Paragraph({
                  spacing: { line: 276, lineRule: 'auto' },
                  children: [
                    new TextRun({
                      text,
                      bold: isHeader,
                      size: baseStyle.size ?? 22,
                      color: '000000',
                      font: { name: FONT_FALLBACK },
                    }),
                  ],
                }),
              ],
            }),
        ),
      });
    });

    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows,
    });
  }

  private createCodeBlock(element: ParsedElement, $: any): any[] {
    const paragraphs: any[] = [];
    const lines = element.text.split('\n');
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: ' ', size: 4 })],
        spacing: { after: 120 },
      })
    );
    for (const line of lines) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({ text: line ?? ' ', font: { name: 'Consolas' }, size: 20, color: '24292f' }),
          ],
          spacing: { line: 276, lineRule: 'auto', before: 0, after: 0 },
          indent: { left: 432, right: 432 },
          border: { left: { style: 'single', size: 4, color: 'e1e4e8' } },
          shading: { type: 'solid', color: 'f6f8fa' },
        })
      );
    }
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: ' ', size: 4 })],
        spacing: { before: 120 },
      })
    );
    return paragraphs;
  }

  private convertCssToDocx(styles: any): StyleMapping {
    const docxStyle: StyleMapping = {};
    this.convertFontSize(styles, docxStyle);
    this.convertColor(styles, docxStyle);
    this.convertBackgroundColor(styles, docxStyle);
    this.convertFontWeight(styles, docxStyle);
    this.convertFontStyle(styles, docxStyle);
    this.convertTextDecoration(styles, docxStyle);
    this.convertTextAlign(styles, docxStyle);
    return docxStyle;
  }

  private convertFontSize(styles: any, docxStyle: StyleMapping): void {
    const size = this.parseFontSize(styles['font-size']);
    if (size) docxStyle.size = size;
  }

  private convertColor(styles: any, docxStyle: StyleMapping): void {
    const color = this.parseColor(styles['color']);
    if (color) docxStyle.color = color;
  }

  private convertBackgroundColor(styles: any, docxStyle: StyleMapping): void {
    const bgColor = this.parseColor(styles['background-color']);
    if (bgColor) docxStyle.highlight = this.mapColorToHighlight(bgColor);
  }

  private mapColorToHighlight(bgColor: string): StyleMapping['highlight'] {
    const map: Record<string, StyleMapping['highlight']> = {
      '#ffff00': 'yellow', '#00ff00': 'green', '#00ffff': 'cyan', '#ff00ff': 'magenta',
      '#0000ff': 'blue', '#ff0000': 'red', '#000080': 'darkBlue', '#008080': 'darkCyan',
      '#008000': 'darkGreen', '#800080': 'darkMagenta', '#800000': 'darkRed',
      '#808000': 'darkYellow', '#808080': 'darkGray', '#c0c0c0': 'lightGray',
      '#000000': 'black', '#ffffff': 'white',
    };
    return map[bgColor.toLowerCase()] ?? 'yellow';
  }

  private convertFontWeight(styles: any, docxStyle: StyleMapping): void {
    const weight = styles['font-weight'];
    if (weight) {
      const w = weight.toLowerCase();
      if (w === 'bold' || w === 'bolder' || parseInt(w) >= 600) {
        docxStyle.bold = true;
      }
    }
  }

  private convertFontStyle(styles: any, docxStyle: StyleMapping): void {
    const style = styles['font-style'];
    if (style && style.toLowerCase() === 'italic') {
      docxStyle.italics = true;
    }
  }

  private convertTextDecoration(styles: any, docxStyle: StyleMapping): void {
    const decoration = styles['text-decoration'];
    if (decoration && decoration.toLowerCase().includes('underline')) {
      docxStyle.underline = { type: UnderlineType.SINGLE };
    }
  }

  private convertTextAlign(styles: any, docxStyle: StyleMapping): void {
    const align = styles['text-align'];
    if (!align) return;
    switch (align.toLowerCase()) {
      case 'center':
        docxStyle.alignment = AlignmentType.CENTER;
        break;
      case 'right':
        docxStyle.alignment = AlignmentType.RIGHT;
        break;
      case 'justify':
        docxStyle.alignment = AlignmentType.JUSTIFIED;
        break;
      default:
        docxStyle.alignment = AlignmentType.LEFT;
    }
  }

  private parseFontSize(value: string): number | null {
    if (!value) return null;
    const numValue = parseFloat(value.replace(/[^0-9.]/g, ''));
    if (isNaN(numValue)) return null;
    if (value.includes('pt')) return numValue * 2;
    if (value.includes('px')) return Math.round(numValue * 1.5);
    if (value.includes('em')) return Math.round(numValue * 24);
    return Math.round(numValue * 2);
  }

  private parseColor(value: string): string | null {
    if (!value) return null;
    value = value.trim();
    if (value.startsWith('#')) {
      let hex = value.substring(1);
      if (hex.length === 3) {
        hex = hex.split('').map((c) => c + c).join('');
      }
      return hex.toUpperCase();
    }
    const rgbMatch = value.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
    if (rgbMatch) {
      const r = parseInt(rgbMatch[1]).toString(16).padStart(2, '0');
      const g = parseInt(rgbMatch[2]).toString(16).padStart(2, '0');
      const b = parseInt(rgbMatch[3]).toString(16).padStart(2, '0');
      return (r + g + b).toUpperCase();
    }
    const colorMap: Record<string, string> = {
      red: 'FF0000', green: '008000', blue: '0000FF', black: '000000', white: 'FFFFFF',
      yellow: 'FFFF00', orange: 'FFA500', purple: '800080', gray: '808080', grey: '808080',
      pink: 'FFC0CB', brown: 'A52A2A', cyan: '00FFFF', magenta: 'FF00FF', lime: '00FF00',
      navy: '000080', maroon: '800000', olive: '808000', teal: '008080', silver: 'C0C0C0',
    };
    return colorMap[value.toLowerCase()] ?? null;
  }
}
