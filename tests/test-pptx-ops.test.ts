/**
 * PPTX 读取/编辑工具单元测试（python-pptx 子进程）。
 * 依赖嵌入运行时（PPT_MASTER_PYTHON 可指定）。
 * 测试夹具：在 setup 中用嵌入 python-pptx 生成 2 页演示文稿。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import { PptService } from '../src/ppt-service.js';
import { PythonScriptRunner } from '../src/python-runner.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'pptx-ops-test-'));

const svc = new PptService();
// 复用与 service 相同的解释器解析（嵌入运行时），保证夹具生成与子进程调用一致。
const py = new PythonScriptRunner().pythonExecutable;

/** 生成 2 页的测试 pptx（标题 + 项目符号）。 */
async function makeDeck(dir: string, name = 'deck.pptx'): Promise<string> {
  const out = path.join(dir, name);
  const code = `
from pptx import Presentation
prs = Presentation()
s1 = prs.slides.add_slide(prs.slide_layouts[0])
s1.shapes.title.text = 'Fixture Title'
s1.placeholders[1].text = 'Bullet one'
s2 = prs.slides.add_slide(prs.slide_layouts[1])
s2.shapes.title.text = 'Second Slide'
s2.placeholders[1].text = 'Item A\\nItem B'
prs.save(${JSON.stringify(out)})
`;
  const r = spawnSync(py, ['-c', code], { encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error(`Cannot create fixture pptx: ${r.stderr}`);
  }
  return out;
}

let deckPath: string;
let dir: string;

beforeAll(async () => {
  dir = await tmp();
  deckPath = await makeDeck(dir);
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('PPTX 读取', () => {
  it('pptx_read_presentation 返回页数与标题', async () => {
    const r = await svc.call('read_presentation', { pptxPath: deckPath });
    expect(r.success).toBe(true);
    expect(r.data!.slideCount).toBe(2);
    const titles = (r.data!.slides as { title: string }[]).map((s) => s.title);
    expect(titles).toContain('Fixture Title');
  });

  it('pptx_read_slide_details 返回 shapes', async () => {
    const r = await svc.call('read_slide_details', { pptxPath: deckPath, slideIndex: 1 });
    expect(r.success).toBe(true);
    const shapes = r.data!.shapes as { text: string }[];
    expect(shapes.some((s) => s.text === 'Fixture Title')).toBe(true);
  });

  it('pptx_extract_text 生成 markdown', async () => {
    const out = path.join(dir, 'deck.md');
    const r = await svc.call('extract_text', { pptxPath: deckPath, outputPath: out });
    expect(r.success).toBe(true);
    expect(r.data!.markdown).toContain('Fixture Title');
    await fs.access(out); // 文件确实写出
  });

  it('pptx_to_images 渲染每页为图片', async () => {
    const outDir = path.join(dir, 'imgs');
    const r = await svc.call('to_images', { pptxPath: deckPath, outputDir: outDir, dpi: 72 });
    expect(r.success).toBe(true);
    expect((r.data!.files as unknown[]).length).toBe(2);
    for (const f of r.data!.files as { path: string }[]) {
      await fs.access(f.path);
    }
  });

  it('读取不存在的文件返回失败', async () => {
    const r = await svc.call('read_presentation', { pptxPath: path.join(dir, 'no.pptx') });
    expect(r.success).toBe(false);
  });
});

describe('PPTX 编辑', () => {
  it('pptx_replace_text 替换指定页文字', async () => {
    const out = path.join(dir, 'edit1.pptx');
    const r = await svc.call('replace_text', {
      pptxPath: deckPath,
      outputPath: out,
      sourceSlide: 1,
      replacements: [{ shape_id: 2, text: 'Edited Title' }],
    });
    expect(r.success).toBe(true);
    // 用读取工具回读验证
    const read = await svc.call('read_presentation', { pptxPath: out });
    const titles = (read.data!.slides as { title: string }[]).map((s) => s.title);
    expect(titles).toContain('Edited Title');
    // 页数保持 2（apply_plan 只输出 plan 列出的页）
    expect(read.data!.slideCount).toBe(2);
  });

  it('pptx_duplicate_slide 复制页并保留原页', async () => {
    const out = path.join(dir, 'edit2.pptx');
    const r = await svc.call('duplicate_slide', {
      pptxPath: deckPath,
      outputPath: out,
      slideIndex: 1,
      count: 1,
    });
    expect(r.success).toBe(true);
    const read = await svc.call('read_presentation', { pptxPath: out });
    expect(read.data!.slideCount).toBe(3);
  });

  it('pptx_add_notes 添加演讲者备注', async () => {
    const out = path.join(dir, 'edit3.pptx');
    const r = await svc.call('add_notes', {
      pptxPath: deckPath,
      outputPath: out,
      notes: [{ slideIndex: 1, text: 'Speak slowly' }],
    });
    expect(r.success).toBe(true);
    // 用 python 读回 notes 验证
    const code = `
from pptx import Presentation
p = Presentation(${JSON.stringify(out)})
print(p.slides[0].has_notes_slide and p.slides[0].notes_slide.notes_text_frame.text or '')
`;
    const rv = spawnSync(py, ['-c', code], { encoding: 'utf-8' });
    expect(rv.stdout.trim()).toContain('Speak slowly');
  });

  it('pptx_set_transitions 设置转场不崩溃', async () => {
    const out = path.join(dir, 'edit4.pptx');
    const r = await svc.call('set_transitions', {
      pptxPath: deckPath,
      outputPath: out,
      transition: 'fade',
      duration: 1.0,
    });
    expect(r.success).toBe(true);
    const read = await svc.call('read_presentation', { pptxPath: out });
    expect(read.data!.slideCount).toBe(2);
  });
});
