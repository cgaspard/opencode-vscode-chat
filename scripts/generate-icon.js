#!/usr/bin/env node
// Generate a 256x256 PNG icon for OpenCode Chat. Pure Node, no deps.
//
// Design: the same dark rounded square + single violet glyph as the rest of
// this publisher's extensions, carrying OpenCode's own block "o" — the mark
// from sst/opencode packages/web/public/favicon-v3.svg, on its 64/512 grid.
// Their two-tone treatment (light frame, mid-tone counter) is preserved as
// violet-on-darker-violet, so it reads as OpenCode at 256px and as a solid
// glyph at 32.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const RADIUS = 44;

const BG = [0x1a, 0x1f, 0x2a, 0xff]; // deep slate
const BG_GLOW = [0x2c, 0x26, 0x46, 0xff]; // violet-tinted center glow
const GLYPH = [0x8b, 0x5c, 0xf6, 0xff]; // the "o" frame
const GLYPH_INNER = [0x53, 0x37, 0xa8, 0xff]; // its counter, a shade back

const out = new Uint8Array(SIZE * SIZE * 4);

function setPx(x, y, rgba) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  out[i] = rgba[0];
  out[i + 1] = rgba[1];
  out[i + 2] = rgba[2];
  out[i + 3] = rgba[3];
}
function getPx(x, y) {
  const i = (y * SIZE + x) * 4;
  return [out[i], out[i + 1], out[i + 2], out[i + 3]];
}
function blend(dst, src) {
  const sa = src[3] / 255;
  const da = dst[3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa === 0) return [0, 0, 0, 0];
  return [
    Math.round((src[0] * sa + dst[0] * da * (1 - sa)) / oa),
    Math.round((src[1] * sa + dst[1] * da * (1 - sa)) / oa),
    Math.round((src[2] * sa + dst[2] * da * (1 - sa)) / oa),
    Math.round(oa * 255),
  ];
}
function aaPx(x, y, rgba, coverage) {
  if (coverage <= 0) return;
  const c = Math.min(1, coverage);
  const tinted = [rgba[0], rgba[1], rgba[2], Math.round(rgba[3] * c)];
  const blended = blend(getPx(x, y), tinted);
  const i = (y * SIZE + x) * 4;
  out[i] = blended[0];
  out[i + 1] = blended[1];
  out[i + 2] = blended[2];
  out[i + 3] = blended[3];
}
function fillRoundedRect(x0, y0, w, h, r, rgba) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const cx = x < x0 + r ? x0 + r : x > x0 + w - 1 - r ? x0 + w - 1 - r : x;
      const cy = y < y0 + r ? y0 + r : y > y0 + h - 1 - r ? y0 + h - 1 - r : y;
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r - 0.5) setPx(x, y, rgba);
      else if (d <= r + 0.5) aaPx(x, y, rgba, r + 0.5 - d);
    }
  }
}
function radialGlow(cx, cy, rOuter, rgba) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d >= rOuter) continue;
      const t = 1 - d / rOuter;
      aaPx(x, y, rgba, t * t * 0.55);
    }
  }
}
function fillCircle(cx, cy, r, rgba) {
  const minX = Math.max(0, Math.floor(cx - r - 1));
  const maxX = Math.min(SIZE - 1, Math.ceil(cx + r + 1));
  const minY = Math.max(0, Math.floor(cy - r - 1));
  const maxY = Math.min(SIZE - 1, Math.ceil(cy + r + 1));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= r - 0.5) setPx(x, y, rgba);
      else if (d <= r + 0.5) aaPx(x, y, rgba, r + 0.5 - d);
    }
  }
}
// AA line with rounded caps (= a capsule)
function drawLine(x0, y0, x1, y1, thickness, rgba) {
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - thickness - 1));
  const maxX = Math.min(SIZE - 1, Math.ceil(Math.max(x0, x1) + thickness + 1));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - thickness - 1));
  const maxY = Math.min(SIZE - 1, Math.ceil(Math.max(y0, y1) + thickness + 1));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  const half = thickness / 2;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let t = lenSq === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / lenSq;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
      if (d <= half - 0.5) setPx(x, y, rgba);
      else if (d <= half + 0.5) aaPx(x, y, rgba, half + 0.5 - d);
    }
  }
}
function fillRoundedNode(nx, ny, half, r, fill, outline) {
  fillRoundedRect(nx - half, ny - half, half * 2, half * 2, r, outline);
  fillRoundedRect(nx - half + 3, ny - half + 3, half * 2 - 6, half * 2 - 6, Math.max(0, r - 3), fill);
}
function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// --- Background ---
fillRoundedRect(0, 0, SIZE, SIZE, RADIUS, BG);
radialGlow(SIZE / 2, SIZE / 2 + 18, 170, BG_GLOW);

// --- Glyph: OpenCode's block "o" ---
// Their favicon is a 512 canvas; every coordinate below is that geometry at
// half scale, centred. Drawn as four bars rather than a rect with a hole
// punched in it, so the background glow shows through the counter instead of
// being painted over with flat slate.
function fillRect(x0, y0, w, h, rgba) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      setPx(x, y, rgba);
    }
  }
}
const S = 0.5;
const map = (x, y) => [64 + (x - 128) * S, 48 + (y - 96) * S];
const [gx0, gy0] = map(128, 96); //  64,  48 — outer top-left
const [gx1, gy1] = map(384, 416); // 192, 208 — outer bottom-right
const [hx0, hy0] = map(192, 160); //  96,  80 — counter top-left
const [hx1, hy1] = map(320, 352); // 160, 176 — counter bottom-right
const [, sy0] = map(0, 224); //       112     — the counter's shaded portion

fillRect(gx0, gy0, gx1 - gx0, hy0 - gy0, GLYPH); // top bar
fillRect(gx0, hy1, gx1 - gx0, gy1 - hy1, GLYPH); // bottom bar
fillRect(gx0, hy0, hx0 - gx0, hy1 - hy0, GLYPH); // left bar
fillRect(hx1, hy0, gx1 - hx1, hy1 - hy0, GLYPH); // right bar
// The counter is only shaded from 224 down in their mark — the gap above it is
// what gives the glyph its depth.
fillRect(hx0, sy0, hx1 - hx0, hy1 - sy0, GLYPH_INNER);

// --- Encode PNG ---
function crc32(buf) {
  const table =
    crc32.table ||
    (crc32.table = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
      }
      return t;
    })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const rowBytes = SIZE * 4;
const raw = Buffer.alloc((rowBytes + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (rowBytes + 1)] = 0;
  Buffer.from(out.subarray(y * rowBytes, (y + 1) * rowBytes)).copy(raw, y * (rowBytes + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const target = path.join(__dirname, '..', 'media', 'icon.png');
fs.writeFileSync(target, png);
console.log(`Wrote ${target} (${png.length} bytes, ${SIZE}x${SIZE})`);
