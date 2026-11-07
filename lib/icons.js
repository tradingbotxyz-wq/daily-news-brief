// Draws the app icon (a newspaper on a rounded tile) and encodes it as PNG with Node's zlib.
const zlib = require('zlib');

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
// Shapes in a 512x512 design space: [x, y, w, h, radius, color]
const SHAPES = [
  [120, 128, 272, 256, 28, '#f6f4ef'],
  [152, 164, 208, 34, 8, '#1c1b19'],
  [152, 222, 96, 88, 8, '#e0714a'],
  [268, 222, 92, 14, 7, '#6b675f'],
  [268, 250, 92, 14, 7, '#6b675f'],
  [268, 278, 72, 14, 7, '#6b675f'],
  [152, 330, 208, 14, 7, '#6b675f'],
];

function inRoundRect(px, py, x, y, w, h, r) {
  if (px < x || py < y || px >= x + w || py >= y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

function draw(size, maskable) {
  const scale = maskable ? 0.78 : 1;          // maskable icons keep content in the safe zone
  const off = (512 - 512 * scale) / 2;
  const bg = hex('#b4441f');
  const px = Buffer.alloc(size * size * 4);
  const SS = 2;                                // 2x2 supersampling for smooth edges
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const X = ((i + (sx + 0.5) / SS) / size) * 512;
        const Y = ((j + (sy + 0.5) / SS) / size) * 512;
        let col = null;
        if (maskable || inRoundRect(X, Y, 0, 0, 512, 512, 112)) col = bg;
        const u = (X - off) / scale, v = (Y - off) / scale;
        for (const [x, y, w, h, rad, c] of SHAPES) if (inRoundRect(u, v, x, y, w, h, rad)) col = hex(c);
        if (col) { r += col[0]; g += col[1]; b += col[2]; a += 255; }
      }
      const n = SS * SS, k = (j * size + i) * 4, cov = a / n;
      if (cov) { px[k] = r / (a / 255); px[k + 1] = g / (a / 255); px[k + 2] = b / (a / 255); }
      px[k + 3] = cov;
    }
  }
  return png(size, size, px);
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const ICONS = { 'icon-192.png': [192, false], 'icon-512.png': [512, false], 'icon-512-maskable.png': [512, true] };
module.exports = { ICONS, draw };
