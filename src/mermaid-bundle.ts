/**
 * 内置 mermaid 运行时定位。
 *
 * mermaid.min.js 来自 npm 依赖 mermaid@10（随包安装），渲染只使用本地文件，
 * 不访问任何 CDN。消费方：md→html 内联脚本、md→pdf / docx 的 addScriptTag。
 */
import { createRequire } from 'module';
import { readFileSync, statSync } from 'fs';

// 真实 mermaid.min.js ~3.3MB；下限用于拦截截断/损坏的安装产物
const MERMAID_MIN_SIZE = 50_000;

let cachedPath: string | null | undefined;

/** 返回内置 mermaid.min.js 的绝对路径；不可用时返回 null（调用方降级跳过渲染）。 */
export function mermaidBundlePath(): string | null {
  if (cachedPath === undefined) {
    try {
      const require = createRequire(import.meta.url);
      const p = require.resolve('mermaid/dist/mermaid.min.js');
      const st = statSync(p);
      cachedPath = st.isFile() && st.size > MERMAID_MIN_SIZE ? p : null;
    } catch {
      cachedPath = null;
    }
  }
  return cachedPath;
}

/** 返回内置 mermaid.min.js 源码（供 HTML 内联）；不可用时返回 null。 */
export function mermaidBundleSource(): string | null {
  const p = mermaidBundlePath();
  if (!p) return null;
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** 内联防护：源码中字面 `</script>` 会提前闭合宿主标签，转义为无效序列。 */
export function escapeInlineScript(code: string): string {
  return code.replace(/<\/script/gi, '<\\/script');
}
