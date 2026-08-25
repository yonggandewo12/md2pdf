import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';

export interface PdfMergeResult {
  success: boolean;
  outputPath?: string;
  pageCount?: number;
  error?: string;
  details?: { processingTime: number };
}

export interface PdfSplitItem {
  path: string;
  pageCount: number;
  range: string;
}

export interface PdfSplitResult {
  success: boolean;
  outputFiles?: PdfSplitItem[];
  error?: string;
  details?: { processingTime: number };
}

export interface PdfExtractResult {
  success: boolean;
  outputPath?: string;
  pageCount?: number;
  error?: string;
  details?: { processingTime: number };
}

export interface PdfCompressResult {
  success: boolean;
  inputSize?: number;
  outputSize?: number;
  ratio?: number;
  outputPath?: string;
  error?: string;
  details?: { processingTime: number };
}

/**
 * Parse a page range spec like "1-3,5,7-9" into 0-based page indices.
 * Ranges are 1-based, inclusive on both ends. Results are deduplicated,
 * sorted, and clamped to [0, totalPages-1].
 * Throws on invalid syntax (negative numbers, descending ranges, etc.).
 */
export function parsePageRanges(spec: string, totalPages: number): number[] {
  if (totalPages <= 0) {
    throw new Error(`Invalid pageRanges: PDF has no pages (totalPages=${totalPages})`);
  }
  const pages = new Set<number>();

  const parts = spec.split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      throw new Error(`Invalid pageRanges syntax: empty segment in "${spec}"`);
    }

    const rangeMatch = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    const singleMatch = trimmed.match(/^(\d+)$/);

    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start < 1 || end < 1) {
        throw new Error(`Invalid pageRanges syntax: page numbers must be >= 1, got "${trimmed}"`);
      }
      if (start > end) {
        throw new Error(`Invalid pageRanges syntax: descending range "${trimmed}" (${start}>${end})`);
      }
      for (let i = start; i <= end; i++) {
        pages.add(Math.min(i - 1, totalPages - 1));
      }
    } else if (singleMatch) {
      const page = parseInt(singleMatch[1], 10);
      if (page < 1) {
        throw new Error(`Invalid pageRanges syntax: page number must be >= 1, got "${trimmed}"`);
      }
      pages.add(Math.min(page - 1, totalPages - 1));
    } else {
      throw new Error(`Invalid pageRanges syntax: cannot parse "${trimmed}" in "${spec}"`);
    }
  }

  return [...pages].sort((a, b) => a - b);
}

/**
 * Merge multiple PDFs into a single output file.
 */
export async function mergePdfs(
  pdfPaths: string[],
  outputPath: string,
): Promise<PdfMergeResult> {
  const start = Date.now();
  try {
    if (!pdfPaths || !Array.isArray(pdfPaths) || pdfPaths.length === 0) {
      return { success: false, error: 'pdfPaths must be a non-empty array', details: { processingTime: Date.now() - start } };
    }
    for (const p of pdfPaths) {
      if (!fs.existsSync(p)) {
        return { success: false, error: `PDF not found: ${p}`, details: { processingTime: Date.now() - start } };
      }
    }

    const out = await PDFDocument.create();
    let totalPages = 0;

    for (const p of pdfPaths) {
      const bytes = await fs.promises.readFile(p);
      const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const srcPages = src.getPageIndices();
      const pages = await out.copyPages(src, srcPages);
      for (const page of pages) {
        out.addPage(page);
      }
      totalPages += srcPages.length;
    }

    const outputBytes = await out.save({ useObjectStreams: true });
    const resolvedOutput = path.resolve(outputPath);
    await fs.promises.mkdir(path.dirname(resolvedOutput), { recursive: true });
    await fs.promises.writeFile(resolvedOutput, outputBytes);

    return {
      success: true,
      outputPath: resolvedOutput,
      pageCount: totalPages,
      details: { processingTime: Date.now() - start },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      details: { processingTime: Date.now() - start },
    };
  }
}

/**
 * Build a list of continuous ranges from page indices.
 * e.g. [0,1,2,4,6,7,8] → [[0,2], [4,4], [6,8]]
 */
function buildContinuousRanges(indices: number[]): [number, number][] {
  if (indices.length === 0) return [];
  const ranges: [number, number][] = [];
  let rangeStart = indices[0];
  let rangeEnd = indices[0];
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] === rangeEnd + 1) {
      rangeEnd = indices[i];
    } else {
      ranges.push([rangeStart, rangeEnd]);
      rangeStart = indices[i];
      rangeEnd = indices[i];
    }
  }
  ranges.push([rangeStart, rangeEnd]);
  return ranges;
}

/**
 * Split a PDF by page ranges into multiple files.
 * pageRanges syntax: "1-3,5,7-9" (1-based, inclusive).
 */
export async function splitPdf(
  pdfPath: string,
  pageRanges: string,
  outputDir?: string,
  outputNamePrefix?: string,
): Promise<PdfSplitResult> {
  const start = Date.now();
  try {
    if (!fs.existsSync(pdfPath)) {
      return { success: false, error: `PDF not found: ${pdfPath}`, details: { processingTime: Date.now() - start } };
    }

    const bytes = await fs.promises.readFile(pdfPath);
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const totalPages = src.getPageCount();
    const indices = parsePageRanges(pageRanges, totalPages);
    const ranges = buildContinuousRanges(indices);

    const stem = path.basename(pdfPath, path.extname(pdfPath));
    const dir = outputDir ? path.resolve(outputDir) : path.join(path.dirname(pdfPath), `${stem}_split`);
    const prefix = outputNamePrefix || stem;

    await fs.promises.mkdir(dir, { recursive: true });

    const outputFiles: PdfSplitItem[] = [];

    for (const [rangeStart, rangeEnd] of ranges) {
      const out = await PDFDocument.create();
      const srcPages = await out.copyPages(src, rangeAll(rangeStart, rangeEnd));
      for (const page of srcPages) {
        out.addPage(page);
      }
      const from = rangeStart + 1;
      const to = rangeEnd + 1;
      const filename = `${prefix}_${from}-${to}.pdf`;
      const outPath = path.join(dir, filename);
      await fs.promises.writeFile(outPath, await out.save({ useObjectStreams: true }));
      outputFiles.push({ path: outPath, pageCount: rangeEnd - rangeStart + 1, range: `${from}-${to}` });
    }

    return {
      success: true,
      outputFiles,
      details: { processingTime: Date.now() - start },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      details: { processingTime: Date.now() - start },
    };
  }
}

function rangeAll(start: number, end: number): number[] {
  const result: number[] = [];
  for (let i = start; i <= end; i++) result.push(i);
  return result;
}

/**
 * Extract specific pages from a PDF into a single output file.
 */
export async function extractPages(
  pdfPath: string,
  pageRanges: string,
  outputPath: string,
): Promise<PdfExtractResult> {
  const start = Date.now();
  try {
    if (!fs.existsSync(pdfPath)) {
      return { success: false, error: `PDF not found: ${pdfPath}`, details: { processingTime: Date.now() - start } };
    }

    const bytes = await fs.promises.readFile(pdfPath);
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const totalPages = src.getPageCount();
    const indices = parsePageRanges(pageRanges, totalPages);

    const out = await PDFDocument.create();
    const srcPages = await out.copyPages(src, indices);
    for (const page of srcPages) {
      out.addPage(page);
    }

    const resolvedOutput = path.resolve(outputPath);
    await fs.promises.mkdir(path.dirname(resolvedOutput), { recursive: true });
    await fs.promises.writeFile(resolvedOutput, await out.save({ useObjectStreams: true }));

    return {
      success: true,
      outputPath: resolvedOutput,
      pageCount: indices.length,
      details: { processingTime: Date.now() - start },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      details: { processingTime: Date.now() - start },
    };
  }
}

/**
 * Re-compress a PDF by re-saving (removes incremental updates, re-packs objects).
 * Returns input/output size ratio.
 */
export async function compressPdf(
  pdfPath: string,
  outputPath?: string,
  useObjectStreams = true,
): Promise<PdfCompressResult> {
  const start = Date.now();
  try {
    if (!fs.existsSync(pdfPath)) {
      return { success: false, error: `PDF not found: ${pdfPath}`, details: { processingTime: Date.now() - start } };
    }

    const inputSize = (await fs.promises.stat(pdfPath)).size;
    const bytes = await fs.promises.readFile(pdfPath);
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const outBytes = await src.save({ useObjectStreams });

    const resolvedOutput = outputPath ? path.resolve(outputPath) : path.resolve(pdfPath);
    const inPlace = resolvedOutput === path.resolve(pdfPath);
    if (!inPlace) {
      await fs.promises.mkdir(path.dirname(resolvedOutput), { recursive: true });
    }
    if (inPlace) {
      // 原地覆盖：先写同目录临时文件再原子替换，避免写入中途失败损坏原文件
      const tmp = path.join(
        path.dirname(resolvedOutput),
        `.${path.basename(resolvedOutput)}.${process.pid}.tmp`,
      );
      await fs.promises.writeFile(tmp, outBytes);
      await fs.promises.rename(tmp, resolvedOutput);
    } else {
      await fs.promises.writeFile(resolvedOutput, outBytes);
    }
    const outputSize = outBytes.length;

    return {
      success: true,
      inputSize,
      outputSize,
      ratio: outputSize > 0 ? Math.round((outputSize / inputSize) * 1000) / 1000 : 1,
      outputPath: resolvedOutput,
      details: { processingTime: Date.now() - start },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      details: { processingTime: Date.now() - start },
    };
  }
}