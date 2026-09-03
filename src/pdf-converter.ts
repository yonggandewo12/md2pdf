import puppeteer, { Browser, PDFOptions as PuppeteerPDFOptions } from 'puppeteer';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as cheerio from 'cheerio';
import { pathToFileURL } from 'url';

import { findChromiumExecutable } from './python-runner.js';
import { ConvertOptions, ConvertResult, ConvertImageOptions, ImageConvertResult, PAPER_FORMAT_DIMENSIONS } from './types.js';
import { mermaidBundlePath } from './mermaid-bundle.js';

// 剔除 HTML 内嵌的 mermaid CDN <script src> 引用：同步脚本会阻塞 DOMContentLoaded
// （headless shell 经代理下载 ~3.2MB 极慢甚至失败），渲染时用 addScriptTag 注入本地
// 脚本替换。提取为模块级常量以便测试复用。
export const MERMAID_SCRIPT_STRIP_RE = /<script[^>]*\bsrc=["'][^"']*mermaid[^"']*["'][^>]*>\s*<\/script>/gi;

export class PdfConverter {
  private browser: Browser | null = null;
  private browserPromise: Promise<Browser> | null = null;

  /**
   * Initialize browser instance with connection pooling
   */
  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }

    if (this.browserPromise) {
      return this.browserPromise;
    }

    // Chromium is not bundled in the npm package (tarball would exceed the
    // registry size limit). Prefer a headless shell cached by Puppeteer, then
    // a system-installed Chrome; otherwise let Puppeteer use its own lookup
    // and surface a fixable error below.
    const chromiumExecutable = findChromiumExecutable();

    this.browserPromise = puppeteer.launch({
      headless: true,
      ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    }).catch((err: unknown) => {
      // Puppeteer's own error for a missing binary is terse ("Could not
      // find Chrome..."); rethrow with a fixable hint.
      const msg = err instanceof Error ? err.message : String(err);
      const installHint =
        `Install a headless browser once (≈15s, cached across reinstalls):\n` +
        `  npx puppeteer browsers install chrome-headless-shell\n` +
        `Faster in China via npmmirror:\n` +
        `  npx puppeteer browsers install chrome-headless-shell ` +
        `--base-url https://registry.npmmirror.com/-/binary/chrome-for-testing\n` +
        `Or just install Google Chrome and this package will use it automatically.`;
      throw new Error(
        `Failed to launch headless Chromium. ` +
        (chromiumExecutable
          ? `Tried executable ${chromiumExecutable}: ${msg}`
          : `No Chrome Headless Shell or system Chrome found.\n${installHint} — ${msg}`)
      );
    });

    try {
      this.browser = await this.browserPromise;
      return this.browser;
    } finally {
      this.browserPromise = null;
    }
  }

  /**
   * Convert HTML to PDF
   */
  async convertToPdf(options: ConvertOptions): Promise<ConvertResult> {
    const startTime = Date.now();
    let page = null;

    try {
      // Validate input
      if (!options.htmlPath && !options.htmlContent) {
        throw new Error('Either htmlPath or htmlContent must be provided');
      }

      // Get or create browser instance
      const browser = await this.getBrowser();
      page = await browser.newPage();

      // Set viewport to match paper format for correct Mermaid scaling
      // scaleMermaidDiagrams() uses document.documentElement.clientHeight
      // which must reflect the PDF page height, not the default 600px viewport
      const fmt = options.format || 'A4';
      const dims = PAPER_FORMAT_DIMENSIONS[fmt] || PAPER_FORMAT_DIMENSIONS.A4!;
      await page.setViewport(
        options.landscape
          ? { width: dims.height, height: dims.width }
          : { width: dims.width, height: dims.height },
      );

      // Set timeout
      const timeout = options.timeout || 30000;
      page.setDefaultTimeout(timeout);

      // Load HTML content
      if (options.htmlPath) {
        const htmlPath = path.resolve(options.htmlPath);
        await fs.access(htmlPath); // Check file exists
        const fileUrl = pathToFileURL(htmlPath).href;

        const waitUntil = options.waitForNetworkIdle ? 'networkidle0' : 'load';
        await page.goto(fileUrl, {
          waitUntil,
          timeout
        });
      } else if (options.htmlContent) {
        await page.setContent(options.htmlContent, {
          waitUntil: options.waitForNetworkIdle ? 'networkidle0' : 'load',
          timeout
        });
      }

      // Wait a bit for any dynamic content to render
      await page.evaluate(() => {
        return new Promise<void>((resolve) => {
          // @ts-ignore - document and window are available in browser context
          if (document.readyState === 'complete') {
            resolve();
          } else {
            // @ts-ignore - document and window are available in browser context
            window.addEventListener('load', () => resolve());
          }
        });
      });

      // 等待 Mermaid 渲染完成（如果 HTML 中包含 mermaid 脚本）
      if (options.waitForMermaid) {
        try {
          await page.waitForFunction('window.__mermaidDone === true', { timeout: 30000 });
        } catch (e) {
          // timeout — 继续生成 PDF，不阻塞
        }
      }

      // Prepare PDF options
      const pdfOptions: PuppeteerPDFOptions = {
        format: options.format || 'A4',
        landscape: options.landscape || false,
        printBackground: options.printBackground !== false, // default true
        scale: options.scale || 1,
        displayHeaderFooter: options.displayHeaderFooter || false,
        preferCSSPageSize: options.preferCSSPageSize || false,
        margin: {
          top: options.marginTop || '10mm',
          bottom: options.marginBottom || '10mm',
          left: options.marginLeft || '10mm',
          right: options.marginRight || '10mm'
        }
      };

      if (options.headerTemplate) {
        pdfOptions.headerTemplate = options.headerTemplate;
      }
      if (options.footerTemplate) {
        pdfOptions.footerTemplate = options.footerTemplate;
      }

      // Generate output path if not provided
      let outputPath = options.outputPath;
      if (!outputPath) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        outputPath = path.join(process.cwd(), `output-${timestamp}.pdf`);
      } else {
        outputPath = path.resolve(outputPath);
      }

      // Ensure parent directory exists (mirrors convertToImage)
      const parentDir = path.dirname(outputPath);
      await fs.mkdir(parentDir, { recursive: true }).catch(() => {});

      // Generate PDF
      if (outputPath) {
        pdfOptions.path = outputPath;
      }

      await page.pdf(pdfOptions);

      // Get file size
      let fileSize: number | undefined;
      try {
        const stats = await fs.stat(outputPath);
        fileSize = stats.size;
      } catch (e) {
        // Ignore error
      }

      const processingTime = Date.now() - startTime;

      return {
        success: true,
        outputPath,
        details: {
          processingTime,
          fileSize
        }
      };
    } catch (error) {
      const processingTime = Date.now() - startTime;
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        details: {
          processingTime
        }
      };
    } finally {
      // Close the page to free resources
      if (page) {
        await page.close().catch(() => {});
      }
    }
  }

  /**
   * Convert HTML to image (PNG/JPEG)
   */
  async convertToImage(options: ConvertImageOptions): Promise<ImageConvertResult> {
    const startTime = Date.now();
    let page = null;

    try {
      // Validate input
      if (!options.htmlPath && !options.htmlContent) {
        throw new Error('Either htmlPath or htmlContent must be provided');
      }

      const imageFormat = options.imageFormat || 'png';
      const quality = options.quality ?? 90;
      const fullPage = options.fullPage ?? false;
      const imageScale = options.imageScale ?? 1;

      // Get or create browser instance
      const browser = await this.getBrowser();
      page = await browser.newPage();

      // Set viewport — use a wide viewport to avoid layout shifts
      await page.setViewport({
        width: 1920,
        height: 1080,
        deviceScaleFactor: imageScale,
      });

      const timeout = options.timeout || 30000;
      page.setDefaultTimeout(timeout);

      // Load HTML content
      if (options.htmlPath) {
        const htmlPath = path.resolve(options.htmlPath);
        await fs.access(htmlPath);
        const fileUrl = pathToFileURL(htmlPath).href;
        const waitUntil = options.waitForNetworkIdle ? 'networkidle0' : 'load';
        await page.goto(fileUrl, { waitUntil, timeout });
      } else if (options.htmlContent) {
        await page.setContent(options.htmlContent, {
          waitUntil: options.waitForNetworkIdle ? 'networkidle0' : 'load',
          timeout,
        });
      }

      // Wait for dynamic content to render
      await page.evaluate(() => {
        return new Promise<void>((resolve) => {
          // @ts-ignore - browser context
          if (document.readyState === 'complete') {
            resolve();
          } else {
            // @ts-ignore - browser context
            window.addEventListener('load', () => resolve());
          }
        });
      });

      // Wait for Mermaid if requested
      if (options.waitForMermaid) {
        try {
          await page.waitForFunction('window.__mermaidDone === true', { timeout: 30000 });
        } catch (e) {
          // timeout — continue
        }
      }

      // Prepare screenshot options
      const screenshotOptions: Parameters<typeof page.screenshot>[0] = {
        type: imageFormat === 'jpeg' ? 'jpeg' : 'png',
        quality: imageFormat === 'jpeg' ? quality : undefined,
        fullPage,
      };

      // Determine output path
      let outputPath = options.outputPath;
      if (!outputPath) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const ext = imageFormat === 'jpeg' ? 'jpg' : 'png';
        outputPath = path.join(process.cwd(), `output-${timestamp}.${ext}`);
      } else {
        outputPath = path.resolve(outputPath);
      }

      // Ensure parent directory exists
      const parentDir = path.dirname(outputPath);
      await fs.mkdir(parentDir, { recursive: true }).catch(() => {});

      // Take screenshot
      await page.screenshot({
        ...screenshotOptions,
        path: outputPath,
      });

      // Get file info
      let fileSize: number | undefined;
      let width: number | undefined;
      let height: number | undefined;
      try {
        const stats = await fs.stat(outputPath);
        fileSize = stats.size;
      } catch (e) {
        // Ignore
      }
      try {
        if (fullPage) {
          const contentSize = await page.evaluate(() => {
            // @ts-ignore - browser context
            const html = document.documentElement;
            return { width: html.scrollWidth, height: html.scrollHeight };
          });
          width = contentSize.width * imageScale;
          height = contentSize.height * imageScale;
        } else {
          const viewport = page.viewport();
          width = (viewport?.width ?? 1920) * imageScale;
          height = (viewport?.height ?? 1080) * imageScale;
        }
      } catch {
        // Ignore
      }

      const processingTime = Date.now() - startTime;

      return {
        success: true,
        outputPath,
        details: {
          processingTime,
          fileSize,
          width,
          height,
        },
      };
    } catch (error) {
      const processingTime = Date.now() - startTime;
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        details: {
          processingTime,
        },
      };
    } finally {
      if (page) {
        await page.close().catch(() => {});
      }
    }
  }

  /**
   * 渲染 HTML 中的 mermaid 块为 PNG 图片并替换为 <img>（供 DOCX 等无浏览器环境消费）。
   *
   * 用 Puppeteer 打开含 mermaid CDN script 的 HTML，本地注入 mermaid.min.js 后
   * 轮询 `.mermaid svg` 数量（__mermaidDone 初始即 true，不能作渲染完成信号），
   * 对每个已渲染 `.mermaid` div 截图，再把 div 替换为 data-URI <img>。
   *
   * Fallback：CDN 下载失败 / 渲染超时 / 浏览器不可用等任何失败都返回原文，绝不抛出。
   */
  async renderMermaidBlocks(htmlContent: string): Promise<{ html: string; count: number }> {
    if (!/<div[^>]*class="[^"]*\bmermaid\b[^"]*"/.test(htmlContent)) {
      return { html: htmlContent, count: 0 };
    }
    let page = null;
    try {
      const browser = await this.getBrowser();
      page = await browser.newPage();
      page.setDefaultTimeout(30000);
      // 宽 viewport 避免窄屏压缩 SVG 尺寸
      await page.setViewport({ width: 1600, height: 1000 });

      // 先取（或下载）mermaid.min.js 到 home 缓存目录，再用 addScriptTag 注入，
      // 避免 headless shell 直连外部 CDN 时的代理超时。取不到（下载失败/空文件）
      // 时提前返回原文，避免下方 waitForFunction 无谓等待超时。
      const mermaidLocalPath = mermaidBundlePath();

      // 剔除 HTML 内嵌的 mermaid CDN <script src> 引用：它是同步脚本，会阻塞
      // DOMContentLoaded（headless shell 经代理下载 ~3.2MB 极慢甚至失败）。我们
      // 后续用 addScriptTag 注入本地脚本，这里必须移除原引用以免卡死。
      const sanitizedHtml = htmlContent.replace(MERMAID_SCRIPT_STRIP_RE, '');

      if (!mermaidLocalPath) {
        // mermaid 库不可用（CDN 引用已被剔除）→ 渲染不可能成功。返回剔除 CDN
        // script 后的 HTML（与成功路径契约一致），也不再空加载页面。
        return { html: sanitizedHtml, count: 0 };
      }

      await page.setContent(sanitizedHtml, { waitUntil: 'domcontentloaded', timeout: 30000 });

      await page.addScriptTag({ path: mermaidLocalPath }).catch(() => {});
      // 注入后立即确认 window.mermaid 可用（缓存半截文件/注入失败时不存在）：
      // 不可用则渲染必然失败，提前返回原文，避免 waitForFunction 空等 15s 超时。
      // 可用则初始化并手动渲染（startOnLoad:false 下 mermaid 不会自动执行）。
      const mermaidReady = await page
        .evaluate(() => {
          // @ts-ignore - browser context
          if (typeof window.mermaid === 'undefined') return false;
          // @ts-ignore
          window.mermaid.initialize({ securityLevel: 'loose', startOnLoad: false });
          // @ts-ignore
          return window.mermaid.run({ querySelector: '.mermaid' }).then(() => true).catch(() => true);
        })
        .catch(() => false);
      if (!mermaidReady) {
        // 渲染不可能成功：返回剔除 CDN script 后的 HTML（与成功路径契约一致）
        return { html: sanitizedHtml, count: 0 };
      }

      // 等待 mermaid 渲染出 svg。终态信号：每个 .mermaid div 都有 svg 或 data-processed
      // 标记（__mermaidDone 初始即 true，不能作渲染完成信号）。坏图/语法错误在 15s 超时
      // 后由下方兜底降级（未渲染的 div 保留源码）。
      await page
        .waitForFunction(
          () => {
            // @ts-ignore - browser context
            const doc = globalThis.document;
            const divs = doc.querySelectorAll('.mermaid');
            if (divs.length === 0) return true;
            // 每个 div 至少有 svg 或 data-processed 之一才算完成（OR 逻辑，非求和）
            for (const div of divs) {
              const hasSvg = div.querySelector('svg') !== null;
              const processed = div.hasAttribute('data-processed');
              if (!hasSvg && !processed) return false;
            }
            return true;
          },
          { timeout: 15000 },
        )
        .catch(() => {});

      const mermaidHandles = await page.$$('.mermaid');
      if (mermaidHandles.length === 0) {
        return { html: sanitizedHtml, count: 0 };
      }

      const pngBuffers: (Buffer | null)[] = [];
      for (const handle of mermaidHandles) {
        try {
          const hasSvg = (await handle.$('svg')) !== null;
          if (!hasSvg) {
            // mermaid 未渲染（CDN 加载失败等）→ 该块跳过，保留原文
            pngBuffers.push(null);
            continue;
          }
          // 语法错误时 mermaid 渲染一个错误提示 svg（含 .error-text/.error-icon 元素）。
          // 识别后跳过、降级保留源码文本，避免把报错图嵌入 DOCX。注意不能用
          // textContent 子串匹配——所有 svg 内联 CSS 都含 .error-text 类定义会误伤，
          // 须元素级检测（好图与含 "Error" 文本节点的合法图均无误判）。
          const isError = await handle.evaluate((el) => {
            const svg = el.querySelector('svg');
            if (!svg) return false;
            return svg.querySelectorAll('.error-text, .error-icon').length > 0;
          });
          if (isError) {
            pngBuffers.push(null);
            continue;
          }
          // ElementHandle.screenshot() 返回 Uint8Array；Buffer.from 归一为 Buffer
          const shot = await handle.screenshot({ type: 'png' });
          pngBuffers.push(Buffer.isBuffer(shot) ? shot : Buffer.from(shot));
        } catch {
          pngBuffers.push(null);
        } finally {
          await handle.dispose().catch(() => {});
        }
      }

      // DOM handles 与 cheerio 按文档顺序一一映射；数量不一致时取 min 防止越界。
      // 用剔除 CDN script 后的 sanitizedHtml 而非原始 htmlContent，避免返回产物
      // 残留已剔除的 mermaid script 引用。
      const $ = cheerio.load(sanitizedHtml);
      const mermaidCheerioCount = $('.mermaid').length;
      const replaceCount = Math.min(pngBuffers.length, mermaidCheerioCount);
      let count = 0;
      $('.mermaid').slice(0, replaceCount).each((i, el) => {
        const buf = pngBuffers[i];
        if (!buf) return; // 保留原文（fallback：docx 会以源码文本呈现）
        const dataUri = `data:image/png;base64,${buf.toString('base64')}`;
        $(el).replaceWith(`<img src="${dataUri}" alt="mermaid-diagram" />`);
        count++;
      });

      return { html: $.html(), count };
    } catch {
      return { html: htmlContent, count: 0 };
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  /**
   * Close browser and cleanup resources
   */
  async cleanup(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
