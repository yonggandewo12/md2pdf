import { existsSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { PythonScriptRunner } from './python-runner.js';

export interface ScriptServiceCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
  code?: string;
  errorType?: string;
  details?: {
    processingTime: number;
  };
}

/**
 * Python 子进程服务基类，封装 run.py 入脚调用的通用逻辑：
 *   - 定位包根目录
 *   - 依赖自检（--check）缓存
 *   - stdin JSON 协议调用与输出解析
 *
 * PdfService / PptService / ImageService 继承此类，仅提供脚本路径与标签。
 */
export abstract class PythonScriptService {
  protected readonly runner: PythonScriptRunner;
  protected readonly runScript: string;
  protected readonly label: string;
  protected readonly depHint: string;
  private depChecked = false;

  constructor(runScriptRelative: string, scriptsRootRelative: string, label: string, depHint: string) {
    const pkgRoot = this.resolvePackageRoot();
    this.runScript = path.join(pkgRoot, ...runScriptRelative.split('/'));
    const scriptsRoot = path.join(pkgRoot, ...scriptsRootRelative.split('/'));
    this.runner = new PythonScriptRunner(undefined, scriptsRoot);
    this.label = label;
    this.depHint = depHint;
  }

  private resolvePackageRoot(): string {
    const currentFile = fileURLToPath(import.meta.url);
    let dir = path.dirname(currentFile);
    while (dir !== path.dirname(dir)) {
      if (existsSync(path.join(dir, 'package.json'))) {
        return dir;
      }
      dir = path.dirname(dir);
    }
    throw new Error('Cannot locate package root (no package.json ancestor)');
  }

  async checkDeps(): Promise<void> {
    if (this.depChecked) return;
    if (!existsSync(this.runScript)) {
      throw new Error(`${this.label} entry script not found: ${this.runScript}`);
    }
    const result = await this.runner.runPath(this.runScript, ['--check'], { timeoutMs: 15000 });
    if (result.exitCode !== 0) {
      throw new Error(
        `${this.label} dependencies not ready (exit ${result.exitCode}). ` +
          `Ensure ${this.depHint} is installed.\n${result.stderr}`
      );
    }
    this.depChecked = true;
  }

  async call(action: string, params: Record<string, unknown>, timeoutMs = 60000): Promise<ScriptServiceCallResult> {
    const start = Date.now();
    await this.checkDeps();
    const paramsJson = JSON.stringify(params);
    const result = await this.runner.runPath(this.runScript, ['--action', action], {
      timeoutMs,
      stdin: paramsJson,
    });
    const processingTime = Date.now() - start;

    const stdout = result.stdout.trim();
    if (!stdout) {
      return {
        success: false,
        error: `${this.label} action ${action} produced no output. stderr: ${result.stderr.slice(0, 500)}`,
        code: 'NO_OUTPUT',
        details: { processingTime },
      };
    }

    try {
      const parsed = JSON.parse(stdout) as {
        success?: boolean;
        data?: unknown;
        error?: string;
        code?: string;
        error_type?: string;
      };
      return {
        success: parsed.success === true,
        data: parsed.data,
        error: parsed.error,
        code: parsed.code,
        // Python 协议输出 snake_case error_type，归一化为 camelCase 接口字段
        errorType: parsed.error_type,
        details: { processingTime },
      };
    } catch {
      return {
        success: false,
        error: `Failed to parse ${this.label} output: ${stdout.slice(0, 500)}`,
        code: 'BAD_OUTPUT',
        details: { processingTime },
      };
    }
  }
}
