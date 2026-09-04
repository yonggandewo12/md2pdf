/**
 * 归档服务：archive_compress / archive_extract 工具的实现后端。
 *
 * 基于 fflate（纯 JS，零原生依赖，跨平台一致）：
 * - 压缩：文件/目录 → zip 或 tar（tar 不压缩，仅打包）；
 * - 解压：zip → 目录（tar 解压暂未内置，报错提示用系统工具）。
 *
 * 目录会递归收集文件，保留相对路径。防路径穿越：解压时丢弃 `..` 与绝对路径组件。
 *
 * @author Liang.Xu
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { unzipSync, zipSync, type Unzipped } from 'fflate';

type ZipLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/** POSIX ustar 八进制字段（宽度含结尾 NUL）。 */
function toOctal(value: number, width: number): string {
  return value.toString(8).padStart(width, '0').slice(-width);
}

/**
 * 将 tar 条目路径拆分为 ustar name(≤100B) + prefix(≤155B)。
 * ustar 用 prefix 字段（bytes 345-499）扩展路径，合计上限 255 字节；
 * 超过该上限或单段文件名 >100 字节时抛错（静默截断会造成归档内文件名损坏）。
 */
function splitTarName(name: string): { name: string; prefix: string } {
  const bytes = (n: string) => new TextEncoder().encode(n).length;
  if (bytes(name) <= 100) return { name, prefix: '' };
  if (bytes(name) > 255) {
    throw new Error(`tar 条目路径超过 ustar 上限 255 字节，无法归档: ${name}`);
  }
  // 在 '/' 处拆分：prefix ≤155B 且 name ≤100B；从最靠近尾部的 '/' 向前找
  for (let i = name.lastIndexOf('/'); i > 0; i = name.lastIndexOf('/', i - 1)) {
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (bytes(prefix) <= 155 && bytes(rest) <= 100) {
      return { name: rest, prefix };
    }
  }
  throw new Error(`tar 单段文件名超过 100 字节，无法归档: ${name}`);
}

/** 生成一个常规文件的 ustar tar header（512 字节）。 */
function tarHeader(name: string, size: number): Uint8Array {
  const enc = new TextEncoder();
  const header = new Uint8Array(512);
  const { name: shortName, prefix } = splitTarName(name);
  header.set(enc.encode(shortName).subarray(0, 100), 0);
  header.set(enc.encode('0000644\x00'), 100); // mode
  header.set(enc.encode('0000000\x00'), 108); // uid
  header.set(enc.encode('0000000\x00'), 116); // gid
  header.set(enc.encode(`${toOctal(size, 11)}\x00`), 124); // size
  header.set(enc.encode(`${toOctal(Math.floor(Date.now() / 1000), 11)}\x00`), 136); // mtime
  header.set(enc.encode('        '), 148); // checksum 占位
  header[156] = 0x30; // typeflag '0' = regular file
  header.set(enc.encode('ustar\x00'), 257); // magic
  header.set(enc.encode('00'), 263); // version
  if (prefix) header.set(enc.encode(prefix).subarray(0, 155), 345); // prefix 字段
  // checksum = header 所有字节和，6 位八进制 + NUL + 空格
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  header.set(enc.encode(`${toOctal(sum, 6)}\x00 `), 148);
  return header;
}

/** 手写 POSIX ustar 打包（fflate 8 已移除 tar 支持，无新增依赖）。 */
function writeTar(files: Map<string, Uint8Array>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [name, data] of files) {
    blocks.push(tarHeader(name, data.length));
    blocks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) blocks.push(new Uint8Array(pad));
  }
  blocks.push(new Uint8Array(1024)); // 两个 512 块 EOF
  const total = blocks.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

export interface ArchiveCompressOptions {
  /** 要打包的文件或目录路径。 */
  paths: string[];
  outputPath: string;
  /** zip / tar。 */
  format?: 'zip' | 'tar';
  /** zip 压缩等级 0-9（默认 6）。 */
  level?: number;
}

export interface ArchiveExtractOptions {
  archivePath: string;
  outputDir: string;
  format?: 'zip';
}

export interface ArchiveResult {
  success: boolean;
  outputPath?: string;
  fileCount?: number;
  fileSize?: number;
  entries?: string[];
  error?: string;
  details?: { processingTime: number };
}

async function collectFiles(target: string): Promise<[string, Buffer][]> {
  const stat = await fs.stat(target);
  if (stat.isFile()) {
    const rel = path.basename(target);
    return [[rel, await fs.readFile(target)]];
  }
  if (!stat.isDirectory()) {
    throw new Error(`不支持的路径类型: ${target}`);
  }
  const out: [string, Buffer][] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, ent.name);
      // 归档内路径统一用 POSIX 分隔符（/），确保 Windows 生成的 zip/tar
      // 在 macOS/Linux 解压时路径不损坏（path.join 在 win32 用 \）
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await walk(full, rel);
      } else if (ent.isFile()) {
        out.push([rel, await fs.readFile(full)]);
      }
      // symlink / socket 等忽略
    }
  };
  await walk(target, path.basename(target));
  return out;
}

/** 压缩文件/目录为 zip 或 tar。 */
export async function compressArchive(options: ArchiveCompressOptions): Promise<ArchiveResult> {
  const start = Date.now();
  const details = () => ({ processingTime: Date.now() - start });
  try {
    if (!options.paths || options.paths.length === 0) {
      throw new Error('paths 不能为空');
    }
    const format = options.format ?? 'zip';
    if (!['zip', 'tar'].includes(format)) {
      throw new Error(`不支持的归档格式: ${format}（仅 zip/tar）`);
    }

    const files: [string, Buffer][] = [];
    for (const p of options.paths) {
      const abs = path.resolve(p);
      try {
        await fs.access(abs);
      } catch {
        throw new Error(`路径不存在: ${p}`);
      }
      files.push(...(await collectFiles(abs)));
    }
    if (files.length === 0) {
      throw new Error('没有可打包的文件');
    }

    // 去重：同一相对路径出现多次时后者覆盖前者
    const fileMap = new Map<string, Uint8Array>();
    for (const [rel, buf] of files) fileMap.set(rel, buf);

    const outBytes =
      format === 'zip'
        ? zipSync(Object.fromEntries(fileMap), { level: (options.level ?? 6) as ZipLevel })
        : writeTar(fileMap);

    const resolvedOutput = path.resolve(options.outputPath);
    await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });
    await fs.writeFile(resolvedOutput, outBytes);

    return {
      success: true,
      outputPath: resolvedOutput,
      fileCount: fileMap.size,
      fileSize: outBytes.length,
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

/** 安全归一化归档内条目路径：丢弃绝对路径与 `..`，防路径穿越。 */
function sanitizeEntry(name: string): string | null {
  const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

/** 解压 zip 到目录。 */
export async function extractArchive(options: ArchiveExtractOptions): Promise<ArchiveResult> {
  const start = Date.now();
  const details = () => ({ processingTime: Date.now() - start });
  try {
    const format = options.format ?? 'zip';
    if (format !== 'zip') {
      throw new Error(`暂不支持解压 ${format}，请使用系统工具`);
    }
    const absArchive = path.resolve(options.archivePath);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(absArchive);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new Error(code === 'ENOENT' ? `归档文件不存在: ${options.archivePath}` : `归档读取失败 (${code ?? 'UNKNOWN'}): ${options.archivePath}`);
    }

    let entries: Unzipped;
    try {
      entries = unzipSync(bytes);
    } catch {
      throw new Error(`无法解析 ZIP 归档（可能已损坏或不是 zip）: ${options.archivePath}`);
    }

    const outDir = path.resolve(options.outputDir);
    await fs.mkdir(outDir, { recursive: true });

    const written: string[] = [];
    const names = Object.keys(entries).sort();
    for (const name of names) {
      const safe = sanitizeEntry(name);
      if (!safe) continue; // 丢弃穿越路径，不报错
      const data = entries[name];
      if (data.length === 0 && /\/$/.test(name)) continue; // 目录条目
      const dest = path.join(outDir, safe);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, data);
      written.push(safe);
    }

    return {
      success: true,
      outputPath: outDir,
      fileCount: written.length,
      entries: written.slice(0, 200),
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
