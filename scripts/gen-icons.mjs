#!/usr/bin/env node
// Generate Fangio's toolbar/store icons (PNG 16/32/48/128) into static/icons/.
// Dependency-free: a tiny anti-aliased rasterizer (signed distance fields + supersampling)
// and a PNG encoder (zlib + CRC-32). Run with `npm run icons`; the PNGs are committed.
//
// Design: rounded square in deep petrol/teal; white glyph of browser tabs stacked over an
// archive box (lid + body with a handle slot).
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { ROOT, crc32 } from './lib/common.mjs';

const SIZES = [16, 32, 48, 128];
const OUT_DIR = resolve(ROOT, 'static/icons');

// ---------- geometry (unit square, y grows downwards) ----------

/** Signed distance to an axis-aligned rounded box [x0,x1]x[y0,y1] with corner radius r. */
function sdRoundBox(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const qx = Math.abs(px - cx) - ((x1 - x0) / 2 - r);
  const qy = Math.abs(py - cy) - ((y1 - y0) / 2 - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

const roundBox = (x0, y0, x1, y1, r) => (x, y) => sdRoundBox(x, y, x0, y0, x1, y1, r) <= 0;

/** Browser-tab silhouette: rounded top corners, square bottom. */
const tabShape = (x0, y0, x1, y1, r) => (x, y) =>
  x >= x0 && x <= x1 && y <= y1 && (y >= (y0 + y1) / 2 || sdRoundBox(x, y, x0, y0, x1, y1, r) <= 0);

/** Grow a shape description by `g` (used to knock out a gap around the front tab). */
const tabKnockout = (x0, y0, x1, y1, r, g) => tabShape(x0 - g, y0 - g, x1 + g, y1, r + g);

// ---------- colours ----------

const TOP = [0x15, 0x86, 0x8f]; // teal
const BOTTOM = [0x0a, 0x45, 0x4e]; // deep petrol
function bgColor(x, y) {
  const t = Math.min(1, Math.max(0, (x * 0.35 + y * 0.65 - 0.05) / 0.9));
  return TOP.map((c, i) => c + (BOTTOM[i] - c) * t);
}
const WHITE = [255, 255, 255];

/** Paint list for a given pixel size. */
function scene(size) {
  if (size <= 16) return scene16();
  if (size <= 32) return scene32();
  const gap = Math.max(0.025, 1.1 / size);
  const ops = [{ shape: roundBox(0.03, 0.03, 0.97, 0.97, 0.22), paint: 'bg' }];
  // Back tab (translucent), then a knockout gap, then the front tab.
  ops.push({ shape: tabShape(0.37, 0.15, 0.75, 0.44, 0.07), paint: [...WHITE, 0.5] });
  ops.push({ shape: tabKnockout(0.25, 0.25, 0.63, 0.44, 0.07, gap), paint: 'bg' });
  ops.push({ shape: tabShape(0.25, 0.25, 0.63, 0.44, 0.07), paint: [...WHITE, 1] });
  const lidTop = 0.44 + gap;
  ops.push({ shape: roundBox(0.15, lidTop, 0.85, lidTop + 0.13, 0.04), paint: [...WHITE, 1] });
  const bodyTop = lidTop + 0.13 + gap;
  ops.push({ shape: roundBox(0.21, bodyTop, 0.79, 0.84, 0.05), paint: [...WHITE, 1] });
  const slotY = bodyTop + 0.06;
  ops.push({ shape: roundBox(0.39, slotY, 0.61, slotY + 0.055, 0.0275), paint: 'bg' });
  return ops;
}

// Small sizes are drawn on the pixel grid (coordinates in pixels) so edges stay crisp.
const onGrid = (n) => (v) => v / n;

function scene32() {
  const p = onGrid(32);
  return [
    { shape: roundBox(p(1), p(1), p(31), p(31), p(7)), paint: 'bg' },
    { shape: tabShape(p(13), p(4), p(25), p(14), p(2)), paint: [...WHITE, 0.5] },
    { shape: tabKnockout(p(8), p(7), p(20), p(14), p(2), p(1)), paint: 'bg' },
    { shape: tabShape(p(8), p(7), p(20), p(14), p(2)), paint: [...WHITE, 1] },
    { shape: roundBox(p(5), p(15), p(27), p(19), p(1.5)), paint: [...WHITE, 1] },
    { shape: roundBox(p(7), p(20), p(25), p(27), p(2)), paint: [...WHITE, 1] },
    { shape: roundBox(p(13), p(22), p(19), p(24), p(1)), paint: 'bg' },
  ];
}

function scene16() {
  const p = onGrid(16);
  return [
    { shape: roundBox(0, 0, 1, 1, p(3.5)), paint: 'bg' },
    { shape: tabShape(p(5), p(3), p(11), p(7), p(1.5)), paint: [...WHITE, 1] },
    { shape: roundBox(p(3), p(8), p(13), p(10), p(0.75)), paint: [...WHITE, 1] },
    { shape: roundBox(p(4), p(11), p(12), p(14), p(1)), paint: [...WHITE, 1] },
    { shape: roundBox(p(7), p(12), p(9), p(13), p(0.3)), paint: 'bg' },
  ];
}

// ---------- rasterizer ----------

function render(size) {
  const ops = scene(size);
  const SS = size <= 32 ? 16 : 8; // samples per axis
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let ar = 0, ag = 0, ab = 0, aa = 0; // premultiplied accumulators
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          let r = 0, g = 0, b = 0, a = 0; // premultiplied, "over" compositing
          for (const op of ops) {
            if (!op.shape(x, y)) continue;
            const [cr, cg, cb, ca] = op.paint === 'bg' ? [...bgColor(x, y), 1] : op.paint;
            r = cr * ca + r * (1 - ca);
            g = cg * ca + g * (1 - ca);
            b = cb * ca + b * (1 - ca);
            a = ca + a * (1 - ca);
          }
          ar += r; ag += g; ab += b; aa += a;
        }
      }
      const n = SS * SS;
      const alpha = aa / n;
      const i = (py * size + px) * 4;
      if (alpha > 0) {
        out[i] = Math.round(ar / n / alpha);
        out[i + 1] = Math.round(ag / n / alpha);
        out[i + 2] = Math.round(ab / n / alpha);
      }
      out[i + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

// ---------- PNG encoder ----------

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // no interlace
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const png = encodePng(size, render(size));
  writeFileSync(resolve(OUT_DIR, `icon${size}.png`), png);
  console.log(`static/icons/icon${size}.png (${png.length} bytes)`);
}
