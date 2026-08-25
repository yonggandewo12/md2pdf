import { PythonScriptService, ScriptServiceCallResult } from './python-script-service.js';

export type PdfServiceCallResult = ScriptServiceCallResult;

/**
 * PDF 操作服务（加密/解密）：通过子进程调用 scripts/pdf/run.py。
 * 合并/拆分/提取/压缩走纯 JS（src/pdf-ops.ts），不经过此服务。
 */
export class PdfService extends PythonScriptService {
  constructor() {
    super('scripts/pdf/run.py', 'scripts/pdf', 'PDF', 'PyMuPDF');
  }
}
