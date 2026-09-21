// Generates the PWA icons (a ball of yarn on deep indigo) as real PNG files
// using only Node's built-in zlib, plus a matching SVG. Run: npm run icons

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

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
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

const BG_TOP = hex('#2d2557');
const BG_BOTTOM = hex('#171226');
const YARN = hex('#f6e9c9');
const YARN_SHADE = hex('#e2c98f');
const STRAND = hex('#d99a2b');
const ACCENT = hex('#5fd3c4');

// Distance from point to a quadratic Bezier, sampled.
function bezierDist(px, py, p0, p1, p2) {
  let best = Infinity;
  for (let i = 0; i <= 48; i++) {
    const t = i / 48;
    const x = (1 - t) * (1 - t) * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0];
    const y = (1 - t) * (1 - t) * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1];
    const d = Math.hypot(px - x, py - y);
    if (d < best) best = d;
  }
  return best;
}

function render(size, { rounded }) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size * 0.47;
  const cy = size * 0.5;
  const R = size * 0.29;
  const corner = size * 0.22;
  // loose strand from the ball toward the top-right corner
  const s0 = [cx + R * 0.7, cy - R * 0.7];
  const s1 = [size * 0.86, size * 0.2];
  const s2 = [size * 0.8, size * 0.47];
  const strandW = size * 0.028;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // rounded-square mask
      let alpha = 1;
      if (rounded) {
        const qx = Math.max(Math.abs(x + 0.5 - size / 2) - (size / 2 - corner), 0);
        const qy = Math.max(Math.abs(y + 0.5 - size / 2) - (size / 2 - corner), 0);
        const d = Math.hypot(qx, qy) - corner;
        alpha = Math.min(1, Math.max(0, 0.5 - d));
      }
      let col = mix(BG_TOP, BG_BOTTOM, y / size);

      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.hypot(dx, dy);
      const edge = R - dist;
      if (edge > -1) {
        const cover = Math.min(1, Math.max(0, edge + 0.5));
        // base shading: lighter top-left
        const light = 0.5 + 0.5 * (-(dx + dy) / (R * 1.6));
        let ball = mix(YARN_SHADE, YARN, Math.min(1, Math.max(0, light)));
        // two families of curved strands
        const a1 = 0.6;
        const u1 = (dx * Math.cos(a1) + dy * Math.sin(a1)) / R;
        const v1 = (-dx * Math.sin(a1) + dy * Math.cos(a1)) / R;
        const t1 = u1 + 0.45 * v1 * v1;
        const band1 = Math.abs((((t1 * 3.2) % 1) + 1) % 1 - 0.5);
        const a2 = -0.9;
        const u2 = (dx * Math.cos(a2) + dy * Math.sin(a2)) / R;
        const v2 = (-dx * Math.sin(a2) + dy * Math.cos(a2)) / R;
        const t2 = u2 + 0.4 * v2 * v2;
        const band2 = Math.abs((((t2 * 2.6) % 1) + 1) % 1 - 0.5);
        const strand = Math.max(0, 0.09 - band1) / 0.09 * 0.8 + Math.max(0, 0.06 - band2) / 0.06 * 0.55;
        ball = mix(ball, STRAND, Math.min(1, strand) * 0.75);
        // rim shadow
        const rim = Math.min(1, Math.max(0, (R - dist) / (R * 0.18)));
        ball = mix(mix(ball, BG_BOTTOM, 0.35), ball, rim);
        col = mix(col, ball, cover);
      }
      // loose strand
      const sd = bezierDist(x + 0.5, y + 0.5, s0, s1, s2) - strandW / 2;
      if (sd < 1) {
        const cover = Math.min(1, Math.max(0, 1 - sd));
        col = mix(col, STRAND, cover * 0.95);
      }
      // accent dot: Jev's eye on the story
      const ax = size * 0.8;
      const ay = size * 0.47;
      const ad = Math.hypot(x + 0.5 - ax, y + 0.5 - ay) - size * 0.045;
      if (ad < 1) col = mix(col, ACCENT, Math.min(1, Math.max(0, 1 - ad)));

      buf[i] = Math.round(col[0]);
      buf[i + 1] = Math.round(col[1]);
      buf[i + 2] = Math.round(col[2]);
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePNG(size, size, buf);
}

const targets = [
  ['icon-192.png', 192, { rounded: true }],
  ['icon-512.png', 512, { rounded: true }],
  ['icon-512-maskable.png', 512, { rounded: false }],
  ['apple-touch-icon.png', 180, { rounded: false }],
  ['favicon-32.png', 32, { rounded: true }],
];
for (const [name, size, opts] of targets) {
  writeFileSync(join(outDir, name), render(size, opts));
  console.log('wrote', name);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2d2557"/><stop offset="1" stop-color="#171226"/>
    </linearGradient>
    <clipPath id="ball"><circle cx="47" cy="50" r="29"/></clipPath>
  </defs>
  <rect width="100" height="100" rx="22" fill="url(#bg)"/>
  <circle cx="47" cy="50" r="29" fill="#f6e9c9"/>
  <g clip-path="url(#ball)" fill="none" stroke="#d99a2b" stroke-width="3.2" stroke-linecap="round">
    <path d="M14 36 Q47 22 80 40"/><path d="M14 50 Q47 34 82 54"/><path d="M16 64 Q47 46 80 68"/>
    <path d="M28 20 Q22 50 34 80"/><path d="M52 20 Q40 50 56 82"/>
  </g>
  <path d="M67 30 Q86 20 80 47" fill="none" stroke="#d99a2b" stroke-width="2.8" stroke-linecap="round"/>
  <circle cx="80" cy="47" r="4.5" fill="#5fd3c4"/>
</svg>
`;
writeFileSync(join(outDir, 'icon.svg'), svg);
console.log('wrote icon.svg');
