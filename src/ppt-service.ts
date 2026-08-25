import { PythonScriptService, ScriptServiceCallResult } from './python-script-service.js';

export type PptServiceCallResult = ScriptServiceCallResult;

/**
 * PPTX 读取/编辑服务：通过子进程调用
 * scripts/ppt-master/scripts/ppt_mcp/run.py。
 *
 * 与 generate_presentation（PptMasterService）分工：PptMasterService 负责
 * 从 SVG 生成新 PPTX；本服务负责读取/编辑已有 PPTX（复用 pptx_to_svg、
 * source_to_md、template_fill_pptx 等现成脚本库）。
 */
export class PptService extends PythonScriptService {
  constructor() {
    super(
      'scripts/ppt-master/scripts/ppt_mcp/run.py',
      'scripts/ppt-master/scripts/ppt_mcp',
      'PPTX',
      'python-pptx and PyMuPDF',
    );
  }
}
