/**
 * md→PDF 分页质量增强测试：hr 清理（裸 --- 空白页根治）、横向图 landscape 建议、
 * pdf-probe 页数/尺寸/空白页探测。浏览器 e2e 需要可用 Chromium。
 */
import { describe, expect, it } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { MdConverter } from '../src/md-converter.js';
import { stripHrBeforeHeadings, buildLandscapeWarning } from '../src/md-converter.js';
import { probePdf, countContentOps } from '../src/pdf-probe.js';

describe('stripHrBeforeHeadings（hr 清理）', () => {
  it('删除紧邻 h1/h2 的 hr 并计数', () => {
    const body = '<p>a</p><hr>\n<h2>第二节</h2><p>b</p><hr />\n<h1>封面</h1>';
    const { body: out, removed } = stripHrBeforeHeadings(body);
    expect(removed).toBe(2);
    expect(out).not.toContain('<hr');
    expect(out).toContain('<h2>第二节</h2>');
    expect(out).toContain('<h1>封面</h1>');
  });

  it('正文中间的 hr 与后随非标题元素的 hr 保留', () => {
    const body = '<p>a</p><hr><p>b</p><hr><blockquote>c</blockquote>';
    const { body: out, removed } = stripHrBeforeHeadings(body);
    expect(removed).toBe(0);
    expect(out).toBe(body);
  });

  it('blockquote 内的 hr 不被误删（有闭合标签阻隔）', () => {
    const body = '<blockquote><hr></blockquote><h2>标题</h2>';
    const { body: out, removed } = stripHrBeforeHeadings(body);
    expect(removed).toBe(0);
    expect(out).toContain('<hr>');
  });
});

describe('buildLandscapeWarning（横版建议）', () => {
  const wide = { width: 1600, height: 900 };

  it('横向图占比 ≥60% 且未传 landscape 时输出建议', () => {
    const warn = buildLandscapeWarning([wide, wide, { width: 800, height: 1200 }], undefined);
    expect(warn).toContain('2 of 3');
    expect(warn).toContain('landscape: true');
  });

  it('显式指定 landscape（true/false 均算知情）时不提示', () => {
    expect(buildLandscapeWarning([wide, wide, wide], true)).toBeUndefined();
    expect(buildLandscapeWarning([wide, wide, wide], false)).toBeUndefined();
  });

  it('图片不足 3 张或占比不足时不提示', () => {
    expect(buildLandscapeWarning([wide, wide], undefined)).toBeUndefined();
    expect(buildLandscapeWarning([wide, { width: 100, height: 200 }, { width: 100, height: 300 }], undefined)).toBeUndefined();
  });

  it('接近正方形（宽 ≤ 高×1.2）不算横向图', () => {
    const warn = buildLandscapeWarning(
      [{ width: 110, height: 100 }, { width: 110, height: 100 }, { width: 110, height: 100 }],
      undefined,
    );
    expect(warn).toBeUndefined();
  });
});

describe('pdf-probe（页数/尺寸/空白页）', () => {
  async function writeProbePdf(): Promise<string> {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]); // p1: 完全空白
    const p2 = doc.addPage([595, 842]);
    p2.drawText('Hello', { x: 50, y: 700, size: 24, font: await doc.embedFont(StandardFonts.Helvetica) });
    const p3 = doc.addPage([595, 842]);
    p3.drawRectangle({ x: 10, y: 10, width: 400, height: 2 }); // 仅一条线（准空白）
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-probe-'));
    const file = path.join(dir, 'probe.pdf');
    await fs.writeFile(file, await doc.save());
    return file;
  }

  it('回传页数/首页尺寸，识别空白页与仅一条线的页面', async () => {
    const file = await writeProbePdf();
    const r = await probePdf(file);
    expect(r.pageCount).toBe(3);
    expect(r.pageSize).toEqual({ width: 595, height: 842 });
    expect(r.blankPages).toEqual([1, 3]);
    await fs.rm(path.dirname(file), { recursive: true, force: true });
  });

  it('countContentOps 统计文本/XObject/路径绘制', () => {
    const ops = countContentOps(
      'q 1 0 0 1 0 0 cm /F1 12 Tf <0031> Tj Q /img0 Do 0 0 100 100 re f',
    );
    expect(ops.text).toBe(1);
    expect(ops.xobject).toBe(1);
    expect(ops.paint).toBe(1);
  });

  it('countContentOps：hex 字符串内容不计入路径绘制', () => {
    const ops = countContentOps('<0053> Tj');
    expect(ops.text).toBe(1);
    expect(ops.paint).toBe(0);
  });

  it('countContentOps：sh 着色算子计入路径绘制（防渐变页误判空白）', () => {
    const ops = countContentOps('q /Sh0 sh Q');
    expect(ops.paint).toBe(1);
  });
});

describe('convertMdToHtml：节间 --- 清理', () => {
  it('统计 removedHrs 且正文不含紧邻标题的 hr', async () => {
    const md = [
      '# 报告',
      '',
      '首页内容。',
      '',
      '---',
      '',
      '## 第一节',
      '',
      '第一节内容。',
      '',
      '---',
      '',
      '## 第二节',
      '',
      '第二节内容。',
    ].join('\n');
    const { html, stats } = await new MdConverter().convertMdToHtml(md, { embedImages: false });
    expect(stats.removedHrs).toBe(2);
    // h2 标签前不允许紧邻 hr（允许中间有空白）
    expect(html).not.toMatch(/<hr\s*\/?>\s*<h[12]/);
  });
});

describe('convertMdToHtml：landscape 建议（图片尺寸探测路径）', () => {
  /** 仅含合法 IHDR 头的 PNG（image-size 只读头部尺寸，不校验像素/CRC）。 */
  function pngHeader(width: number, height: number): Buffer {
    const buf = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
    buf.writeUInt32BE(13, 8);
    buf.write('IHDR', 12, 'ascii');
    buf.writeUInt32BE(width, 16);
    buf.writeUInt32BE(height, 20);
    buf.writeUInt8(8, 24);
    buf.writeUInt8(6, 25);
    return buf;
  }

  it('嵌入 3 张横向图且未显式传 landscape 时输出建议；显式传 false 不提示', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'md-landscape-'));
    for (const n of ['a', 'b', 'c']) {
      await fs.writeFile(path.join(dir, `${n}.png`), pngHeader(1600, 900));
    }
    const md = '# 报告\n\n![a](a.png)\n\n![b](b.png)\n\n![c](c.png)\n';
    const { stats } = await new MdConverter().convertMdToHtml(md, {}, dir);
    expect(stats.warnings?.some((w) => w.includes('3 of 3'))).toBe(true);
    const { stats: explicitOff } = await new MdConverter().convertMdToHtml(md, { landscape: false }, dir);
    expect(explicitOff.warnings).toBeUndefined();
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('convertMdToPdf E2E（Chromium）', () => {
  it('节间 --- 不再产生空白页，回传页数/尺寸/空白页', async () => {
    const { PdfConverter } = await import('../src/pdf-converter.js');
    const md = [
      '# 报告',
      '',
      '首页内容。',
      '',
      '---',
      '',
      '## 第一节',
      '',
      '第一节内容。',
      '',
      '---',
      '',
      '## 第二节',
      '',
      '第二节内容。',
    ].join('\n');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'md-pdf-e2e-'));
    const out = path.join(dir, 'out.pdf');
    // cleanup 必须作用在同一实例上：浏览器由该实例持有
    const converter = new PdfConverter();
    const r = await new MdConverter().convertMdToPdf(
      { mdContent: md, outputPath: out, mermaidSource: 'none' },
      converter,
    );
    expect(r.success).toBe(true);
    expect(r.details?.pageCount).toBe(3);
    // A4 竖版（Chromium 输出 595.5pt，四舍五入 596）
    expect(r.details?.pageSize?.width).toBeGreaterThanOrEqual(594);
    expect(r.details?.pageSize?.width).toBeLessThanOrEqual(597);
    expect(r.details?.pageSize?.height).toBe(842);
    expect(r.details?.blankPages).toEqual([]);
    expect(r.details?.stats?.removedHrs).toBe(2);
    await converter.cleanup();
    await fs.rm(dir, { recursive: true, force: true });
  }, 60000);
});
