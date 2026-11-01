// Draws the ClaudeOS icon, a glowing cloud of memory dots around a bright core on the page's
// night background, and writes assets/icon.ico (16 to 256 px) and public/favicon.png.
// Run with `npm run icon`; the build embeds assets/icon.ico in ClaudeOS.exe.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hex = c => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
const DOT_COLORS = [0xc9a7ff, 0xffc861, 0xff7aa8, 0x5fd4ff, 0x7dff9e, 0xc9a7ff, 0x5fd4ff].map(hex);

// The same dots at every size, from a fixed seed, in a squashed ball around the core.
function dots(count) {
  let s = 7;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rnd() * 0.9, r = 0.18 + Math.sqrt(rnd()) * 0.2;
    out.push({ x: 0.5 + Math.cos(a) * r, y: 0.5 + Math.sin(a) * r * 0.82, depth: rnd(), color: DOT_COLORS[i % DOT_COLORS.length] });
  }
  return out;
}

// Straight-alpha RGBA pixels, drawn at 4x and averaged down so edges stay smooth.
function render(size) {
  const SS = 4, N = size * SS, small = size <= 24;
  const field = dots(small ? 7 : size <= 48 ? 12 : 22);
  const dotR = (small ? 0.07 : size <= 48 ? 0.05 : 0.035);
  const acc = new Float64Array(size * size * 4);
  for (let py = 0; py < N; py++) for (let px = 0; px < N; px++) {
    const x = (px + 0.5) / N, y = (py + 0.5) / N;
    // rounded square
    const k = 0.22, qx = Math.max(Math.abs(x - 0.5) - (0.5 - k), 0), qy = Math.max(Math.abs(y - 0.5) - (0.5 - k), 0);
    const edge = Math.hypot(qx, qy) - k;
    if (edge > 0) continue;
    const t = y;
    let r = 17 * (1 - t) + 5 * t, g = 20 * (1 - t) + 6 * t, b = 42 * (1 - t) + 13 * t;
    const add = (c, a) => { r += (c[0] - r) * a; g += (c[1] - g) * a; b += (c[2] - b) * a; };
    // faint rim
    if (edge > -0.012 && !small) add([160, 175, 255], 0.18);
    // the brain's glow
    const d = Math.hypot(x - 0.5, (y - 0.5) / 0.82);
    add([127, 149, 255], 0.55 * Math.exp(-(d * d) / 0.045));
    // memory dots, far ones dimmer, each with a soft halo
    for (const p of field) {
      const dd = Math.hypot(x - p.x, y - p.y), rr = dotR * (0.75 + p.depth * 0.5), bright = 0.55 + p.depth * 0.45;
      if (dd < rr) add(p.color, bright);
      else add(p.color, bright * 0.35 * Math.exp(-((dd - rr) ** 2) / (rr * rr * 1.2)));
    }
    // the core: a warm accent sphere with a highlight
    const cr = small ? 0.13 : 0.11;
    if (d < cr) {
      const lx = (x - 0.5) / cr + 0.35, ly = (y - 0.5) / cr + 0.35, light = Math.max(0, 1 - Math.hypot(lx, ly) * 0.7);
      add([217, 119, 87], 1);
      add([255, 236, 220], light * light * 0.85);
    } else add([255, 190, 160], 0.5 * Math.exp(-((d - cr) ** 2) / 0.002));
    const i = (Math.floor(py / SS) * size + Math.floor(px / SS)) * 4;
    acc[i] += r; acc[i + 1] += g; acc[i + 2] += b; acc[i + 3] += 1;
  }
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const n = acc[i * 4 + 3];
    if (!n) continue;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(Math.min(255, acc[i * 4 + c] / n));
    out[i * 4 + 3] = Math.round((n / (SS * SS)) * 255);
  }
  return out;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// An .ico whose images are all PNGs (fine on Windows Vista and later).
function ico(images) {
  const head = Buffer.alloc(6 + images.length * 16);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    head[e] = size >= 256 ? 0 : size; head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map(i => i.data)]);
}

const images = [16, 24, 32, 48, 64, 128, 256].map(size => ({ size, data: png(size, render(size)) }));
fs.mkdirSync(path.join(ROOT, 'assets'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'assets', 'icon.ico'), ico(images));
fs.writeFileSync(path.join(ROOT, 'assets', 'icon-256.png'), images.at(-1).data);
fs.writeFileSync(path.join(ROOT, 'public', 'favicon.png'), images.find(i => i.size === 64).data);
console.log('Wrote assets/icon.ico, assets/icon-256.png and public/favicon.png');
