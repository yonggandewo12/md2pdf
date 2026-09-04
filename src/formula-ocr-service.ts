/**
 * 公式 OCR 服务：formula_ocr 工具的实现后端。
 *
 * 图片 → LaTeX 公式。模型为 RapidLaTeXOCR 的 ONNX 导出版
 * （源自 LaTeX-OCR/pix2tex，GitHub Release 分发）：
 *   image_resizer.onnx + encoder.onnx + decoder.onnx + tokenizer.json
 * 推理通过 onnxruntime-node（已在依赖中），图像解码/缩放用 jimp（纯 JS）。
 *
 * 模型惰性加载：首次调用才下载（约 180MB）到缓存目录并创建 session，
 * 之后完全离线；下载/加载失败仅本工具报错，不影响 server 与其他工具。
 *
 * 预处理与自回归解码逻辑对齐 RapidLaTeXOCR（Python）实现：
 * pad → minmax_size → 迭代 image_resizer 定宽 → encoder → decoder 逐步生成。
 * temperature 固定 1e-5，softmax 采样退化为 argmax，输出确定。
 *
 * 环境变量 FORMULA_OCR_MODEL_DIR 可覆盖模型缓存目录。
 *
 * @author Liang.Xu
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Jimp } from 'jimp';

/** jimp 类型存在双解析（resolution-mode import/require），用返回值类型规避 */
type JimpImage = Awaited<ReturnType<typeof Jimp.read>>;

const MODEL_BASE_URL = 'https://github.com/RapidAI/RapidLaTeXOCR/releases/download/v0.0.0';
const MODEL_FILES = ['image_resizer.onnx', 'encoder.onnx', 'decoder.onnx', 'tokenizer.json'] as const;
const CACHE_DIR =
  process.env.FORMULA_OCR_MODEL_DIR || path.join(os.homedir(), '.cache', 'general-tools-mcp', 'formula-ocr');

// RapidLaTeXOCR 默认推理参数（config.yaml）
const MAX_WIDTH = 672;
const MAX_HEIGHT = 192;
const MIN_WIDTH = 32;
const MIN_HEIGHT = 32;
const BOS_TOKEN = 1;
const EOS_TOKEN = 2;
const MAX_SEQ_LEN = 512;
// temperature=1e-5 时 softmax 采样概率集中到 argmax，直接取 argmax 输出确定

export interface FormulaOcrOptions {
  imagePath?: string;
  imageBase64?: string;
  /** 识别结果另存为 .tex/.txt 文件。 */
  outputPath?: string;
}

export interface FormulaOcrResult {
  success: boolean;
  latex?: string;
  elapsedMs?: number;
  modelDir?: string;
  downloaded?: string[];
  error?: string;
}

/** 灰度图（0-255 浮点），行主序。 */
interface GrayImage {
  w: number;
  h: number;
  data: Float32Array;
}

// ---------------------------------------------------------------------------
// 模型下载与缓存
// ---------------------------------------------------------------------------

async function ensureModelFiles(): Promise<{ dir: string; downloaded: string[] }> {
  await fs.promises.mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
  const downloaded: string[] = [];
  for (const file of MODEL_FILES) {
    const dest = path.join(CACHE_DIR, file);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
    const url = `${MODEL_BASE_URL}/${file}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!resp.ok || !resp.body) {
      throw new Error(`模型下载失败 (${resp.status}): ${url}`);
    }
    const tmp = `${dest}.${process.pid}.tmp`;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0) {
      throw new Error(`模型下载内容为空: ${url}`);
    }
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, dest);
    downloaded.push(file);
  }
  return { dir: CACHE_DIR, downloaded };
}

// ---------------------------------------------------------------------------
// 会话缓存（惰性）
// ---------------------------------------------------------------------------

interface LatexSessions {
  resizer: import('onnxruntime-node').InferenceSession;
  encoder: import('onnxruntime-node').InferenceSession;
  decoder: import('onnxruntime-node').InferenceSession;
  idToToken: Map<number, string>;
  specialIds: Set<number>;
}

let sessionsPromise: Promise<LatexSessions> | null = null;

async function loadTokenizer(tokenizerPath: string): Promise<{ idToToken: Map<number, string>; specialIds: Set<number> }> {
  const raw = JSON.parse(await fs.promises.readFile(tokenizerPath, 'utf-8'));
  const idToToken = new Map<number, string>();
  const specialIds = new Set<number>();
  for (const [token, id] of Object.entries(raw.model?.vocab ?? {})) {
    idToToken.set(Number(id), token);
  }
  for (const at of raw.added_tokens ?? []) {
    idToToken.set(at.id, at.content);
    if (at.special) specialIds.add(at.id);
  }
  return { idToToken, specialIds };
}

async function getSessions(): Promise<LatexSessions> {
  if (!sessionsPromise) {
    sessionsPromise = (async () => {
      const { dir } = await ensureModelFiles();
      const ort = await import('onnxruntime-node');
      const opts = { executionProviders: ['cpu'] as const };
      const [resizer, encoder, decoder, tokenizer] = await Promise.all([
        ort.InferenceSession.create(path.join(dir, 'image_resizer.onnx'), opts),
        ort.InferenceSession.create(path.join(dir, 'encoder.onnx'), opts),
        ort.InferenceSession.create(path.join(dir, 'decoder.onnx'), opts),
        loadTokenizer(path.join(dir, 'tokenizer.json')),
      ]);
      return { resizer, encoder, decoder, idToToken: tokenizer.idToToken, specialIds: tokenizer.specialIds };
    })();
    sessionsPromise.catch(() => {
      sessionsPromise = null; // 失败后允许重试
    });
  }
  return sessionsPromise;
}

// ---------------------------------------------------------------------------
// 图像解码与预处理（对齐 RapidLaTeXOCR PreProcess）
// ---------------------------------------------------------------------------

async function decodeImage(options: FormulaOcrOptions): Promise<JimpImage> {
  if (options.imageBase64) {
    // Jimp.read(Buffer) 需要 MIME 提示，fromBuffer 会自动探测；
    // as 断言规避 @jimp/types 的 import/require 双解析类型
    return Jimp.fromBuffer(Buffer.from(options.imageBase64, 'base64')) as unknown as Promise<JimpImage>;
  }
  if (options.imagePath) {
    return Jimp.read(options.imagePath);
  }
  throw new Error('必须提供 imagePath 或 imageBase64 之一');
}

function toGray(jimpImg: JimpImage): GrayImage {
  const { width, height, data } = jimpImg.bitmap;
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const a = data[i + 3] / 255;
    // 白底合成，避免透明区域干扰灰度
    const r = data[i] * a + 255 * (1 - a);
    const g = data[i + 1] * a + 255 * (1 - a);
    const b = data[i + 2] * a + 255 * (1 - a);
    out[p] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return { w: width, h: height, data: out };
}

function newGray(w: number, h: number, fill: number): GrayImage {
  const data = new Float32Array(w * h).fill(fill);
  return { w, h, data };
}

function resizeGray(img: GrayImage, w: number, h: number, _upscale: boolean): GrayImage {
  // 双线性插值；bicubic 与 bilinear 的差异在归一化输入下被模型鲁棒性吸收
  const out = newGray(w, h, 255);
  const xRatio = img.w / w;
  const yRatio = img.h / h;
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.h - 1, Math.max(0, y * yRatio));
    const y0 = Math.floor(sy);
    const y1 = Math.min(img.h - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.w - 1, Math.max(0, x * xRatio));
      const x0 = Math.floor(sx);
      const x1 = Math.min(img.w - 1, x0 + 1);
      const fx = sx - x0;
      const v00 = img.data[y0 * img.w + x0];
      const v01 = img.data[y0 * img.w + x1];
      const v10 = img.data[y1 * img.w + x0];
      const v11 = img.data[y1 * img.w + x1];
      const top = v00 + (v01 - v00) * fx;
      const bottom = v10 + (v11 - v10) * fx;
      out.data[y * w + x] = top + (bottom - top) * fy;
    }
  }
  return out;
}

function ceilDiv(value: number, div: number): number {
  return Math.ceil(value / div) * div;
}

/** 裁掉空白边缘并 pad 到 32 的倍数（白底）。对齐 PreProcess.pad。 */
function pad(img: GrayImage, divable = 32): GrayImage {
  // data：alpha 全不透明时取亮度，否则取反 alpha（对应 LA 通道处理）
  const n = img.w * img.h;
  let data = new Float32Array(n);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    data[i] = img.data[i];
    if (data[i] < min) min = data[i];
    if (data[i] > max) max = data[i];
  }
  const range = max - min;
  if (range > 0) {
    for (let i = 0; i < n; i++) data[i] = ((data[i] - min) / range) * 255;
  }

  let mean = 0;
  for (let i = 0; i < n; i++) mean += data[i];
  mean /= n;

  const threshold = 128;
  let work = data;
  if (mean > threshold) {
    // 文字为亮色：掩码取暗点
  } else {
    work = new Float32Array(n);
    for (let i = 0; i < n; i++) work[i] = 255 - data[i];
  }

  // boundingRect：找掩码非零点外接矩形
  let minX = img.w;
  let minY = img.h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const maskVal = mean > threshold ? (work[y * img.w + x] < threshold ? 255 : 0) : work[y * img.w + x];
      if (maskVal > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  // 全空白图：退化为整图
  if (maxX < 0) {
    minX = 0;
    minY = 0;
    maxX = img.w - 1;
    maxY = img.h - 1;
  }
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const rect = cropRect(work, img.w, minX, minY, w, h);

  const pw = ceilDiv(w, divable);
  const ph = ceilDiv(h, divable);
  const out = newGray(pw, ph, 255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out.data[y * pw + x] = rect[y * w + x];
    }
  }
  return out;
}

/** 从大图中裁取矩形区域为行主序数组。 */
function cropRect(src: Float32Array, srcW: number, x0: number, y0: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[y * w + x] = src[(y0 + y) * srcW + (x0 + x)];
    }
  }
  return out;
}

/** 限制到 max_dims 并补足 min_dims（白底）。对齐 PreProcess.minmax_size。 */
function minmaxSize(img: GrayImage): GrayImage {
  let cur = img;
  const rW = cur.w / MAX_WIDTH;
  const rH = cur.h / MAX_HEIGHT;
  const maxRatio = Math.max(rW, rH);
  if (maxRatio > 1) {
    const nw = Math.max(1, Math.floor(cur.w / maxRatio));
    const nh = Math.max(1, Math.floor(cur.h / maxRatio));
    cur = resizeGray(cur, nw, nh, false);
  }
  const pw = Math.max(cur.w, MIN_WIDTH);
  const ph = Math.max(cur.h, MIN_HEIGHT);
  if (pw !== cur.w || ph !== cur.h) {
    const out = newGray(pw, ph, 255);
    for (let y = 0; y < cur.h; y++) {
      for (let x = 0; x < cur.w; x++) out.data[y * pw + x] = cur.data[y * cur.w + x];
    }
    cur = out;
  }
  return cur;
}

const NORMALIZE_MEAN = 0.7931 * 255;
const NORMALIZE_STD = 0.1738 * 255;

/** 灰度 → 归一化 float32 张量 [1,1,H,W]。 */
function toTensor(img: GrayImage): { tensor: Float32Array; w: number; h: number } {
  const out = new Float32Array(img.w * img.h);
  for (let i = 0; i < out.length; i++) {
    out[i] = (img.data[i] - NORMALIZE_MEAN) / NORMALIZE_STD;
  }
  return { tensor: out, w: img.w, h: img.h };
}

// ---------------------------------------------------------------------------
// 解码
// ---------------------------------------------------------------------------

function decodeTokens(sessions: LatexSessions, ids: number[]): string {
  const toks: string[] = [];
  for (const id of ids) {
    if (sessions.specialIds.has(id)) continue;
    const tok = sessions.idToToken.get(id);
    if (tok !== undefined) toks.push(tok);
  }
  const raw = toks.join('');
  return raw.split(' ').join('').replace(/Ġ/g, ' ');
}

/** 移除 LaTeX 中无语义的空白（对齐 RapidLaTeXOCR main.post_process）。 */
function postProcess(s: string): string {
  const textReg = /(\\(operatorname|mathrm|text|mathbf)\s?\*? \{.*?\})/g;
  const names: string[] = [];
  for (const m of s.matchAll(textReg)) {
    names.push(m[0].replace(/ /g, ''));
  }
  s = s.replace(textReg, () => names.shift() ?? '');
  const noletter = String.raw`[\W_^\d]`;
  const letter = '[a-zA-Z]';
  for (;;) {
    const prev = s;
    s = s.replace(new RegExp(`(?!\\\\ )(${noletter})\\s+?(${noletter})`, 'g'), '$1$2');
    s = s.replace(new RegExp(`(?!\\\\ )(${noletter})\\s+?(${letter})`, 'g'), '$1$2');
    s = s.replace(new RegExp(`(${letter})\\s+?(${noletter})`, 'g'), '$1$2');
    if (s === prev) break;
  }
  return s;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function argmax(arr: Float32Array | number[], offset = 0, stride = 1): number {
  let best = -Infinity;
  let bestIdx = 0;
  for (let i = 0; i < arr.length / stride; i++) {
    const v = arr[i * stride + offset];
    if (v > best) {
      best = v;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export async function recognizeFormula(options: FormulaOcrOptions): Promise<FormulaOcrResult> {
  const start = Date.now();
  try {
    const sessions = await getSessions();
    const ort = await import('onnxruntime-node');

    const jimpImg = await decodeImage(options);
    const rgbGray = toGray(jimpImg);

    // 1) pad + minmax
    let inputImage = minmaxSize(pad(rgbGray));

    // 2) 迭代 image_resizer 确定宽度
    let r = 1;
    let w = inputImage.w;
    let h = inputImage.h;
    let finalTensor: { tensor: Float32Array; w: number; h: number } | null = null;
    for (let iter = 0; iter < 10; iter++) {
      const hh = Math.floor(h * r);
      const resized = resizeGray(inputImage, w, hh, r > 1);
      const padded = pad(minmaxSize(resized));
      finalTensor = toTensor(padded);

      const inputName = sessions.resizer.inputNames[0];
      const results = await sessions.resizer.run({
        [inputName]: new ort.Tensor('float32', finalTensor.tensor, [1, 1, finalTensor.h, finalTensor.w]),
      });
      const resOut = results[sessions.resizer.outputNames[0]].data as Float32Array;
      const argmaxIdx = argmax(resOut);
      const targetW = (argmaxIdx + 1) * 32;
      if (targetW === padded.w) break;
      r = targetW / padded.w;
      w = targetW;
    }
    if (!finalTensor) throw new Error('image resizer 迭代失败');

    // 3) encoder → context
    const encResults = await sessions.encoder.run({
      [sessions.encoder.inputNames[0]]: new ort.Tensor('float32', finalTensor.tensor, [
        1, 1, finalTensor.h, finalTensor.w,
      ]),
    });
    const context = encResults[sessions.encoder.outputNames[0]];

    // 4) decoder 自回归（argmax 采样）
    const out: number[] = [BOS_TOKEN];
    const mask: boolean[] = [true];
    let eosReached = false;
    for (let step = 0; step < MAX_SEQ_LEN; step++) {
      const xStart = Math.max(0, out.length - MAX_SEQ_LEN);
      const x = out.slice(xStart);
      const m = mask.slice(xStart);
      const feeds: Record<string, import('onnxruntime-node').Tensor> = {
        [sessions.decoder.inputNames[0]]: new ort.Tensor('int64', BigInt64ArrayFrom(x), [1, x.length]),
        [sessions.decoder.inputNames[1]]: new ort.Tensor('bool', new Uint8Array(m.map((b) => (b ? 1 : 0))), [1, m.length]),
        [sessions.decoder.inputNames[2]]: context,
      };
      const decResults = await sessions.decoder.run(feeds);
      const logits = decResults[sessions.decoder.outputNames[0]].data as Float32Array;
      const vocab = decResults[sessions.decoder.outputNames[0]].dims[2];
      const lastOffset = (out.length - 1) * vocab;
      // softmax(1e-5) 采样退化为 argmax（top-k 过滤不影响：全局最大必在 top-k 内）
      const last = logits.subarray(lastOffset, lastOffset + vocab);
      const nextId = argmax(last);
      out.push(nextId);
      mask.push(true);
      if (nextId === EOS_TOKEN) {
        break;
      }
    }

    const latex = postProcess(decodeTokens(sessions, out.slice(1)));

    if (options.outputPath) {
      const resolved = path.resolve(options.outputPath);
      await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
      await fs.promises.writeFile(resolved, latex, 'utf-8');
    }

    return {
      success: true,
      latex,
      elapsedMs: Date.now() - start,
      modelDir: CACHE_DIR,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - start,
    };
  }
}

function BigInt64ArrayFrom(values: number[]): BigInt64Array {
  const out = new BigInt64Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = BigInt(values[i]);
  return out;
}
