// Builds every app icon from the master logo, assets/logo-source.png, using
// only Node built-ins: decode PNG, area-average resample, encode PNG.
//
//   npm run icons                              regenerate public/icons/*
//   node scripts/make-icons.mjs --import <png> replace the master logo first
//
// Importing re-encodes the image, which also drops any text metadata.

import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const MASTER = join(root, 'assets', 'logo-source.png');
const OUT = join(root, 'public', 'icons');
const BACKGROUND = [0x0e, 0x15, 0x12, 255]; // manifest background_color

// ------------------------------------------------------------------ PNG I/O

function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG file');
  let p = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let color = 0;
  let interlace = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      color = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (color !== 6 && color !== 2)) {
    throw new Error(`unsupported PNG (bit depth ${depth}, color type ${color}, interlace ${interlace}); save it as 8-bit RGB or RGBA`);
  }
  const bpp = color === 6 ? 4 : 3;
  const stride = w * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      line[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const s = x * bpp;
      const d = (y * w + x) * 4;
      rgba[d] = line[s];
      rgba[d + 1] = line[s + 1];
      rgba[d + 2] = line[s + 2];
      rgba[d + 3] = bpp === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }
  return { w, h, rgba };
}

// Adaptive per-row filtering (smallest sum of absolute values) keeps files small.
export function encodePNG({ w, h, rgba }) {
  const stride = w * 4;
  const rows = [];
  const zero = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const cur = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y ? rgba.subarray((y - 1) * stride, y * stride) : zero;
    let best = null;
    let bestScore = Infinity;
    for (let f = 0; f <= 4; f++) {
      const out = Buffer.alloc(stride + 1);
      out[0] = f;
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= 4 ? cur[x - 4] : 0;
        const b = prev[x];
        const c = x >= 4 ? prev[x - 4] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (cur[x] - pred) & 255;
        out[x + 1] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = out;
      }
    }
    rows.push(best);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --------------------------------------------------------------- resampling

// Area-average resize with premultiplied alpha (no dark fringes at edges).
export function resize(img, W, H) {
  const { w, h, rgba } = img;
  const sx = w / W;
  const sy = h / H;
  const tmp = new Float64Array(W * h * 4);
  for (let y = 0; y < h; y++) {
    for (let X = 0; X < W; X++) {
      const x0 = X * sx;
      const x1 = x0 + sx;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let x = Math.floor(x0); x < Math.ceil(x1) && x < w; x++) {
        const cov = Math.min(x + 1, x1) - Math.max(x, x0);
        if (cov <= 0) continue;
        const i = (y * w + x) * 4;
        const al = rgba[i + 3] / 255;
        r += rgba[i] * al * cov;
        g += rgba[i + 1] * al * cov;
        b += rgba[i + 2] * al * cov;
        a += al * cov;
      }
      const o = (y * W + X) * 4;
      tmp[o] = r / sx;
      tmp[o + 1] = g / sx;
      tmp[o + 2] = b / sx;
      tmp[o + 3] = a / sx;
    }
  }
  const out = Buffer.alloc(W * H * 4);
  for (let Y = 0; Y < H; Y++) {
    const y0 = Y * sy;
    const y1 = y0 + sy;
    for (let X = 0; X < W; X++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1) && y < h; y++) {
        const cov = Math.min(y + 1, y1) - Math.max(y, y0);
        if (cov <= 0) continue;
        const i = (y * W + X) * 4;
        r += tmp[i] * cov;
        g += tmp[i + 1] * cov;
        b += tmp[i + 2] * cov;
        a += tmp[i + 3] * cov;
      }
      r /= sy;
      g /= sy;
      b /= sy;
      a /= sy;
      const o = (Y * W + X) * 4;
      const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
      out[o] = a > 0 ? clamp(r / a) : 0;
      out[o + 1] = a > 0 ? clamp(g / a) : 0;
      out[o + 2] = a > 0 ? clamp(b / a) : 0;
      out[o + 3] = clamp(a * 255);
    }
  }
  return { w: W, h: H, rgba: out };
}

// Logo scaled to `scale` of a size x size canvas, centred, over `bg` (or clear).
function place(logo, size, scale, bg = null) {
  const inner = Math.round(size * scale);
  const art = resize(logo, inner, inner);
  const rgba = Buffer.alloc(size * size * 4);
  if (bg) for (let i = 0; i < size * size; i++) rgba.set(bg, i * 4);
  const off = Math.floor((size - inner) / 2);
  for (let y = 0; y < inner; y++) {
    for (let x = 0; x < inner; x++) {
      const s = (y * inner + x) * 4;
      const d = ((y + off) * size + (x + off)) * 4;
      const a = art.rgba[s + 3] / 255;
      const da = rgba[d + 3] / 255;
      const oa = a + da * (1 - a);
      for (let k = 0; k < 3; k++) {
        const v = oa > 0 ? (art.rgba[s + k] * a + rgba[d + k] * da * (1 - a)) / oa : 0;
        rgba[d + k] = Math.round(v);
      }
      rgba[d + 3] = Math.round(oa * 255);
    }
  }
  return { w: size, h: size, rgba };
}

// -------------------------------------------------------------------- main

const args = process.argv.slice(2);
const importAt = args.indexOf('--import');
if (importAt >= 0) {
  const src = decodePNG(readFileSync(args[importAt + 1]));
  mkdirSync(dirname(MASTER), { recursive: true });
  writeFileSync(MASTER, encodePNG(src));
  let clear = 0;
  for (let i = 3; i < src.rgba.length; i += 4) if (src.rgba[i] === 0) clear++;
  console.log(`imported ${src.w}x${src.h} master logo (${Math.round((100 * clear) / (src.w * src.h))}% transparent pixels) -> assets/logo-source.png`);
}

const logo = decodePNG(readFileSync(MASTER));
mkdirSync(OUT, { recursive: true });
const targets = [
  ['icon-512.png', place(logo, 512, 1)],
  ['icon-192.png', place(logo, 192, 1)],
  ['favicon-32.png', place(logo, 32, 1)],
  // Android crops maskable icons to a circle: keep the book inside the safe zone.
  ['icon-512-maskable.png', place(logo, 512, 0.62, BACKGROUND)],
  // iOS does not keep transparency and rounds the corners itself.
  ['apple-touch-icon.png', place(logo, 180, 0.86, BACKGROUND)],
];
for (const [name, img] of targets) {
  const png = encodePNG(img);
  writeFileSync(join(OUT, name), png);
  console.log(`wrote ${name} (${img.w}x${img.h}, ${Math.round(png.length / 1024)} KB)`);
}

// Kept for old bookmarks and caches that still ask for the SVG icon.
const small = encodePNG(place(logo, 64, 1)).toString('base64');
writeFileSync(
  join(OUT, 'icon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><image width="64" height="64" href="data:image/png;base64,${small}"/></svg>\n`,
);
console.log('wrote icon.svg (wraps the 64 px logo)');
