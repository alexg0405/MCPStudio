// Generates the app icons (public/icons/*): one design, written as an SVG and rasterized to PNG here with
// only Node built-ins (a tiny anti-aliased shape renderer and a PNG encoder on node:zlib).
//   node scripts/make-icons.mjs
// The generated files are committed; run this only when the design changes (test/unit/pwa.test.ts checks them).
//
// The design follows the app's look (src/ui/theme/tokens.css): an obsidian tile with a hairline gold edge and four
// rising bars in brushed gold, the same bar silhouette as the favicon.
import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const outDir = fileURLToPath(new URL('../public/icons/', import.meta.url));

// Palette (tokens.css: --ag-bg, --ag-surface-2, --ag-accent and shades of it).
const TILE_TOP = '#212226';
const TILE_BOTTOM = '#0b0c0e';
const EDGE = { color: '#c9a45c', opacity: 0.38 };
const GOLD_LIGHT = '#ead9aa';
const GOLD = '#c9a45c';
const GOLD_DEEP = '#8d7236';

/** Bars in a 100x100 design space on a shared baseline; the tallest is the bright one. */
const BAR_W = 13;
const BASE_Y = 83;
const BARS = [
  { x: 15, h: 28, top: GOLD, bottom: GOLD_DEEP },
  { x: 34, h: 50, top: GOLD, bottom: GOLD_DEEP },
  { x: 53, h: 66, top: GOLD_LIGHT, bottom: GOLD },
  { x: 72, h: 41, top: GOLD, bottom: GOLD_DEEP },
];

/**
 * Shapes (rounded rectangles with a vertical two-color gradient or a flat color), painted in order.
 * `scale` shrinks the artwork around the center (the maskable and Apple icons keep it inside the safe zone).
 * `rounded`: the tile has rounded corners; maskable icons are full bleed (the OS applies its own mask).
 */
function design({ rounded, scale }) {
  const about = (v) => 50 + (v - 50) * scale;
  const shapes = [];
  const r = rounded ? 22 : 0;
  if (rounded) shapes.push({ x: 0, y: 0, w: 100, h: 100, r, fill: EDGE.color, opacity: EDGE.opacity });
  const inset = rounded ? 1.3 : 0;
  shapes.push({
    x: inset,
    y: inset,
    w: 100 - 2 * inset,
    h: 100 - 2 * inset,
    r: Math.max(0, r - inset),
    fill: [TILE_TOP, TILE_BOTTOM],
    opacity: 1,
  });
  for (const b of BARS) {
    shapes.push({
      x: about(b.x),
      y: about(BASE_Y - b.h),
      w: BAR_W * scale,
      h: b.h * scale,
      r: 3.5 * scale,
      fill: [b.top, b.bottom],
      opacity: 1,
    });
  }
  return shapes;
}

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

function svgOf(shapes) {
  const defs = [];
  const num = (n) => +n.toFixed(3);
  const body = shapes.map((s, i) => {
    let fill = s.fill;
    if (Array.isArray(fill)) {
      defs.push(
        `<linearGradient id="g${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${fill[0]}"/><stop offset="1" stop-color="${fill[1]}"/></linearGradient>`,
      );
      fill = `url(#g${i})`;
    }
    const op = s.opacity < 1 ? ` fill-opacity="${s.opacity}"` : '';
    return `  <rect x="${num(s.x)}" y="${num(s.y)}" width="${num(s.w)}" height="${num(s.h)}" rx="${num(s.r)}" fill="${fill}"${op}/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">\n  <defs>${defs.join('')}</defs>\n${body.join('\n')}\n</svg>\n`;
}

/** Is the point inside the rounded rectangle? */
function inside(s, px, py) {
  if (px < s.x || px > s.x + s.w || py < s.y || py > s.y + s.h) return false;
  if (s.r <= 0) return true;
  const cx = Math.min(Math.max(px, s.x + s.r), s.x + s.w - s.r);
  const cy = Math.min(Math.max(py, s.y + s.r), s.y + s.h - s.r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= s.r * s.r;
}

/** Rasterizes the shapes at `size` px with 4x4 supersampling; returns RGBA bytes. */
function raster(shapes, size) {
  const SS = 4;
  const painted = shapes.map((s) => {
    const grad = Array.isArray(s.fill) ? s.fill.map(hex) : null;
    return { ...s, flat: grad ? null : hex(s.fill), grad };
  });
  const rgba = Buffer.alloc(size * size * 4);
  const unit = 100 / (size * SS);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Sums over the samples of the premultiplied color and of the alpha.
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x * SS + sx + 0.5) * unit;
          const py = (y * SS + sy + 0.5) * unit;
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          for (const s of painted) {
            if (!inside(s, px, py)) continue;
            let c = s.flat;
            if (s.grad) {
              const t = Math.min(1, Math.max(0, (py - s.y) / s.h));
              c = s.grad[0].map((v, i) => v + (s.grad[1][i] - v) * t);
            }
            const sa = s.opacity;
            r = c[0] * sa + r * (1 - sa);
            g = c[1] * sa + g * (1 - sa);
            b = c[2] * sa + b * (1 - sa);
            a = sa + a * (1 - sa);
          }
          pr += r;
          pg += g;
          pb += b;
          pa += a;
        }
      }
      const i = (y * size + x) * 4;
      if (pa > 0) {
        rgba[i] = Math.round(pr / pa);
        rgba[i + 1] = Math.round(pg / pa);
        rgba[i + 2] = Math.round(pb / pa);
        rgba[i + 3] = Math.round((pa / (SS * SS)) * 255);
      }
    }
  }
  return rgba;
}

function png(rgba, size) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4 + 1;
  const rows = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    rows[y * stride] = 0; // filter: none
    rgba.copy(rows, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const any = design({ rounded: true, scale: 1 });
const maskable = design({ rounded: false, scale: 0.74 });
const apple = design({ rounded: false, scale: 0.9 });

mkdirSync(outDir, { recursive: true });
const files = [
  ['icon.svg', Buffer.from(svgOf(any))],
  ['icon-192.png', png(raster(any, 192), 192)],
  ['icon-512.png', png(raster(any, 512), 512)],
  ['icon-maskable-512.png', png(raster(maskable, 512), 512)],
  ['apple-touch-icon.png', png(raster(apple, 180), 180)],
];
for (const [name, bytes] of files) {
  writeFileSync(outDir + name, bytes);
  console.log(`public/icons/${name}  ${bytes.length} bytes`);
}
