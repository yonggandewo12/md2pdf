import { promises as fs } from 'fs';
import * as path from 'path';
import { imageSize } from 'image-size';
import { MdToPdfOptions, ConvertMdResult, MdConvertStats, PAPER_FORMAT_DIMENSIONS } from './types.js';
import { PdfConverter } from './pdf-converter.js';
import { probePdf, PdfProbeResult } from './pdf-probe.js';
import markdownit from 'markdown-it';
import anchor from 'markdown-it-anchor';
import { mermaidBundleSource, escapeInlineScript } from './mermaid-bundle.js';

// ── Pattern constants ──────────────────────────────────────────────

const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const TOC_HEADING_RE = /^\s{0,3}#{2,6}\s+(?:目录|目錄|contents?|table of contents)\s*$/i;
const TOC_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[[^\]]+\]\(#[^)]+\)\s*$/;
const HR_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;

/** Parse a CSS length string (mm/cm/in/pt/px) to CSS pixels. */
function parseCssLen(val: string | undefined, def: string): number {
  const s = (val || def).trim().toLowerCase();
  if (s.endsWith('mm')) return parseFloat(s) * 96 / 25.4;
  if (s.endsWith('cm')) return parseFloat(s) * 96 / 2.54;
  if (s.endsWith('in')) return parseFloat(s) * 96;
  if (s.endsWith('px')) return parseFloat(s);
  if (s.endsWith('pt')) return parseFloat(s) * 96 / 72;
  return 37.8; // ~10mm fallback
}

// ── Helpers ────────────────────────────────────────────────────────

function isExternal(src: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src) || src.startsWith('//');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Markdown pre-processing ────────────────────────────────────────

interface ImageDim {
  width: number;
  height: number;
}

async function embedImages(
  text: string,
  baseDir: string,
): Promise<{ text: string; dims: ImageDim[] }> {
  const matches: { index: number; full: string; replacement: Promise<{ md: string; dim?: ImageDim }> }[] = [];
  let m: RegExpExecArray | null;
  MD_IMAGE_RE.lastIndex = 0;

  while ((m = MD_IMAGE_RE.exec(text)) !== null) {
    const [full, alt, src] = m;
    if (isExternal(src)) continue;
    const imagePath = path.resolve(baseDir, src);
    matches.push({
      index: m.index,
      full,
      replacement: fs.stat(imagePath).then(async () => {
        const ext = path.extname(imagePath).toLowerCase();
        const mimeMap: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.svg': 'image/svg+xml',
          '.bmp': 'image/bmp',
        };
        const mime = mimeMap[ext] || 'application/octet-stream';
        const data = await fs.readFile(imagePath);
        // 尺寸探测失败（非常规格式等）只影响 landscape 建议统计，不阻塞嵌入
        let dim: ImageDim | undefined;
        try {
          const size = imageSize(data);
          if (size.width && size.height) {
            dim = { width: size.width, height: size.height };
          }
        } catch {
          // ignore
        }
        return {
          md: `![${alt}](data:${mime};base64,${data.toString('base64')})`,
          dim,
        };
      }).catch(() => ({ md: full })),
    });
  }

  // Wait for all replacements
  const replacements = await Promise.all(matches.map((m) => m.replacement));

  // Replace from end to start to preserve earlier indices
  let resultText = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { index, full } = matches[i];
    resultText = resultText.slice(0, index) + replacements[i].md + resultText.slice(index + full.length);
  }

  const dims = replacements.map((r) => r.dim).filter((d): d is ImageDim => d !== undefined);
  return { text: resultText, dims };
}

function normalizeMarkdown(text: string): string {
  text = text.replace(/｜/g, '|');
  const lines = text.split('\n');
  const normalized: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim();

    if (stripped.startsWith('```') || stripped.startsWith('~~~')) {
      inFence = !inFence;
    }

    // If current line starts a list item and previous line is non-empty non-list → insert blank
    if (
      !inFence &&
      LIST_ITEM_RE.test(line) &&
      normalized.length > 0 &&
      normalized[normalized.length - 1].trim() &&
      !LIST_ITEM_RE.test(normalized[normalized.length - 1])
    ) {
      normalized.push('');
    }

    normalized.push(line);

    // If current line is a list item and next line is non-empty non-list non-indented → insert blank
    const nextLine = lines[i + 1];
    if (
      !inFence &&
      LIST_ITEM_RE.test(line) &&
      nextLine !== undefined &&
      nextLine.trim() &&
      !LIST_ITEM_RE.test(nextLine) &&
      !nextLine.startsWith(' ') &&
      !nextLine.startsWith('\t')
    ) {
      normalized.push('');
    }
  }

  return normalized.join('\n') + (text.endsWith('\n') ? '\n' : '');
}

function stripInlineToc(text: string): string {
  const lines = text.split('\n');
  const stripped: string[] = [];
  let i = 0;
  let inFence = false;

  while (i < lines.length) {
    const line = lines[i];
    const marker = line.trim();

    if (marker.startsWith('```') || marker.startsWith('~~~')) {
      inFence = !inFence;
      stripped.push(line);
      i++;
      continue;
    }

    if (!inFence && TOC_HEADING_RE.test(line)) {
      // Skip blank lines after heading
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;

      // Count consecutive TOC item lines
      let itemCount = 0;
      while (j < lines.length && TOC_ITEM_RE.test(lines[j])) {
        itemCount++;
        j++;
      }

      if (itemCount >= 2) {
        // Skip trailing blank lines
        while (j < lines.length && !lines[j].trim()) j++;

        // Skip optional HR separator
        if (j < lines.length && HR_RE.test(lines[j])) {
          j++;
        }

        // Skip trailing blank lines after HR
        while (j < lines.length && !lines[j].trim()) j++;

        i = j;
        continue;
      }
    }

    stripped.push(line);
    i++;
  }

  return stripped.join('\n') + (text.endsWith('\n') ? '\n' : '');
}

function titleFromBody(body: string): string {
  const match = body.match(/<h1[^>]*>(.*?)<\/h1>/s);
  if (!match) return 'Markdown Report';
  return match[1].replace(/<.*?>/g, '').trim() || 'Markdown Report';
}

// ── 分页质量辅助 ────────────────────────────────────────────────────

/**
 * 删除紧邻 h1/h2 的 <hr>（节间 `---` 分隔线的渲染产物）。
 *
 * 打印 CSS 中 h2 自带 border-top 分隔线且 page-break-before: always；
 * 上节内容恰好满页时该 hr 会被单独挤成一页，紧随其后的 h2 又强制翻页，
 * 产生纯空白页，故渲染后移除。只处理 hr 的下一个兄弟元素是 h1/h2 的情况，
 * 正文中间的 hr 分隔线不受影响。
 */
export function stripHrBeforeHeadings(body: string): { body: string; removed: number } {
  let removed = 0;
  const result = body.replace(/<hr\s*\/?>\s*(?=<h[12][\s>])/g, () => {
    removed++;
    return '';
  });
  return { body: result, removed };
}

// 横向图建议触发条件：本地嵌入图 ≥ 3 张，且横向图（宽 > 高 × 1.2）占比 ≥ 60%
const LANDSCAPE_SUGGEST_MIN_IMAGES = 3;
const LANDSCAPE_SUGGEST_SHARE = 0.6;

/**
 * 竖版 PDF 中横向大图会被压缩连排、页数骤变，故嵌入图以横向为主且调用方
 * 未显式传 landscape 时，在 stats.warnings 输出建议；显式指定（true/false 均算）
 * 视为调用方已知情，不提示。
 */
export function buildLandscapeWarning(
  dims: ImageDim[],
  landscapeExplicit?: boolean,
): string | undefined {
  if (landscapeExplicit !== undefined || dims.length < LANDSCAPE_SUGGEST_MIN_IMAGES) return undefined;
  const landscapeCount = dims.filter((d) => d.width > d.height * 1.2).length;
  if (landscapeCount / dims.length < LANDSCAPE_SUGGEST_SHARE) return undefined;
  return (
    `${landscapeCount} of ${dims.length} embedded images are landscape-oriented; ` +
    'consider landscape: true for better page usage'
  );
}

// ── Mermaid handling ───────────────────────────────────────────────

function renderMermaidBlocks(body: string): { body: string; count: number } {
  const MERMAID_PRE_RE = /<pre><code class="[^"]*\blanguage-mermaid\b[^"]*">(.*?)<\/code><\/pre>/gs;
  let count = 0;
  const result = body.replace(MERMAID_PRE_RE, (_, content) => {
    count++;
    const diagram = escapeHtml(content.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'));
    return `<div class="mermaid">${diagram}</div>`;
  });
  return { body: result, count };
}

function buildMermaidJs(source: string, pdfContentW?: number, pdfContentH?: number): string {
  if (source === 'none') return '';

  const bundled = mermaidBundleSource();
  if (!bundled) return '';
  const loader = `<script>${escapeInlineScript(bundled)}</script>`;

  // Embed PDF content dimensions so browser JS can use them
  const pdfW = pdfContentW ?? 0;
  const pdfH = pdfContentH ?? 0;

  return `
  ${loader}
  <script>
    (() => {
      // 默认标记为完成（无 mermaid 或加载失败时 PDF 不会卡住）
      window.__mermaidDone = true;
      if (!window.mermaid) return;
      window.mermaid.initialize({
        securityLevel: 'loose',
        theme: 'base',
        themeVariables: {
          primaryColor: '#eef7f5',
          primaryTextColor: '#1c2430',
          primaryBorderColor: '#0f766e',
          lineColor: '#2563eb',
          secondaryColor: '#eef4f8',
          tertiaryColor: '#ffffff',
          mainBkg: '#ffffff',
          clusterBkg: '#fbfcfe',
          clusterBorder: '#dbe2ea',
          edgeLabelBackground: '#ffffff',
          textColor: '#1c2430',
          titleColor: '#0f172a',
          nodeTextColor: '#1c2430',
          xyChart: {
            backgroundColor: '#fbfcfe',
            titleColor: '#0f172a',
            xAxisLabelColor: '#475467',
            xAxisTitleColor: '#344054',
            xAxisTickColor: '#dbe2ea',
            xAxisLineColor: '#dbe2ea',
            yAxisLabelColor: '#475467',
            yAxisTitleColor: '#344054',
            yAxisTickColor: '#dbe2ea',
            yAxisLineColor: '#dbe2ea',
            plotColorPalette: '#0f766e, #2563eb, #94a3b8, #c2410c'
          },
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
        }
      });

      // 自适应缩放 Mermaid SVG：
      //   - 用 PDF 内容区域尺寸（页面减边距）确保大图不跨页
      //   - 展开容器穿透 article padding，使图可用满页宽
      //   - 目标 ~90%，小图放大不超过 1.8 倍
      function scaleMermaidDiagrams() {
        var pdfW = ${pdfW} || document.documentElement.clientWidth || window.innerWidth;
        var pdfH = ${pdfH} || document.documentElement.clientHeight || window.innerHeight;
        document.querySelectorAll('.mermaid svg').forEach(function(svg) {
          svg.style.width = '';
          svg.style.height = '';
          var rect = svg.getBoundingClientRect();
          var svgW = rect.width;
          var svgH = rect.height;
          if (svgW === 0 || svgH === 0) return;
          var container = svg.closest('.mermaid');
          if (!container) return;

          // 展开容器穿透 article padding
          var article = container.parentElement;
          var ps = getComputedStyle(article);
          container.style.marginLeft = '-' + parseFloat(ps.paddingLeft) + 'px';
          container.style.marginRight = '-' + parseFloat(ps.paddingRight) + 'px';
          container.style.maxWidth = 'none';

          var containerW = container.getBoundingClientRect().width;
          if (containerW === 0) return;

          // 目标：PDF 内容区域的 ~90%，比例缩放
          var targetW = Math.min(containerW, pdfW) * 0.9;
          var targetH = pdfH * 0.9;
          var scale = Math.min(targetW / svgW, targetH / svgH);
          // 小图放大不超过 1.8 倍
          scale = Math.min(scale, 1.8);
          // 变化 >5% 才应用
          if (Math.abs(scale - 1) > 0.05) {
            svg.style.width = Math.round(svgW * scale) + 'px';
            svg.style.height = Math.round(svgH * scale) + 'px';
          }
        });
      }

      window.mermaid.run({ querySelector: '.mermaid' }).then(function() {
        scaleMermaidDiagrams();
        window.__mermaidDone = true;
      });
    })();
  </script>
`;
}

function buildJs(): string {
  return `
  <script>
    (() => {
      const progress = document.querySelector('.progress');
      const topBtn = document.querySelector('.back-top');

      function onScroll() {
        const max = document.documentElement.scrollHeight - innerHeight;
        if (progress) progress.style.width = max > 0 ? \`\${scrollY / max * 100}%\` : '0%';
        if (topBtn) topBtn.classList.toggle('show', scrollY > innerHeight);
      }

      addEventListener('scroll', onScroll, { passive: true });
      topBtn?.addEventListener('click', () => scrollTo({ top: 0, behavior: 'smooth' }));
      onScroll();

      // 标记紧跟在 h1 后面、中间只有空白的 h2，避免 PDF 分页
      function markHeadingContinuations() {
        const h1s = document.querySelectorAll('article h1, article [role="doc-cover"] h1');
        h1s.forEach((h1) => {
          let node = h1.nextSibling;
          while (node && node.nodeType === Node.TEXT_NODE && /^\\s*$/.test(node.textContent || '')) {
            node = node.nextSibling;
          }
          while (node && node.nodeType === Node.ELEMENT_NODE) {
            const el = node as Element;
            if (el.tagName === 'H2') {
              el.classList.add('no-break-before');
              break;
            }
            // 只跳过空段落、空 div、hr、br 等无内容的分隔元素
            const isEmpty =
              el.tagName === 'HR' ||
              el.tagName === 'BR' ||
              ((el.tagName === 'P' || el.tagName === 'DIV') &&
                /^\\s*$/.test(el.textContent || '') &&
                el.querySelectorAll('img, svg, table, pre, blockquote, iframe, canvas, video, audio, embed, object').length === 0);
            if (!isEmpty) break;
            node = node.nextSibling;
            while (node && node.nodeType === Node.TEXT_NODE && /^\\s*$/.test(node.textContent || '')) {
              node = node.nextSibling;
            }
          }
        });
      }
      markHeadingContinuations();
    })();
  </script>
`;
}

// ── HTML template ──────────────────────────────────────────────────

function buildHtml(
  title: string,
  body: string,
  withJs: boolean,
  mermaidSource: string,
  pdfContentW?: number,
  pdfContentH?: number,
): string {
  const progress = withJs ? '<div class="progress"></div>' : '';
  const backTop = withJs
    ? '<button class="back-top" type="button" aria-label="返回顶部">↑</button>'
    : '';
  const js = withJs ? buildJs() : '';
  const mermaidJs = buildMermaidJs(mermaidSource, pdfContentW, pdfContentH);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #f7f8fb;
      --paper: #ffffff;
      --ink: #1c2430;
      --muted: #667085;
      --line: #dbe2ea;
      --accent: #0f766e;
      --accent-2: #2563eb;
      --soft: #eef7f5;
      --shadow: 0 18px 45px rgba(15, 23, 42, .08);
      --radius: 8px;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at 12% 0%, rgba(15, 118, 110, .09), transparent 30%),
        linear-gradient(180deg, #f3f7fa 0%, var(--bg) 360px, var(--bg) 100%);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      line-height: 1.75;
      letter-spacing: 0;
    }
    a { color: var(--accent-2); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .progress { position: fixed; inset: 0 auto auto 0; width: 0; height: 3px; z-index: 10; background: linear-gradient(90deg, var(--accent), var(--accent-2)); }
    .layout {
      max-width: 1060px;
      margin: 0 auto;
      padding: 28px;
    }
    main {
      background: var(--paper);
      border: 1px solid rgba(219, 226, 234, .9);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    article { padding: 46px min(6vw, 76px) 68px; }
    h1 {
      margin: -46px min(-6vw, -76px) 34px;
      padding: 58px min(6vw, 76px) 44px;
      color: #fff;
      background: linear-gradient(135deg, #0f766e 0%, #155e75 52%, #1d4ed8 100%);
      font-size: clamp(30px, 4vw, 52px);
      line-height: 1.14;
      font-weight: 800;
    }
    h2 {
      margin: 54px 0 18px;
      padding-top: 8px;
      border-top: 1px solid var(--line);
      font-size: clamp(22px, 2.3vw, 30px);
      line-height: 1.35;
      color: #0f172a;
    }
    h3 { margin: 34px 0 12px; font-size: 21px; color: #17324d; }
    h4 { margin: 26px 0 10px; font-size: 17px; color: #344054; }
    p { margin: 12px 0; }
    strong { color: #0f172a; font-weight: 700; }
    hr { border: 0; border-top: 1px solid var(--line); margin: 28px 0; }
    blockquote {
      margin: 18px 0 24px;
      padding: 12px 16px;
      color: #475467;
      background: var(--soft);
      border-left: 4px solid var(--accent);
      border-radius: 0 var(--radius) var(--radius) 0;
    }
    ul, ol { padding-left: 1.35em; }
    li { margin: 4px 0; }
    .table-scroll {
      width: 100%;
      overflow-x: auto;
      margin: 18px 0 28px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: #fff;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 0;
      font-size: 14px;
      line-height: 1.55;
      table-layout: auto;
    }
    th, td {
      min-width: 112px;
      padding: 11px 13px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
      background: #fff;
    }
    th {
      color: #0f172a;
      background: #eef4f8;
      font-weight: 700;
      white-space: nowrap;
    }
    tr:nth-child(even) td { background: #fbfcfe; }
    tr:last-child td { border-bottom: 0; }
    img {
      display: block;
      max-width: 100%;
      height: auto;
      margin: 24px auto 8px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: 0 12px 28px rgba(15, 23, 42, .08);
      background: #fff;
    }
    code {
      padding: 2px 5px;
      border-radius: 5px;
      background: #f1f5f9;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: .92em;
    }
    pre { overflow: auto; padding: 16px; background: #0f172a; color: #e5e7eb; border-radius: var(--radius); }
    pre code { padding: 0; color: inherit; background: transparent; }
    .mermaid {
      margin: 26px 0 30px;
      padding: 18px;
      overflow-x: auto;
      text-align: center;
      background: #fbfcfe;
      border: 1px solid var(--line);
      border-radius: var(--radius);
    }
    .mermaid svg { max-width: none; height: auto; }
    .back-top {
      display: none;
      position: fixed;
      right: 18px;
      bottom: 18px;
      width: 42px;
      height: 42px;
      border: 0;
      border-radius: 999px;
      color: #fff;
      background: var(--accent);
      box-shadow: 0 8px 22px rgba(15, 23, 42, .2);
      cursor: pointer;
    }
    .back-top.show { display: block; }
    @media (max-width: 1020px) {
      .layout { padding: 14px; }
      article { padding: 28px 18px 42px; }
      h1 { margin: -28px -18px 28px; padding: 38px 18px 32px; }
      th, td { min-width: 120px; padding: 10px; }
    }
    @media print {
      body { background: #fff; }
      .layout { max-width: none; padding: 0; }
      .progress, .back-top { display: none !important; }
      main { border: 0; box-shadow: none; }
      article { padding: 0; }
      h1 { margin: 0 0 24px; color: #111827; background: none; padding: 0; }
      h1:not(:first-of-type) { page-break-before: always; }
      h2 { page-break-before: always; }
      h1 + h2 { page-break-before: avoid; }
      h2.no-break-before { page-break-before: avoid; }
      a { color: inherit; }
      .table-scroll, table { page-break-inside: avoid; }
      img, blockquote, pre { page-break-inside: avoid; box-shadow: none; }
      .mermaid {
        page-break-inside: avoid;
        break-inside: avoid;
        page-break-before: auto;
      }
    }
  </style>
</head>
<body>
  ${progress}
  <div class="layout">
    <main>
      <article>
        ${body}
      </article>
    </main>
  </div>
  ${backTop}
  ${mermaidJs}
  ${js}
</body>
</html>`;
}

// ── MdConverter class ──────────────────────────────────────────────

export class MdConverter {
  /**
   * Convert markdown to full HTML string.
   * Returns the HTML content and optional stats.
   */
  async convertMdToHtml(
    mdContent: string,
    options: MdToPdfOptions,
    baseDir?: string,
  ): Promise<{ html: string; stats: MdConvertStats }> {
    let text = mdContent;

    // 1. Normalize markdown
    text = normalizeMarkdown(text);

    // 2. Strip inline TOC
    if (!options.keepInlineToc) {
      text = stripInlineToc(text);
    }

    // 3. Embed images
    const embedImagesEnabled = options.embedImages !== false;
    const imageDims: ImageDim[] = [];
    if (embedImagesEnabled && baseDir) {
      const embedded = await embedImages(text, baseDir);
      text = embedded.text;
      imageDims.push(...embedded.dims);
    }

    // Count embedded images before conversion
    const embeddedImagesCount = (text.match(/data:image\//g) || []).length;

    // 4. Setup markdown-it with extensions
    const md = markdownit({
      html: true,
      typographer: true,
    });
    md.use(anchor, {
      permalink: false,
      separator: '-',
      slugify: (s: string) => s.trim().replace(/\s+/g, '-'),
    });

    // 5. Parse and render to HTML
    const tokens = md.parse(text, {});
    let body = md.renderer.render(tokens, md.options, {});

    // 5.5 删除紧邻 h1/h2 的 hr（节间 --- 分隔线），防止被分页挤成独立空白页
    const hrStripped = stripHrBeforeHeadings(body);
    body = hrStripped.body;

    // 6. Wrap tables in .table-scroll
    body = body.replace(/(<table[\s>][\s\S]*?<\/table>)/g, '<div class="table-scroll">$1</div>');

    // 7. Render mermaid blocks
    const { body: bodyWithMermaid, count: mermaidCount } = renderMermaidBlocks(body);

    // 7.5 Fix internal anchor links to match heading ids.
    // markdown-it may URL-encode Chinese fragments and drop punctuation,
    // so we build a normalised lookup: strip all non-alphanumeric-CJK chars,
    // lower-case, then match.
    const normalizeAnchor = (s: string): string =>
      decodeURIComponent(s)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]/gu, '');

    const headingIdLookup = new Map<string, string>();
    for (const m of bodyWithMermaid.matchAll(/<h[1-6]\b[^>]*\bid="([^"]*)"/gi)) {
      headingIdLookup.set(normalizeAnchor(m[1]), m[1]);
    }
    const fixedBody = bodyWithMermaid.replace(
      /(<a\s+[^>]*href=")#([^"]+)"/gi,
      (full, prefix, fragment) => {
        const match = headingIdLookup.get(normalizeAnchor(fragment));
        return match ? `${prefix}#${match}"` : full;
      },
    );

    // 8. Determine mermaid source：启用时一律内置本地脚本（无 CDN 分支）
    let mermaidSource = 'none' as string;
    if (mermaidCount && options.mermaidSource !== 'none') {
      mermaidSource = 'local';
    }

    // 9. Compute PDF content area for mermaid scaling (page minus margins)
    let pdfContentW: number | undefined;
    let pdfContentH: number | undefined;
    if (mermaidSource !== 'none') {
      const dims = PAPER_FORMAT_DIMENSIONS[options.format || 'A4'] || PAPER_FORMAT_DIMENSIONS.A4!;
      const pw = options.landscape ? dims.height : dims.width;
      const ph = options.landscape ? dims.width : dims.height;
      const mt = parseCssLen(options.marginTop, '10mm');
      const mb = parseCssLen(options.marginBottom, '10mm');
      const ml = parseCssLen(options.marginLeft, '10mm');
      const mr = parseCssLen(options.marginRight, '10mm');
      pdfContentW = Math.round(pw - ml - mr);
      pdfContentH = Math.round(ph - mt - mb);
    }

    // 10. Build final HTML
    const title = titleFromBody(fixedBody);
    const fullHtml = buildHtml(
      title,
      fixedBody,
      options.withJs || false,
      mermaidSource,
      pdfContentW,
      pdfContentH,
    );

    // 11. Compute stats
    const tableCount = (fixedBody.match(/<table[\s>]/g) || []).length;
    const imageCount = (fixedBody.match(/<img[\s>]/g) || []).length;

    // 12. Non-fatal warnings: landscape suggestion based on embedded image aspect ratios
    const warnings: string[] = [];
    const landscapeWarn = buildLandscapeWarning(imageDims, options.landscape);
    if (landscapeWarn) warnings.push(landscapeWarn);

    return {
      html: fullHtml,
      stats: {
        tables: tableCount,
        images: imageCount,
        embeddedImages: embeddedImagesCount,
        mermaid: mermaidCount,
        mermaidSource: mermaidSource !== 'none' ? mermaidSource : undefined,
        removedHrs: hrStripped.removed,
        ...(warnings.length ? { warnings } : {}),
      },
    };
  }

  /**
   * Convert markdown file or content to PDF.
   * Internally: MD → HTML → Puppeteer PDF (reuses PdfConverter).
   */
  async convertMdToPdf(
    options: MdToPdfOptions,
    pdfConverter: PdfConverter,
  ): Promise<ConvertMdResult> {
    const startTime = Date.now();

    try {
      // Validate input
      if (!options.mdPath && !options.mdContent) {
        throw new Error('Either mdPath or mdContent must be provided');
      }

      // Read markdown
      let mdContent: string;
      let baseDir: string | undefined;

      if (options.mdPath) {
        const mdPath = path.resolve(options.mdPath);
        await fs.access(mdPath);
        mdContent = await fs.readFile(mdPath, 'utf-8');
        baseDir = path.dirname(mdPath);
      } else {
        mdContent = options.mdContent!;
        baseDir = undefined;
      }

      // Convert MD to HTML
      const { html, stats } = await this.convertMdToHtml(mdContent, options, baseDir);

      // Convert HTML to PDF using existing PdfConverter
      const pdfResult = await pdfConverter.convertToPdf({
        htmlContent: html,
        outputPath: options.outputPath,
        format: options.format,
        landscape: options.landscape,
        printBackground: options.printBackground,
        scale: options.scale,
        marginTop: options.marginTop,
        marginBottom: options.marginBottom,
        marginLeft: options.marginLeft,
        marginRight: options.marginRight,
        displayHeaderFooter: options.displayHeaderFooter,
        headerTemplate: options.headerTemplate,
        footerTemplate: options.footerTemplate,
        waitForNetworkIdle: options.waitForNetworkIdle,
        timeout: options.timeout,
        waitForMermaid: !!stats.mermaid && options.mermaidSource !== 'none',
      });

      if (pdfResult.success) {
        const processingTime = Date.now() - startTime;

        // 转换后自检：读输出 PDF 回传页数/页面尺寸/完全空白页。
        // 探测失败（损坏/读取错误）只丢失自检信息，不影响转换结果。
        let probe: PdfProbeResult | undefined;
        if (pdfResult.outputPath) {
          probe = await probePdf(pdfResult.outputPath).catch(() => undefined);
        }
        const finalStats: MdConvertStats = probe?.blankPages.length
          ? {
              ...stats,
              warnings: [
                ...(stats.warnings ?? []),
                `Blank pages detected in output PDF: ${probe.blankPages.join(', ')}`,
              ],
            }
          : stats;

        return {
          success: true,
          outputPath: pdfResult.outputPath,
          details: {
            processingTime,
            fileSize: pdfResult.details?.fileSize,
            stats: finalStats,
            pageCount: probe?.pageCount,
            pageSize: probe?.pageSize,
            blankPages: probe?.blankPages,
          },
        };
      } else {
        return {
          success: false,
          error: pdfResult.error,
          details: { processingTime: Date.now() - startTime },
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        details: { processingTime: Date.now() - startTime },
      };
    }
  }
}
