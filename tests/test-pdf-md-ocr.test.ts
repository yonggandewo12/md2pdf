/**
 * convertPdfToMarkdown 的 pdfOcr 路由测试。
 *
 * - 单测：pdf-lib 生成纯文本 PDF，验证 auto/off 路由（不触 OCR 引擎）。
 * - e2e：需本地 OCR 运行时（PDFIUM_LIB_PATH/ORT_DYLIB_PATH 环境变量），
 *   用 puppeteer 生成仿真扫描件验证本地 OCR 闭环；无运行时静默跳过。
 */
import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PptMasterService } from '../src/ppt-master-service.js';

const FIXTURE_TEXT = 'Convert to markdown OCR routing fixture';

async function makeTextPdf(dir: string): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([500, 300]);
  page.drawText(FIXTURE_TEXT, { x: 40, y: 200, font, size: 16 });
  const p = path.join(dir, 'text-fixture.pdf');
  await fs.writeFile(p, await doc.save());
  return p;
}

function makeService(): PptMasterService {
  const runner = {
    checkPython: vi.fn(async () => {}),
    checkPackages: vi.fn(async () => []),
    run: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })),
  };
  return new PptMasterService(runner as never);
}

describe('convertPdfToMarkdown pdfOcr routing', () => {
  it('pdfOcr=off extracts native text only', async () => {
    const work = await mkdtemp(path.join(tmpdir(), 'mdocr-'));
    try {
      const src = await makeTextPdf(work);
      const out = path.join(work, 'off.md');
      const result = await makeService().convertToMarkdown({
        source: src,
        outputPath: out,
        sourceType: 'pdf',
        pdfOcr: 'off',
      });
      expect(result.success, result.error).toBe(true);
      const md = await fs.readFile(out, 'utf-8');
      expect(md).toContain(FIXTURE_TEXT);
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  });

  it('pdfOcr=auto on a text-based PDF takes the zero-cost native path', async () => {
    const work = await mkdtemp(path.join(tmpdir(), 'mdocr-'));
    try {
      const src = await makeTextPdf(work);
      const out = path.join(work, 'auto.md');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await makeService().convertToMarkdown({
          source: src,
          outputPath: out,
          sourceType: 'pdf',
          pdfOcr: 'auto',
        });
        expect(result.success, result.error).toBe(true);
        // 纯文本 PDF 不应触发 OCR 相关告警
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('needing OCR'));
      } finally {
        warn.mockRestore();
      }
      const md = await fs.readFile(out, 'utf-8');
      expect(md).toContain(FIXTURE_TEXT);
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  });
});

// ── e2e：本地 OCR 运行时可用时才跑 ────────────────────────────────

// describe.runIf 急切求值：加载时同步判定
const ocrRuntimeAvailable =
  !!process.env.PDFIUM_LIB_PATH && !!process.env.ORT_DYLIB_PATH;

describe.runIf(ocrRuntimeAvailable)('convertPdfToMarkdown local OCR e2e', () => {
  it('pdfOcr=auto closes the loop on a simulated scanned PDF', async () => {
    const puppeteer = (await import('puppeteer')).default;
    const { PDFDocument: PdfLib } = await import('pdf-lib');

    const work = await mkdtemp(path.join(tmpdir(), 'mdocr-e2e-'));
    try {
      const browser = await puppeteer.launch();
      const page = await browser.newPage();
      await page.setContent(`<h1>${FIXTURE_TEXT}</h1><p>scanned page simulation</p>`);
      await page.setViewport({ width: 800, height: 600 });
      const shot = path.join(work, 'page.png');
      await page.screenshot({ path: shot });
      await browser.close();

      // 截图 → 单页图片 PDF（仿真扫描件）
      const imgDoc = await PdfLib.create();
      const png = await imgDoc.embedPng(await fs.readFile(shot));
      const imgPage = imgDoc.addPage([png.width, png.height]);
      imgPage.drawImage(png, { x: 0, y: 0, width: png.width, height: png.height });
      const scanned = path.join(work, 'scanned.pdf');
      await fs.writeFile(scanned, await imgDoc.save());

      const out = path.join(work, 'scanned.md');
      const result = await makeService().convertToMarkdown({
        source: scanned,
        outputPath: out,
        sourceType: 'pdf',
        pdfOcr: 'auto',
      });
      expect(result.success, result.error).toBe(true);
      const md = await fs.readFile(out, 'utf-8');
      expect(md).toContain(FIXTURE_TEXT);
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  }, 120_000);
});
