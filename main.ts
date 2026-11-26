// "The World in One Day" — a one-page newspaper front page that sums up the
// world news of Thursday 26 November 2026 in a single 1024x1024 PNG.
//
// The whole image is drawn in code: a tiny software rasteriser paints the
// page into a pixel buffer (masthead, rules, headlines set in a hand-built
// stroke typeface, and small iconic illustrations drawn from shapes), and a
// minimal PNG encoder writes the result to /output/entry.png (or to
// MAKEFUN_OUTPUT_DIR outside the grader's container).
//
// Node standard library only. Fully deterministic: no clock, no randomness,
// no network — two runs write byte-identical files.
//
// Run locally:  mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// PNG encoding (colour type 2, 8-bit RGB), with a per-row filter choice that
// depends only on the pixel data, so the output bytes are stable.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(rgb, width, height) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  let prevRow = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride);
    // Try filter None, Sub and Up; keep whichever gives the smallest sum of
    // absolute signed byte values. Ties resolve in a fixed order.
    let bestType = 0;
    let bestScore = Infinity;
    let bestData = row;
    for (const type of [0, 1, 2]) {
      const cand = Buffer.alloc(stride);
      let score = 0;
      for (let i = 0; i < stride; i++) {
        let v;
        if (type === 0) v = row[i];
        else if (type === 1) v = row[i] - (i >= 3 ? row[i - 3] : 0);
        else v = row[i] - prevRow[i];
        v &= 0xff;
        cand[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        bestType = type;
        bestData = cand;
      }
    }
    const off = y * (stride + 1);
    raw[off] = bestType;
    bestData.copy(raw, off + 1);
    prevRow = row;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Canvas: a supersampled RGB raster. Everything is specified in page
// coordinates (1024 x 1024); the buffer is SS times larger and is box
// downsampled at the end for anti-aliased edges.
// ---------------------------------------------------------------------------

const PAGE = 1024;
const SS = 2;
const CW = PAGE * SS;
const CH = PAGE * SS;
const pixels = new Uint8Array(CW * CH * 3);

function setPx(x, y, col) {
  if (x < 0 || y < 0 || x >= CW || y >= CH) return;
  const i = (y * CW + x) * 3;
  pixels[i] = col[0];
  pixels[i + 1] = col[1];
  pixels[i + 2] = col[2];
}

function fillAll(col) {
  for (let i = 0; i < pixels.length; i += 3) {
    pixels[i] = col[0];
    pixels[i + 1] = col[1];
    pixels[i + 2] = col[2];
  }
}

function fillRect(x, y, w, h, col) {
  const x0 = Math.round(x * SS);
  const y0 = Math.round(y * SS);
  const x1 = Math.round((x + w) * SS);
  const y1 = Math.round((y + h) * SS);
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) setPx(xx, yy, col);
}

function fillEllipse(cx, cy, rx, ry, col) {
  const x0 = Math.floor((cx - rx) * SS);
  const x1 = Math.ceil((cx + rx) * SS);
  const y0 = Math.floor((cy - ry) * SS);
  const y1 = Math.ceil((cy + ry) * SS);
  const rxs = rx * SS;
  const rys = ry * SS;
  const cxs = cx * SS;
  const cys = cy * SS;
  for (let yy = y0; yy <= y1; yy++) {
    const dy = (yy - cys) / rys;
    const rem = 1 - dy * dy;
    if (rem < 0) continue;
    const half = Math.sqrt(rem) * rxs;
    const xa = Math.round(cxs - half);
    const xb = Math.round(cxs + half);
    for (let xx = xa; xx <= xb; xx++) setPx(xx, yy, col);
  }
}

function fillPoly(points, col) {
  // Even-odd scanline fill, points in page coordinates.
  const pts = points.map(([x, y]) => [x * SS, y * SS]);
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of pts) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const yStart = Math.max(0, Math.floor(minY));
  const yEnd = Math.min(CH - 1, Math.ceil(maxY));
  const n = pts.length;
  for (let yy = yStart; yy <= yEnd; yy++) {
    const yc = yy + 0.5;
    const xs = [];
    for (let i = 0; i < n; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % n];
      if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) {
        xs.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.round(xs[k]);
      const xb = Math.round(xs[k + 1]);
      for (let xx = xa; xx <= xb; xx++) setPx(xx, yy, col);
    }
  }
}

// Thick line segment with round caps (a capsule), page coordinates.
function drawSeg(x1, y1, x2, y2, halfWidth, col) {
  const ax = x1 * SS;
  const ay = y1 * SS;
  const bx = x2 * SS;
  const by = y2 * SS;
  const hw = halfWidth * SS;
  const minX = Math.floor(Math.min(ax, bx) - hw - 1);
  const maxX = Math.ceil(Math.max(ax, bx) + hw + 1);
  const minY = Math.floor(Math.min(ay, by) - hw - 1);
  const maxY = Math.ceil(Math.max(ay, by) + hw + 1);
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  for (let yy = minY; yy <= maxY; yy++) {
    for (let xx = minX; xx <= maxX; xx++) {
      let t = lenSq === 0 ? 0 : ((xx - ax) * dx + (yy - ay) * dy) / lenSq;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + t * dx - xx;
      const py = ay + t * dy - yy;
      if (px * px + py * py <= hw * hw) setPx(xx, yy, col);
    }
  }
}

function polyline(points, halfWidth, col, close = false) {
  const list = close ? [...points, points[0]] : points;
  for (let i = 0; i + 1 < list.length; i++) {
    drawSeg(list[i][0], list[i][1], list[i + 1][0], list[i + 1][1], halfWidth, col);
  }
}

function downsample() {
  const out = new Uint8Array(PAGE * PAGE * 3);
  for (let y = 0; y < PAGE; y++) {
    for (let x = 0; x < PAGE; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * CW + (x * SS + sx)) * 3;
          r += pixels[i];
          g += pixels[i + 1];
          b += pixels[i + 2];
        }
      }
      const n = SS * SS;
      const o = (y * PAGE + x) * 3;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// A stroke typeface, drawn by hand for this page. Each glyph is a list of
// polylines on a grid where the cap height is 10 units (y = 0 at the top,
// y = 10 at the baseline). Text is set in capitals throughout, in the manner
// of a newspaper's display type. The renderer strokes the polylines with
// round joins, so weight is just a stroke width.
// ---------------------------------------------------------------------------

// Points along an elliptical arc, angles in degrees. In this y-down grid a
// point is (cx + rx*cos(a), cy + ry*sin(a)); the sweep runs linearly from a0
// to a1, whichever direction that is.
function arcPts(cx, cy, rx, ry, a0, a1, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}

// Each glyph: { w: advance width in units, s: strokes (arrays of [x, y]) }.
const GLYPHS = {
  A: { w: 7.6, s: [[[0, 10], [3.5, 0], [7, 10]], [[1.75, 6.6], [5.25, 6.6]]] },
  B: {
    w: 7,
    s: [
      [[0, 0], [0, 10]],
      [[0, 0], ...arcPts(2.7, 2.5, 2.7, 2.5, -90, 90, 8), [0, 5]],
      [[0, 5], ...arcPts(3, 7.5, 3, 2.5, -90, 90, 8), [0, 10]],
    ],
  },
  C: { w: 7.8, s: [arcPts(3.6, 5, 3.6, 5, 55, 305, 16)] },
  D: {
    w: 7.6,
    s: [
      [[0, 0], [0, 10]],
      [[0, 0], [2.4, 0], ...arcPts(2.4, 5, 4.4, 5, -90, 90, 10), [2.4, 10], [0, 10]],
    ],
  },
  E: { w: 6.6, s: [[[6, 0], [0, 0], [0, 10], [6, 10]], [[0, 5], [4.8, 5]]] },
  F: { w: 6.6, s: [[[6, 0], [0, 0], [0, 10]], [[0, 5], [4.6, 5]]] },
  G: {
    w: 8,
    s: [arcPts(3.7, 5, 3.7, 5, 55, 305, 16), [[7.4, 8.6], [7.4, 5.2], [4.4, 5.2]]],
  },
  H: { w: 7.8, s: [[[0, 0], [0, 10]], [[7.2, 0], [7.2, 10]], [[0, 5], [7.2, 5]]] },
  I: { w: 3.4, s: [[[1.4, 0], [1.4, 10]], [[0, 0], [2.8, 0]], [[0, 10], [2.8, 10]]] },
  J: {
    w: 6.2,
    s: [[[5.6, 0], [5.6, 7.2], ...arcPts(2.9, 7.2, 2.7, 2.8, 0, 180, 8)]],
  },
  K: { w: 7.4, s: [[[0, 0], [0, 10]], [[6.8, 0], [1, 5.2]], [[2.4, 4], [6.8, 10]]] },
  L: { w: 6.6, s: [[[0, 0], [0, 10], [6, 10]]] },
  M: { w: 9.4, s: [[[0, 10], [0, 0], [4.4, 6.2], [8.8, 0], [8.8, 10]]] },
  N: { w: 8, s: [[[0, 10], [0, 0], [7.4, 10], [7.4, 0]]] },
  O: { w: 8.2, s: [arcPts(3.8, 5, 3.8, 5, 0, 360, 22)] },
  P: {
    w: 7,
    s: [
      [[0, 0], [0, 10]],
      [[0, 0], [3.2, 0], ...arcPts(3.2, 2.6, 3.2, 2.6, -90, 90, 8), [3.2, 5.2], [0, 5.2]],
    ],
  },
  Q: { w: 8.2, s: [arcPts(3.8, 5, 3.8, 5, 0, 360, 22), [[4.8, 7.4], [7.8, 10.4]]] },
  R: {
    w: 7.2,
    s: [
      [[0, 0], [0, 10]],
      [[0, 0], [3.2, 0], ...arcPts(3.2, 2.6, 3.2, 2.6, -90, 90, 8), [3.2, 5.2], [0, 5.2]],
      [[3.4, 5.2], [6.6, 10]],
    ],
  },
  S: {
    w: 7.2,
    s: [
      [
        [6.3, 1.8], [5, 0.5], [3, 0], [1.2, 0.7], [0.3, 2.2], [0.9, 3.8],
        [2.6, 4.9], [4.8, 5.9], [6.1, 7.2], [6, 8.9], [4.6, 10], [2.4, 10],
        [0.9, 9.5], [0.2, 8.3],
      ],
    ],
  },
  T: { w: 7.6, s: [[[0, 0], [7, 0]], [[3.5, 0], [3.5, 10]]] },
  U: {
    w: 7.8,
    s: [[[0, 0], [0, 6.6], ...arcPts(3.6, 6.6, 3.6, 3.4, 180, 0, 10), [7.2, 0]]],
  },
  V: { w: 8, s: [[[0, 0], [3.7, 10], [7.4, 0]]] },
  W: { w: 11, s: [[[0, 0], [2.4, 10], [5.2, 3.8], [7.8, 10], [10.4, 0]]] },
  X: { w: 7.4, s: [[[0, 0], [6.8, 10]], [[6.8, 0], [0, 10]]] },
  Y: { w: 7.6, s: [[[0, 0], [3.5, 4.4], [7, 0]], [[3.5, 4.4], [3.5, 10]]] },
  Z: { w: 7.4, s: [[[0, 0], [6.8, 0], [0, 10], [6.8, 10]]] },
  0: { w: 7.6, s: [arcPts(3.5, 5, 3.3, 5, 0, 360, 20)] },
  1: { w: 5.6, s: [[[1.4, 2.4], [3.4, 0], [3.4, 10]], [[0.6, 10], [5.2, 10]]] },
  2: {
    w: 7.2,
    s: [
      [
        [0.7, 2.8], [1.2, 1], [2.8, 0], [4.8, 0.2], [6.1, 1.6], [5.9, 3.6],
        [4.6, 5.4], [0.6, 10], [6.6, 10],
      ],
    ],
  },
  3: {
    w: 7,
    s: [
      [
        [0.7, 1.4], [2.4, 0.1], [4.4, 0.3], [5.6, 1.9], [5, 3.8], [3.4, 4.7],
        [5.2, 5.6], [6, 7.6], [5.2, 9.4], [3.2, 10], [1.2, 9.7], [0.3, 8.5],
      ],
    ],
  },
  4: { w: 7.6, s: [[[5, 10], [5, 0], [0.4, 7]], [[0, 7], [7, 7]]] },
  5: {
    w: 7,
    s: [
      [[6.2, 0], [0.7, 0], [0.5, 4.4]],
      [
        [0.5, 4.4], [2.4, 4.1], [4.6, 4.7], [5.9, 6.4], [5.3, 8.7], [3.4, 10],
        [1.2, 9.7], [0.2, 8.6],
      ],
    ],
  },
  6: {
    w: 7.2,
    s: [
      [
        [5.9, 1.6], [4.4, 0.3], [2.4, 0.6], [1, 2.4], [0.4, 5], [0.7, 8],
        [2.2, 9.8], [4.2, 10], [5.9, 8.8], [6.3, 6.8], [5.4, 5], [3.4, 4.3],
        [1.2, 5.2],
      ],
    ],
  },
  7: { w: 7.2, s: [[[0, 0], [6.6, 0], [2.9, 10]]] },
  8: {
    w: 7.2,
    s: [arcPts(3.3, 2.5, 2.7, 2.5, 0, 360, 16), arcPts(3.3, 7.4, 3.2, 2.6, 0, 360, 16)],
  },
  9: {
    w: 7.2,
    s: [
      [
        [0.7, 8.4], [2.2, 9.7], [4.2, 9.4], [5.6, 7.6], [6.2, 5], [5.9, 2],
        [4.4, 0.2], [2.4, 0], [0.7, 1.2], [0.3, 3.2], [1.2, 5], [3.2, 5.7],
        [5.4, 4.8],
      ],
    ],
  },
  '.': { w: 3.2, s: [[[1.3, 9.3], [1.3, 9.75]]] },
  ',': { w: 3.2, s: [[[1.7, 9], [1, 10.4]]] },
  "'": { w: 3, s: [[[1.2, 0], [1.2, 2.4]]] },
  ':': { w: 3.2, s: [[[1.3, 2.3], [1.3, 2.75]], [[1.3, 9.3], [1.3, 9.75]]] },
  ';': { w: 3.2, s: [[[1.3, 2.3], [1.3, 2.75]], [[1.7, 9], [1, 10.4]]] },
  '!': { w: 3.2, s: [[[1.3, 0], [1.3, 6.6]], [[1.3, 9.3], [1.3, 9.75]]] },
  '?': {
    w: 6.8,
    s: [
      [
        [0.6, 2.2], [1.2, 0.7], [3, 0], [5, 0.6], [5.7, 2.2], [5, 4],
        [3.2, 5.2], [3.2, 7],
      ],
      [[3.2, 9.3], [3.2, 9.75]],
    ],
  },
  '-': { w: 5.2, s: [[[0.4, 5], [4.2, 5]]] },
  '(': { w: 4.2, s: [arcPts(3.4, 5, 3.2, 5.4, 120, 240, 9)] },
  ')': { w: 4.2, s: [arcPts(0.2, 5, 3.2, 5.4, 300, 420, 9)] },
  '%': {
    w: 9,
    s: [
      arcPts(1.9, 2.2, 1.8, 2, 0, 360, 12),
      arcPts(6.3, 7.8, 1.8, 2, 0, 360, 12),
      [[7.6, 0], [0.8, 10]],
    ],
  },
  $: {
    w: 7,
    s: [
      [
        [5.7, 1.6], [4.5, 0.4], [2.7, 0], [1.1, 0.6], [0.3, 2], [0.8, 3.4],
        [2.3, 4.4], [4.3, 5.3], [5.5, 6.5], [5.4, 8], [4.1, 9], [2.1, 9],
        [0.8, 8.5], [0.2, 7.4],
      ],
      [[3.1, 0], [3.1, 10]],
    ],
  },
  '+': { w: 6.8, s: [[[3.1, 2], [3.1, 8]], [[0.6, 5], [5.6, 5]]] },
  '/': { w: 5.2, s: [[[0.6, 10.2], [4, -0.2]]] },
  '|': { w: 3.2, s: [[[1.3, 0], [1.3, 10]]] },
  '"': { w: 4.2, s: [[[0.9, 0], [0.9, 2.4]], [[2.7, 0], [2.7, 2.4]]] },
  '•': { w: 3.4, s: [[[1.4, 4.8], [1.4, 5.3]]] },
  ' ': { w: 4.4, s: [] },
};

const SPACE_W = 4.4;

// Width of a string in page pixels at a given cap-height size.
function measure(text, size, tracking = 0) {
  const scale = size / 10;
  let w = 0;
  for (const ch of text) {
    const g = GLYPHS[ch];
    w += (g ? g.w : SPACE_W) * scale + tracking;
  }
  return text.length ? w - tracking : 0;
}

// Draw one line of text with its cap top at y. Returns the drawn width.
// opts: weight (stroke width in grid units), tracking (extra px per char),
// align: 'left' | 'center' | 'right' relative to x.
function drawText(text, x, y, size, col, opts = {}) {
  const weight = opts.weight ?? 1.05;
  const tracking = opts.tracking ?? 0;
  const align = opts.align ?? 'left';
  const scale = size / 10;
  const total = measure(text, size, tracking);
  let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  const hw = (weight * scale) / 2;
  for (const ch of text) {
    const g = GLYPHS[ch];
    if (g) {
      for (const stroke of g.s) {
        const pts = stroke.map(([gx, gy]) => [cx + gx * scale, y + gy * scale]);
        polyline(pts, hw, col);
      }
      cx += g.w * scale + tracking;
    } else {
      cx += SPACE_W * scale + tracking;
    }
  }
  return total;
}

// Greedy word wrap into lines no wider than maxWidth.
function wrapText(text, size, maxWidth, tracking = 0) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const trial = line ? line + ' ' + word : word;
    if (measure(trial, size, tracking) <= maxWidth || !line) line = trial;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Draw a wrapped block; returns the y just past the last line.
function drawBlock(text, x, y, width, size, col, opts = {}) {
  const lh = opts.lh ?? size * 1.28;
  const lines = wrapText(text, size, width, opts.tracking ?? 0);
  const maxLines = opts.maxLines ?? lines.length;
  for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
    drawText(lines[i], x, y + i * lh, size, col, {
      weight: opts.weight,
      tracking: opts.tracking,
      align: opts.align,
    });
  }
  return y + Math.min(lines.length, maxLines) * lh;
}

// ---------------------------------------------------------------------------
// The page itself: palette, little iconic illustrations drawn from shapes,
// and the front-page layout for Thursday 26 November 2026.
// ---------------------------------------------------------------------------

const PAPER = [247, 242, 231];
const INK = [22, 19, 15];
const RED = [176, 32, 26];
const FAINT = [116, 106, 90];
const NAVY = [30, 44, 74];
const DARK_SKY = [16, 26, 46];
const SKY = [150, 180, 214];
const BALLOON_RED = [206, 74, 38];
const BALLOON_GOLD = [228, 156, 52];
const FLAME = [226, 110, 30];
const FLAME_IN = [247, 193, 66];
const BLUE = [36, 84, 158];
const GREEN = [34, 122, 70];
const WHITE = [250, 248, 242];

function star(cx, cy, rOuter, rInner, col) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = ((-90 + i * 36) * Math.PI) / 180;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  fillPoly(pts, col);
}

// A parade balloon: round balloon with a star, knot, tethers and a basket.
function iconBalloon(cx, cy, r, col) {
  fillEllipse(cx, cy, r, r * 1.08, col);
  star(cx, cy - r * 0.08, r * 0.52, r * 0.22, WHITE);
  fillPoly(
    [
      [cx - r * 0.16, cy + r * 1.05],
      [cx + r * 0.16, cy + r * 1.05],
      [cx, cy + r * 1.3],
    ],
    col,
  );
  drawSeg(cx, cy + r * 1.28, cx - r * 0.42, cy + r * 1.95, r * 0.045, INK);
  drawSeg(cx, cy + r * 1.28, cx + r * 0.42, cy + r * 1.95, r * 0.045, INK);
  fillRect(cx - r * 0.46, cy + r * 1.92, r * 0.92, r * 0.5, INK);
}

function iconFlame(cx, cy, s) {
  const shape = [
    [0, -1], [0.26, -0.48], [0.5, -0.08], [0.44, 0.3], [0.22, 0.5],
    [0, 0.55], [-0.22, 0.5], [-0.44, 0.3], [-0.5, -0.08], [-0.26, -0.48],
  ];
  fillPoly(shape.map(([dx, dy]) => [cx + dx * s, cy + dy * s]), FLAME);
  fillPoly(
    shape.map(([dx, dy]) => [cx + dx * s * 0.52, cy + dy * s * 0.52 + s * 0.24]),
    FLAME_IN,
  );
}

function iconBarrel(x, y, s) {
  fillRect(x + 2, y + 5, s - 4, s - 10, BLUE);
  fillEllipse(x + s / 2, y + 5, s / 2 - 2, 5, BLUE);
  fillEllipse(x + s / 2, y + s - 5, s / 2 - 2, 5, BLUE);
  fillRect(x + 2, y + s * 0.36, s - 4, 2.6, WHITE);
  fillRect(x + 2, y + s * 0.62, s - 4, 2.6, WHITE);
  // Rising arrow beside the barrel.
  polyline(
    [
      [x + s + 4, y + s - 3],
      [x + s + 11, y + s - 12],
      [x + s + 16, y + s - 10],
      [x + s + 22, y + s - 19],
    ],
    2.4,
    GREEN,
  );
  fillPoly(
    [
      [x + s + 22, y + s - 25],
      [x + s + 28, y + s - 18],
      [x + s + 20, y + s - 16],
    ],
    GREEN,
  );
}

function iconScales(cx, cy) {
  // Scales of justice: post, beam, two pans and a base.
  drawSeg(cx, cy - 17, cx, cy + 13, 2.4, INK);
  drawSeg(cx - 17, cy - 13, cx + 17, cy - 13, 2.4, INK);
  drawSeg(cx - 17, cy - 13, cx - 22, cy + 1, 1.5, INK);
  drawSeg(cx - 17, cy - 13, cx - 12, cy + 1, 1.5, INK);
  fillRect(cx - 23, cy + 1, 12, 3.4, INK);
  drawSeg(cx + 17, cy - 13, cx + 12, cy + 1, 1.5, INK);
  drawSeg(cx + 17, cy - 13, cx + 22, cy + 1, 1.5, INK);
  fillRect(cx + 11, cy + 1, 12, 3.4, INK);
  drawSeg(cx - 11, cy + 17, cx + 11, cy + 17, 2.4, INK);
}

function iconJet(cx, cy) {
  fillPoly(
    [
      [cx - 21, cy + 1], [cx - 10, cy - 3], [cx - 3, cy - 15], [cx + 2, cy - 15],
      [cx + 7, cy - 4], [cx + 19, cy - 3], [cx + 22, cy], [cx + 19, cy + 3],
      [cx + 7, cy + 4], [cx + 3, cy + 13], [cx - 2, cy + 13], [cx - 9, cy + 4],
      [cx - 17, cy + 9], [cx - 20, cy + 9], [cx - 18, cy + 3],
    ],
    INK,
  );
}

function iconRocket(cx, cy) {
  fillPoly(
    [
      [cx - 8, cy + 8], [cx - 15, cy + 19], [cx - 8, cy + 19],
    ],
    RED,
  );
  fillPoly(
    [
      [cx + 8, cy + 8], [cx + 15, cy + 19], [cx + 8, cy + 19],
    ],
    RED,
  );
  fillEllipse(cx, cy - 1, 8.5, 18, BLUE);
  fillEllipse(cx, cy - 6, 3.6, 3.6, WHITE);
  fillPoly(
    [
      [cx - 4, cy + 18], [cx + 4, cy + 18], [cx, cy + 27],
    ],
    FLAME,
  );
}

// The lead story's picture strip: a night-blue band, a skyline, rain, and
// the parade balloon that will not fly today.
function skylineStrip(y, h) {
  fillRect(36, y, 952, h, NAVY);
  const base = y + h;
  const buildings = [
    [52, 20], [92, 13], [128, 24], [176, 16], [214, 26], [262, 14], [300, 21],
    [348, 17], [388, 25], [436, 15], [474, 22], [522, 18], [560, 26],
    [608, 14], [646, 20], [694, 16], [732, 24], [780, 15], [818, 21],
    [876, 13], [912, 19], [950, 15],
  ];
  const lit = [240, 205, 120];
  for (const [bx, bh] of buildings) {
    fillRect(bx, base - bh, 30, bh, [74, 98, 142]);
    if (bh >= 20) {
      fillRect(bx + 7, base - bh + 5, 4, 5, lit);
      fillRect(bx + 19, base - bh + 12, 4, 5, lit);
    }
  }
  for (let x = 58; x < 980; x += 42) {
    drawSeg(x, y + 4, x - 5, y + 13, 1.1, SKY);
    drawSeg(x + 18, y + 16, x + 13, y + 25, 1.1, SKY);
  }
  iconBalloon(884, y + h / 2 - 3, 12.5, BALLOON_RED);
  iconBalloon(140, y + h / 2 - 2, 9, BALLOON_GOLD);
}

function rule(y, h, col = INK) {
  fillRect(36, y, 952, h, col);
}

function vRule(x, y, h) {
  fillRect(x, y, 1.6, h, FAINT);
}

function drawPage() {
  fillAll(PAPER);

  // Masthead.
  rule(22, 5);
  rule(30, 1.5);
  drawText('THE WORLD IN ONE DAY', 512, 42, 62, INK, {
    weight: 1.8,
    tracking: 2,
    align: 'center',
  });
  rule(114, 1.5);
  drawText('LATE EDITION', 36, 127, 16, FAINT, { weight: 1 });
  drawText('THURSDAY, 26 NOVEMBER 2026', 512, 122, 26, INK, {
    weight: 1.55,
    align: 'center',
  });
  drawText('ONE PAGE ONLY', 988, 127, 16, FAINT, { weight: 1, align: 'right' });
  rule(156, 4);
  rule(163, 1);

  // Lead story: the 100th Macy's Thanksgiving Day Parade, postponed.
  drawText("THANKSGIVING DAY - NEW YORK", 36, 178, 22, RED, {
    weight: 1.35,
    tracking: 2,
  });
  iconBalloon(956, 176, 11.5, BALLOON_RED);
  drawText("100TH MACY'S PARADE", 36, 208, 66, INK, { weight: 1.7 });
  drawText('POSTPONED BY STORM', 36, 292, 66, INK, { weight: 1.7 });
  drawBlock(
    "FIRST WEATHER POSTPONEMENT IN ITS HISTORY. THE BALLOONS FLY SATURDAY AS A NOR'EASTER BATTERS NEW YORK.",
    36, 372, 952, 24, INK, { weight: 1, lh: 31, maxLines: 2 },
  );
  skylineStrip(436, 32);
  rule(478, 2.5);

  // Second row, left: Cairo tanker fire.
  iconFlame(60, 516, 26);
  drawText('CAIRO - EGYPT', 94, 502, 20, RED, { weight: 1.3, tracking: 1.5 });
  drawBlock('TANKER FIRE KILLS 31 IN CAIRO', 36, 546, 458, 37, INK, {
    weight: 1.6,
    lh: 44,
    maxLines: 3,
  });
  drawBlock(
    'TANKER OVERTURNED IN GIZA; BLAZE ENGULFED 27 VEHICLES, 21 HURT',
    36, 682, 458, 20, INK, { weight: 1, lh: 26, maxLines: 2 },
  );

  // Second row, right: oil, the Houthi claim and Hormuz mines.
  iconBarrel(534, 492, 30);
  drawText('ENERGY MARKETS', 614, 502, 20, RED, { weight: 1.3, tracking: 1.5 });
  drawBlock('OIL JUMPS AS HOUTHIS CLAIM REFINERY HIT', 530, 546, 458, 37, INK, {
    weight: 1.6,
    lh: 44,
    maxLines: 3,
  });
  drawBlock(
    'BRENT +3.5% TO $94.61; SHIPS HIT MINES IN HORMUZ STRAIT',
    530, 682, 458, 20, INK, { weight: 1, lh: 26, maxLines: 2 },
  );
  vRule(511, 492, 228);
  rule(732, 2);

  // Third row, left: Netanyahu trial.
  iconScales(54, 762);
  drawText('JERUSALEM', 84, 754, 18, RED, { weight: 1.3, tracking: 1 });
  drawBlock('NETANYAHU BRIBERY CASE IN DOUBT', 36, 794, 296, 28, INK, {
    weight: 1.55,
    lh: 34,
    maxLines: 3,
  });
  drawBlock(
    'COURT DOUBTS KEY CHARGE; PM DEMANDS THE TRIAL END AT ONCE',
    36, 898, 296, 18, INK, { weight: 1, lh: 22, maxLines: 3 },
  );

  // Third row, middle: Ukraine's deep strike.
  iconJet(386, 764);
  drawText('UKRAINE WAR', 420, 754, 18, RED, { weight: 1.3, tracking: 1 });
  drawBlock('KYIV SAYS FIVE RUSSIAN JETS HIT', 364, 794, 296, 28, INK, {
    weight: 1.55,
    lh: 34,
    maxLines: 3,
  });
  drawBlock(
    'THREE MIG-31S AND TWO SU-34S DAMAGED AT SAVASLEYKA AIRFIELD',
    364, 898, 296, 18, INK, { weight: 1, lh: 22, maxLines: 3 },
  );

  // Third row, right: Shenzhou-24 at Tiangong.
  iconRocket(714, 760);
  drawText('SPACE', 744, 754, 18, RED, { weight: 1.3, tracking: 1 });
  drawBlock('PAKISTANI ASTRONAUT DOCKS AT TIANGONG', 692, 794, 296, 28, INK, {
    weight: 1.55,
    lh: 34,
    maxLines: 3,
  });
  drawBlock(
    "ZEESHAN ALI, FIRST FOREIGN VISITOR TO CHINA'S SPACE STATION",
    692, 898, 296, 18, INK, { weight: 1, lh: 22, maxLines: 3 },
  );
  vRule(348, 748, 210);
  vRule(676, 748, 210);

  // Footer.
  rule(970, 2);
  drawText(
    'AS REPORTED BY REUTERS, AP, BBC, CNN, THE TIMES AND NATURE - 25-26 NOVEMBER 2026',
    512, 980, 15.5, FAINT, { weight: 0.95, align: 'center' },
  );
}

drawPage();

const png = encodePng(downsample(), PAGE, PAGE);
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'entry.png'), png);
