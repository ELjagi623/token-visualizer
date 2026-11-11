/**
 * 生成占位应用图标 desktop/icon.png（512×512）：深色圆角方块 + 渐变绿的柱状图。
 * 没有第三方依赖（自己写 PNG 编码）。想换成自己的图标：直接替换 desktop/icon.png（≥ 256×256 的 PNG 即可，
 * electron-builder 会自动转成 .ico）。
 *
 *   npm run icon
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const N = 512;
const SS = 3; // 抗锯齿：每像素 3×3 采样

// 圆角矩形的有符号距离（内部为负）
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - (hw - r);
  const dy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
}

const mix = (a, b, t) => a + (b - a) * t;
const hex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const BG_TOP = hex(0x1f2a2e);
const BG_BOT = hex(0x0e1316);
const GREEN_TOP = hex(0x5ee0a0);
const GREEN_BOT = hex(0x1fa971);

// 三根上升的柱子（相对 512 画布）
const bars = [
  { x: 118, w: 78, top: 288, bot: 392 },
  { x: 217, w: 78, top: 220, bot: 392 },
  { x: 316, w: 78, top: 130, bot: 392 },
];

function shade(x, y) {
  // 返回 [r, g, b, a]（0–255, a 0–1）
  const bg = sdRoundRect(x, y, N / 2, N / 2, N / 2 - 8, N / 2 - 8, 110);
  if (bg > 0) return [0, 0, 0, 0];
  const t = y / N;
  let c = [mix(BG_TOP[0], BG_BOT[0], t), mix(BG_TOP[1], BG_BOT[1], t), mix(BG_TOP[2], BG_BOT[2], t)];
  // 轻微的内描边
  if (bg > -5) c = c.map((v) => v + 18);
  for (const b of bars) {
    const d = sdRoundRect(x, y, b.x + b.w / 2, (b.top + b.bot) / 2, b.w / 2, (b.bot - b.top) / 2, 20);
    if (d <= 0) {
      const u = (y - b.top) / (b.bot - b.top);
      c = [mix(GREEN_TOP[0], GREEN_BOT[0], u), mix(GREEN_TOP[1], GREEN_BOT[1], u), mix(GREEN_TOP[2], GREEN_BOT[2], u)];
    }
  }
  return [c[0], c[1], c[2], 1];
}

const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0; // 过滤类型 0
  for (let x = 0; x < N; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const s = shade(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        r += s[0] * s[3];
        g += s[1] * s[3];
        b += s[2] * s[3];
        a += s[3];
      }
    }
    const o = y * (N * 4 + 1) + 1 + x * 4;
    const cnt = SS * SS;
    if (a > 0) {
      raw[o] = Math.round(r / a);
      raw[o + 1] = Math.round(g / a);
      raw[o + 2] = Math.round(b / a);
    }
    raw[o + 3] = Math.round((a / cnt) * 255);
  }
}

// --- 最小 PNG 编码 ---
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; // 位深
ihdr[9] = 6; // RGBA
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);

const out = path.resolve(import.meta.dirname, 'icon.png');
fs.writeFileSync(out, png);
console.log(`已生成 ${out}（${png.length} 字节）`);
