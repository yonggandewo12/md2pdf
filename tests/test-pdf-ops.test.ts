/**
 * PDF 操作工具单元测试。
 * - 纯 JS 路径（merge/split/extract/compress/parsePageRanges）直接测。
 * - encrypt/decrypt 走 PyMuPDF 子进程，依赖嵌入运行时。
 */
import { describe, expect, it } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { PDFDocument } from 'pdf-lib';
import { mergePdfs, splitPdf, extractPages, compressPdf, parsePageRanges } from '../src/pdf-ops.js';
import { PdfService } from '../src/pdf-service.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'pdf-ops-test-'));

/** 用 pdf-lib 生成一个 N 页的 PDF。 */
async function makePdf(dir: string, name: string, pageCount: number): Promise<string> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([200, 200]);
    page.drawText(`${name} p${i + 1}`, { x: 20, y: 100 });
  }
  const p = path.join(dir, name);
  await fs.writeFile(p, await doc.save());
  return p;
}

describe('parsePageRanges', () => {
  it('解析 "1-3,5,7-9" → [0,1,2,4,6,7,8]', () => {
    expect(parsePageRanges('1-3,5,7-9', 9)).toEqual([0, 1, 2, 4, 6, 7, 8]);
  });

  it('单个页 + 反向去重', () => {
    expect(parsePageRanges('2,2,4', 5)).toEqual([1, 3]);
  });

  it('超出总页数的页码被 clamp', () => {
    expect(parsePageRanges('1,99', 3)).toEqual([0, 2]);
  });

  it('非法语法（倒序区间）抛错', () => {
    expect(() => parsePageRanges('3-1', 5)).toThrow(/descending/);
  });

  it('非法语法（非数字）抛错', () => {
    expect(() => parsePageRanges('a,b', 5)).toThrow(/Invalid pageRanges/);
  });
});

describe('PDF 合并/拆分/提取/压缩（纯 JS pdf-lib）', () => {
  it('mergePdfs 合并多 PDF，页数累加', async () => {
    const dir = await tmp();
    const a = await makePdf(dir, 'a.pdf', 2);
    const b = await makePdf(dir, 'b.pdf', 3);
    const out = path.join(dir, 'merged.pdf');
    const r = await mergePdfs([a, b], out);
    expect(r.success).toBe(true);
    expect(r.pageCount).toBe(5);
    const loaded = await PDFDocument.load(await fs.readFile(out));
    expect(loaded.getPageCount()).toBe(5);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('mergePdfs 空数组或缺失文件返回错误', async () => {
    const dir = await tmp();
    const out = path.join(dir, 'm.pdf');
    const rEmpty = await mergePdfs([], out);
    expect(rEmpty.success).toBe(false);
    const rMissing = await mergePdfs([path.join(dir, 'no.pdf')], out);
    expect(rMissing.success).toBe(false);
    expect(rMissing.error).toContain('not found');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('splitPdf 按区间拆分多文件', async () => {
    const dir = await tmp();
    const src = await makePdf(dir, 'src.pdf', 5);
    const outDir = path.join(dir, 'split');
    const r = await splitPdf(src, '1-2,4', outDir, 'part');
    expect(r.success).toBe(true);
    expect(r.outputFiles?.length).toBe(2);
    const sizes = r.outputFiles!.map((f) => f.pageCount);
    expect(sizes).toEqual([2, 1]);
    for (const f of r.outputFiles!) {
      const loaded = await PDFDocument.load(await fs.readFile(f.path));
      expect(loaded.getPageCount()).toBe(f.pageCount);
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('extractPages 提取指定页到单文件', async () => {
    const dir = await tmp();
    const src = await makePdf(dir, 'src.pdf', 5);
    const out = path.join(dir, 'ext.pdf');
    const r = await extractPages(src, '2-4', out);
    expect(r.success).toBe(true);
    expect(r.pageCount).toBe(3);
    const loaded = await PDFDocument.load(await fs.readFile(out));
    expect(loaded.getPageCount()).toBe(3);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('compressPdf 重新打包，输出可读且页数不变', async () => {
    const dir = await tmp();
    const src = await makePdf(dir, 'src.pdf', 3);
    const out = path.join(dir, 'comp.pdf');
    const r = await compressPdf(src, out, true);
    expect(r.success).toBe(true);
    const loaded = await PDFDocument.load(await fs.readFile(out));
    expect(loaded.getPageCount()).toBe(3);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('PDF 加密/解密（PyMuPDF 子进程）', () => {
  const svc = new PdfService();

  it('encrypt 生成可加密文件，decrypt 用正确密码还原明文', async () => {
    const dir = await tmp();
    const src = await makePdf(dir, 'plain.pdf', 1);
    const enc = path.join(dir, 'enc.pdf');
    const r = await svc.call('encrypt', {
      pdfPath: src,
      outputPath: enc,
      userPassword: 'secret123',
      permissions: { printing: true },
    });
    expect(r.success).toBe(true);
    const encBytes = await fs.readFile(enc);
    // 加密后文件应存在且非空
    expect(encBytes.length).toBeGreaterThan(0);

    const out = path.join(dir, 'dec.pdf');
    const dec = await svc.call('decrypt', { pdfPath: enc, password: 'secret123', outputPath: out });
    expect(dec.success).toBe(true);
    const loaded = await PDFDocument.load(await fs.readFile(out));
    expect(loaded.getPageCount()).toBe(1);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('decrypt 错误密码返回失败且不写输出', async () => {
    const dir = await tmp();
    const src = await makePdf(dir, 'plain.pdf', 1);
    const enc = path.join(dir, 'enc.pdf');
    await svc.call('encrypt', { pdfPath: src, outputPath: enc, userPassword: 'pw' });
    const out = path.join(dir, 'dec.pdf');
    const bad = await svc.call('decrypt', { pdfPath: enc, password: 'wrong', outputPath: out });
    expect(bad.success).toBe(false);
    expect(bad.error).toContain('Invalid password');
    let exists = true;
    try {
      await fs.access(out);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('encrypt 缺失文件返回失败', async () => {
    const dir = await tmp();
    const r = await svc.call('encrypt', { pdfPath: path.join(dir, 'no.pdf'), userPassword: 'pw' });
    expect(r.success).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
