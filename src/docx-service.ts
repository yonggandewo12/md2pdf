/**
 * DOCX 服务：生成新文档（纯 JS docx 包）+ 编辑已有文档（python-docx 子进程）。
 *
 * - 生成：createDocument / convertMdToDocx / convertHtmlToDocx，基于 docx npm 包
 *   （MIT，纯 JS），HTML→DOCX 复用 HtmlToDocxConverter。
 * - 编辑：openExisting 类动作走 scripts/docx/run.py（python-docx，MIT），经
 *   PythonScriptRunner 子进程调用，镜像 Excel 模式。python-docx 已打进
 *   runtime 子包（scripts/build-platform-package.py 的 REQUIREMENTS_FILES）。
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { PythonScriptRunner } from './python-runner.js';
import { HtmlToDocxConverter } from './html-to-docx.js';
import { MdConverter } from './md-converter.js';

const htmlToDocx = new HtmlToDocxConverter();
// MdConverter 无状态，模块级复用避免每次调用重复构造。
const mdConverter = new MdConverter();

export interface DocxCreateOptions {
  title?: string;
}

export interface DocxMdOptions {
  /** 无 outputPath 时用作默认输出文件名（sanitized）。 */
  title?: string;
  embedImages?: boolean;
}

export interface DocxResult {
  success: boolean;
  outputPath?: string;
  message?: string;
  error?: string;
  details?: { processingTime: number; fileSize?: number };
}

export interface DocxEditResult {
  success: boolean;
  data?: unknown;
  message?: string;
  error?: string;
}

const SCRIPTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts');
const DOCX_RUN_PY = path.join(SCRIPTS_ROOT, 'docx', 'run.py');

/** HTML 转义，防止 title 等插入 HTML 上下文时破坏结构或注入标签。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class DocxService {
  private pythonRunner: PythonScriptRunner | null = null;
  private pythonRunning = false;

  /** 懒创建 Python 子进程 runner（避免启动时同步 probe Python）。 */
  private getRunner(): PythonScriptRunner {
    if (!this.pythonRunner) {
      this.pythonRunner = new PythonScriptRunner();
    }
    return this.pythonRunner;
  }

  // ─────────────────────── 生成新文档 ───────────────────────

  /** 从 HTML 或纯文本内容创建 .docx。非 HTML 内容自动包装为完整 HTML。 */
  async createDocument(
    content: string,
    outputPath?: string,
    opts: DocxCreateOptions = {},
  ): Promise<DocxResult> {
    const start = Date.now();
    try {
      const finalOutputPath = await this.resolveOutputPath(outputPath, opts.title, '.docx');
      let htmlContent = content;
      if (!content.includes('<html') && !content.includes('<!DOCTYPE')) {
        htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>${escapeHtml(opts.title || 'Document')}</title>
</head>
<body>
${content}
</body>
</html>`;
      }
      const buffer = await htmlToDocx.convertHtmlToDocx(htmlContent);
      await fs.mkdir(path.dirname(finalOutputPath), { recursive: true });
      await fs.writeFile(finalOutputPath, buffer);
      return {
        success: true,
        outputPath: finalOutputPath,
        message: 'Word 文档创建完成',
        details: { processingTime: Date.now() - start, fileSize: buffer.length },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 将 Markdown 内容转为 .docx。链路：markdown → HTML（复用 MdConverter）→ DOCX。
   *
   * 若提供 `renderMermaid` 回调（由调用方注入 PdfConverter 的渲染能力），会先把
   * HTML 中的 mermaid 块渲染成图片再转 DOCX；渲染失败或未提供时降级保留原文
   * （mermaid 源码以文本呈现），绝不因 mermaid 失败而中断转换。
   */
  async convertMdToDocx(
    mdContent: string,
    baseDir?: string,
    outputPath?: string,
    opts: DocxMdOptions = {},
    renderMermaid?: (html: string) => Promise<{ html: string; count: number }>,
  ): Promise<DocxResult> {
    const start = Date.now();
    try {
      const finalOutputPath = await this.resolveOutputPath(outputPath, opts.title, '.docx');
      const { html } = await mdConverter.convertMdToHtml(
        mdContent,
        { embedImages: opts.embedImages ?? true, toc: false },
        baseDir,
      );

      let finalHtml = html;
      if (renderMermaid && /class="[^"]*\bmermaid\b/.test(html)) {
        try {
          const rendered = await renderMermaid(html);
          finalHtml = rendered.html;
        } catch {
          // 渲染失败 → 降级保留原文（mermaid 块在 docx 中以源码文本呈现）
        }
      }

      const buffer = await htmlToDocx.convertHtmlToDocx(finalHtml);
      await fs.mkdir(path.dirname(finalOutputPath), { recursive: true });
      await fs.writeFile(finalOutputPath, buffer);
      return {
        success: true,
        outputPath: finalOutputPath,
        message: 'Markdown 转 Word 文档完成',
        details: { processingTime: Date.now() - start, fileSize: buffer.length },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 将 HTML 内容转为 .docx。 */
  async convertHtmlToDocx(
    htmlContent: string,
    outputPath?: string,
  ): Promise<DocxResult> {
    const start = Date.now();
    try {
      const finalOutputPath = await this.resolveOutputPath(outputPath, undefined, '.docx');
      const buffer = await htmlToDocx.convertHtmlToDocx(htmlContent);
      await fs.mkdir(path.dirname(finalOutputPath), { recursive: true });
      await fs.writeFile(finalOutputPath, buffer);
      return {
        success: true,
        outputPath: finalOutputPath,
        message: 'HTML 转 Word 文档完成',
        details: { processingTime: Date.now() - start, fileSize: buffer.length },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // ─────────────────────── 编辑已有文档（python-docx） ───────────────────────

  /**
   * 在已有 .docx 上执行编辑动作。action 对应 scripts/docx/run.py 的 ACTIONS：
   * read_document / list_tables / edit_paragraph / add_paragraph / insert_image /
   * insert_table / change_style / set_document_title / available_styles。
   */
  async editDocument(action: string, params: Record<string, unknown>): Promise<DocxEditResult> {
    if (this.pythonRunning) {
      return { success: false, error: 'DOCX edit already in progress' };
    }
    this.pythonRunning = true;
    try {
      const runner = this.getRunner();
      await runner.checkPython();
      // 走 stdin 传输 params，规避命令行参数长度限制（Windows ~32KB），与 excel-service 一致
      const result = await runner.runPath(DOCX_RUN_PY, ['--action', action], {
        timeoutMs: 60000,
        stdin: JSON.stringify(params),
      });
      const stdout = result.stdout?.trim();
      if (!stdout) {
        return { success: false, error: `DOCX script returned no output: ${result.stderr?.trim()}` };
      }
      let parsed: { success?: boolean; data?: unknown; error?: string };
      try {
        parsed = JSON.parse(stdout);
      } catch {
        return {
          success: false,
          error: `DOCX script returned invalid JSON. stdout: ${stdout.slice(0, 500)}`,
        };
      }
      if (parsed.success) {
        return { success: true, data: parsed.data };
      }
      return { success: false, error: parsed.error ?? 'DOCX edit failed' };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.pythonRunning = false;
    }
  }

  /** 检查 python-docx 依赖是否可用（供 tools 调用前校验/诊断）。 */
  async checkDependencies(): Promise<{ available: boolean; version?: string; error?: string }> {
    try {
      const runner = this.getRunner();
      await runner.checkPython();
      const result = await runner.runPath(DOCX_RUN_PY, ['--check'], { timeoutMs: 30000 });
      const stdout = result.stdout?.trim();
      if (stdout) {
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.success) {
            return { available: true, version: parsed.data?.['python-docx'] };
          }
          return { available: false, error: parsed?.error ?? 'python-docx unavailable' };
        } catch {
          // fall through to generic failure below
        }
      }
      return { available: false, error: 'python-docx unavailable' };
    } catch (error) {
      return { available: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // ─────────────────────── 工具函数 ───────────────────────

  private async resolveOutputPath(
    outputPath: string | undefined,
    title: string | undefined,
    ext: string,
  ): Promise<string> {
    if (outputPath && path.isAbsolute(outputPath)) {
      return outputPath;
    }
    const base = outputPath || `${title ? title.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_') : 'document'}`;
    const name = base.endsWith(ext) ? base : `${base}${ext}`;
    if (path.isAbsolute(name)) {
      return name;
    }
    return path.resolve(process.cwd(), name);
  }
}

// 模块级懒创建实例（与 index.ts 的 getExcelService 模式一致）
let _docxService: DocxService | null = null;
export function getDocxService(): DocxService {
  if (!_docxService) {
    _docxService = new DocxService();
  }
  return _docxService;
}
