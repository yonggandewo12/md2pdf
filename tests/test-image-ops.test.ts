/**
 * 图片处理工具单元测试（Pillow 子进程）。
 * 依赖嵌入运行时（PPT_MASTER_PYTHON 可指定）。
 */
import { describe, expect, it } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import { ImageService } from '../src/image-service.js';
import { PythonScriptRunner } from '../src/python-runner.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'image-ops-test-'));

const py = new PythonScriptRunner().pythonExecutable;

/** 用嵌入 Python + Pillow 生成测试图片，避免依赖其他系统。 */
async function makeImage(dir: string, w = 400, h = 300): Promise<string> {
  const p = path.join(dir, 'placeholder.png');
  const r = spawnSync(
    py,
    ['-c', `from PIL import Image; Image.new('RGB', (${w}, ${h}), 'blue').save(${JSON.stringify(p)})`],
    { encoding: 'utf-8' },
  );
  if (r.status !== 0) {
    throw new Error(`Cannot create test image: ${r.stderr}`);
  }
  return p;
}

describe('图片处理（Pillow 子进程）', () => {
  const svc = new ImageService();

  it('image_info 读取尺寸/格式', async () => {
    const dir = await tmp();
    const src = await makeImage(dir, 400, 300);
    const r = await svc.call('info', { imagePath: src });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ width: 400, height: 300, format: 'PNG' });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('image_resize 保持宽高比（400x300 → 200x150）', async () => {
    const dir = await tmp();
    const src = await makeImage(dir, 400, 300);
    const out = path.join(dir, 'resized.png');
    const r = await svc.call('resize', { imagePath: src, outputPath: out, width: 200, height: 150, mode: 'fit' });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ width: 200, height: 150 });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('image_resize 只给 width 时按比例缩放', async () => {
    const dir = await tmp();
    const src = await makeImage(dir, 400, 300);
    const out = path.join(dir, 'r.png');
    const r = await svc.call('resize', { imagePath: src, outputPath: out, width: 100, mode: 'fit' });
    expect(r.success).toBe(true);
    expect(r.data!.width).toBe(100);
    expect(r.data!.height).toBe(75);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('image_resize 缺宽高返回失败', async () => {
    const dir = await tmp();
    const src = await makeImage(dir);
    const out = path.join(dir, 'r.png');
    const r = await svc.call('resize', { imagePath: src, outputPath: out });
    expect(r.success).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('image_rotate 旋转 90° 后宽高互换', async () => {
    const dir = await tmp();
    const src = await makeImage(dir, 400, 300);
    const out = path.join(dir, 'rot.png');
    const r = await svc.call('rotate', { imagePath: src, outputPath: out, degrees: 90 });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ width: 300, height: 400 });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('image_crop 按像素坐标裁切', async () => {
    const dir = await tmp();
    const src = await makeImage(dir, 400, 300);
    const out = path.join(dir, 'crop.png');
    const r = await svc.call('crop', { imagePath: src, outputPath: out, left: 50, top: 50, right: 200, bottom: 150 });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ width: 150, height: 100 });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('image_watermark 文字水印成功（含中文降级不抛错）', async () => {
    const dir = await tmp();
    const src = await makeImage(dir, 400, 300);
    const out = path.join(dir, 'wm.png');
    const r = await svc.call('watermark', {
      imagePath: src,
      outputPath: out,
      text: '机密',
      position: 'bottom-right',
      opacity: 0.5,
    });
    // 中文字体不可用时应降级到默认字体而非崩溃
    expect(r.success).toBe(true);
    const stat = await fs.stat(out);
    expect(stat.size).toBeGreaterThan(0);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('image_watermark 无 text 和 textImage 返回失败', async () => {
    const dir = await tmp();
    const src = await makeImage(dir);
    const out = path.join(dir, 'wm.png');
    const r = await svc.call('watermark', { imagePath: src, outputPath: out });
    expect(r.success).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('image_compress 输出可读且格式正确', async () => {
    const dir = await tmp();
    const src = await makeImage(dir, 400, 300);
    const out = path.join(dir, 'c.jpg');
    const r = await svc.call('compress', { imagePath: src, outputPath: out, quality: 50, maxWidth: 200 });
    expect(r.success).toBe(true);
    expect(r.data!.format).toBe('JPEG');
    expect(r.data!.width).toBeLessThanOrEqual(200);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
