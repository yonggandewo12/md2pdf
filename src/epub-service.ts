/**
 * ePub 电子书服务：md_to_epub 工具的实现后端。
 *
 * Markdown → HTML（markdown-it，已在依赖中）→ EPUB（epub-gen，纯 JS 零原生依赖）。
 * 支持相对路径图片嵌入 epub 包（file:// 方式收进 OEBPS/images/，离线可读）；可关闭。
 *
 * @author Liang.Xu
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import MarkdownIt from 'markdown-it';
import * as cheerio from 'cheerio';
import Epub, { EpubOptions as EpubGenOptions } from 'epub-gen';

export interface EpubOptions {
  mdPath?: string;
  mdContent?: string;
  outputPath: string;
  title?: string;
  author?: string;
  publisher?: string;
  cover?: string;
  /** 按 h1 分章（默认 false：整篇单章）。 */
  splitByHeading?: boolean;
  /** 将相对路径图片嵌入 epub 包（file:// 方式收进 OEBPS/images/，默认 true）。 */
  embedImages?: boolean;
  /** EPUB 版本 2/3（默认 3）。 */
  version?: number;
}

export interface EpubResult {
  success: boolean;
  outputPath?: string;
  chapters?: number;
  title?: string;
  fileSize?: number;
  error?: string;
  details?: { processingTime: number };
}

/**
 * 将本地相对路径图片改写为 file:// URL（基于 md 所在目录解析）。
 * epub-gen 0.1.x 只支持 file:// / http(s) / 相对路径三类 src：data URI 会被
 * 当文件路径下载并重写为 images/{uuid}.null（图片静默丢失），因此这里不内联
 * base64，而是用 file:// 前缀走其 copySync 分支把图片收进 OEBPS/images/。
 */
async function embedLocalImages(
  html: string,
  baseDir: string,
): Promise<{ html: string; embedded: number }> {
  const $ = cheerio.load(html, { xmlMode: false });
  let embedded = 0;
  for (const img of $('img').toArray()) {
    const src = $(img).attr('src');
    if (!src || /^(https?:|data:|file:|#)/i.test(src)) continue;
    const abs = path.resolve(baseDir, src);
    try {
      await fs.access(abs);
      // pathToFileURL 跨平台生成正确 file URL（Windows: file:///C:/...，
      // macOS/Linux: file:///Users/...），epub-gen 据此把图片收进 OEBPS/images/
      $(img).attr('src', pathToFileURL(abs).href);
      embedded++;
    } catch {
      // 图片缺失：保留原 src，不中断转换
    }
  }
  return { html: $.html(), embedded };
}

/**
 * Markdown → EPUB。mdPath 与 mdContent 二选一。
 */
export async function mdToEpub(options: EpubOptions): Promise<EpubResult> {
  const start = Date.now();
  const details = () => ({ processingTime: Date.now() - start });
  try {
    let mdText: string;
    let baseDir = process.cwd();
    if (options.mdContent !== undefined) {
      mdText = options.mdContent;
    } else if (options.mdPath) {
      try {
        mdText = await fs.readFile(options.mdPath, 'utf-8');
        baseDir = path.dirname(path.resolve(options.mdPath));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        throw new Error(code === 'ENOENT' ? `Markdown 文件不存在: ${options.mdPath}` : `Markdown 文件读取失败 (${code ?? 'UNKNOWN'}): ${options.mdPath}`);
      }
    } else {
      throw new Error('必须提供 mdPath 或 mdContent 之一');
    }

    const md = new MarkdownIt({ html: true, typographer: true });
    let body = md.render(mdText);

    if (options.embedImages !== false) {
      const res = await embedLocalImages(body, baseDir);
      body = res.html;
    }

    // 分章：按 h1 切分。每章 = 标题 + 其后内容，直到下一个 h1。
    const chapters: { title: string; data: string }[] = [];
    const split = options.splitByHeading === true;
    if (split) {
      const $ = cheerio.load(body);
      let currentTitle = '';
      let current: string[] = [];
      // 首个 h1 之前的内容（扉页、引言等）单独收进一章，不能静默丢弃
      const leading: string[] = [];
      const flush = () => {
        if (currentTitle || current.some((s) => s.trim())) {
          chapters.push({ title: currentTitle || '章节', data: current.join('') });
        }
        current = [];
      };
      // cheerio.load 会包一层 html/head/body，顶层内容须从 body 取
      for (const el of $('body').contents().toArray()) {
        if (el.type === 'tag' && el.tagName === 'h1') {
          flush();
          currentTitle = $(el).text().trim() || '章节';
          current.push($.html(el));
        } else if (currentTitle) {
          current.push($.html(el));
        } else {
          leading.push($.html(el));
        }
      }
      flush();
      if (leading.some((s) => s.trim())) {
        chapters.unshift({ title: '前言', data: leading.join('') });
      }
      if (chapters.length === 0) {
        chapters.push({ title: '章节', data: body });
      }
    } else {
      chapters.push({ title: options.title || '正文', data: body });
    }

    // 书名从标题参数或首个 h1 提取
    let title = options.title || '';
    if (!title) {
      const $ = cheerio.load(body);
      title = $('h1').first().text().trim() || 'Untitled';
    }

    const resolvedOutput = path.resolve(options.outputPath);
    await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });

    const bookOptions: EpubGenOptions = {
      title,
      ...(options.author ? { author: options.author } : {}),
      ...(options.publisher ? { publisher: options.publisher } : {}),
      ...(options.cover ? { cover: options.cover } : {}),
      ...(options.version ? { version: options.version as 2 | 3 } : {}),
      // 章节 data 已含 h1；epub-gen 默认 appendChapterTitles 会再前置
      // 一份 <h1>title</h1>，导致标题渲染两遍
      appendChapterTitles: false,
      verbose: false,
    };

    // epub-gen 构造签名：new Epub(options, output)，章节放 options.content
    const book = new Epub({ ...bookOptions, content: chapters }, resolvedOutput);
    await book.promise;

    const fileSize = (await fs.stat(resolvedOutput)).size;
    return {
      success: true,
      outputPath: resolvedOutput,
      chapters: chapters.length,
      title,
      fileSize,
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
