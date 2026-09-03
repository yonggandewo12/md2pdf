/**
 * OCR 运行时共享库（PDFium / ONNX Runtime）自动定位。
 *
 * 契约：
 * - 显式配置优先：process.env 中已设置的 PDFIUM_LIB_PATH / ORT_DYLIB_PATH
 *   不会被覆盖。
 * - 未设置时从随 npm 一起安装的包中定位（`npm i -g` 即得完整 OCR 运行时，
 *   无需手动下载）：
 *   - PDFium ← `@llamaindex/liteparse-<platform>` 平台子包目录（npm 已按
 *     平台装好匹配项，逐个候选探测，天然覆盖 gnu/musl/arm64/x64 变体）；
 *   - ONNX Runtime ← `onnxruntime-node` 单包内置三平台库，按
 *     process.platform / process.arch 拼子路径。
 * - Best-effort：任一库定位失败时对应变量保持未设置，OCR 调用按既有行为
 *   回退原生提取并告警，不影响其他工具。
 * - 幂等：进程内只解析一次（成功结果缓存；失败不缓存，供后续重试）。
 *
 * 环境变量须在 OCR 调用前就位于 process.env：原生层在调用时读取。
 *
 * @author Liang.Xu
 */
import { createRequire } from 'module';
import { existsSync } from 'fs';
import * as path from 'path';

const require = createRequire(import.meta.url);

/** liteparse 平台子包目录中共享库的候选文件名（按平台命名差异全覆盖）。 */
const PDFIUM_LIB_NAMES = [
  'libpdfium.dylib',
  'libpdfium.so',
  'pdfium.dll',
  'libpdfium.dll',
];

/** onnxruntime-node 内置库的共享文件名（指向版本化实体的稳定 symlink）。 */
const ORT_LIB_BY_PLATFORM: Record<string, string> = {
  darwin: 'libonnxruntime.1.dylib',
  linux: 'libonnxruntime.so.1',
  win32: 'onnxruntime.dll',
};

const ORT_DIR_BY_PLATFORM: Record<string, string> = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'win32',
};

/** 在目录里找第一个存在的共享库文件名。 */
function findLibInDir(dir: string, names: string[]): string | undefined {
  return names.find((name) => existsSync(path.join(dir, name)));
}

/**
 * 定位 PDFium 共享库所在目录：解析 `@llamaindex/liteparse` 主包声明的
 * optionalDependencies 平台子包名，逐个尝试 require.resolve（已安装者才会
 * 命中），命中目录内须实际存在共享库文件。
 */
function locatePdfiumDir(): string | undefined {
  const liteparsePkgDir = path.dirname(
    require.resolve('@llamaindex/liteparse/package.json'),
  );
  const pkg = require('@llamaindex/liteparse/package.json');
  const platformPkgs: string[] = Object.keys(
    pkg.optionalDependencies ?? {},
  );
  for (const name of platformPkgs) {
    try {
      const dir = path.dirname(require.resolve(`${name}/package.json`));
      if (dir === liteparsePkgDir) continue;
      if (findLibInDir(dir, PDFIUM_LIB_NAMES)) return dir;
    } catch {
      // 未安装的平台子包：跳过
    }
  }
  return undefined;
}

/** 定位 onnxruntime-node 内置的 ONNX Runtime 共享库文件完整路径。 */
function locateOrtDylib(): string | undefined {
  const libName = ORT_LIB_BY_PLATFORM[process.platform];
  const platformDir = ORT_DIR_BY_PLATFORM[process.platform];
  if (!libName || !platformDir) return undefined;
  const pkgDir = path.dirname(require.resolve('onnxruntime-node/package.json'));
  const dylib = path.join(
    pkgDir,
    'bin',
    'napi-v6',
    platformDir,
    process.arch,
    libName,
  );
  return existsSync(dylib) ? dylib : undefined;
}

let resolved = false;

/**
 * 确保 OCR 运行时环境变量就绪（幂等、显式配置优先、best-effort 静默）。
 * 在每次走 OCR 的 `processPdfWithOcr` 调用前执行。
 */
export function ensureOcrRuntimeEnv(): void {
  if (resolved) return;
  resolved = true;
  try {
    if (!process.env.PDFIUM_LIB_PATH) {
      const dir = locatePdfiumDir();
      if (dir) process.env.PDFIUM_LIB_PATH = dir;
    }
    if (!process.env.ORT_DYLIB_PATH) {
      const dylib = locateOrtDylib();
      if (dylib) process.env.ORT_DYLIB_PATH = dylib;
    }
  } catch {
    // npm 包缺失或目录结构异常：保持变量未设置，走回退路径
  }
}
