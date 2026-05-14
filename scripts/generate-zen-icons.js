const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.resolve(__dirname, '..');

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = crcTable[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const typeBuffer = Buffer.from(type);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBuffer.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return out;
};

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const mix = (a, b, t) => Math.round(a + (b - a) * t);
const smooth = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

const blend = (pixel, color, alpha) => {
  const a = clamp(alpha);
  pixel[0] = mix(pixel[0], color[0], a);
  pixel[1] = mix(pixel[1], color[1], a);
  pixel[2] = mix(pixel[2], color[2], a);
  pixel[3] = Math.round(255 * (a + (pixel[3] / 255) * (1 - a)));
};

const rotatedEllipseAlpha = (u, v, cx, cy, rx, ry, rotation, edge = 0.04) => {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const dx = u - cx;
  const dy = v - cy;
  const x = dx * cos + dy * sin;
  const y = -dx * sin + dy * cos;
  const d = Math.sqrt((x / rx) ** 2 + (y / ry) ** 2);
  return 1 - smooth(1 - edge, 1 + edge, d);
};

const drawLotusMark = (pixel, u, v, color, scale = 1) => {
  const center = rotatedEllipseAlpha(u, v, 0.5, 0.45, 0.055 * scale, 0.13 * scale, 0);
  const left = rotatedEllipseAlpha(u, v, 0.43, 0.54, 0.052 * scale, 0.14 * scale, -0.75);
  const right = rotatedEllipseAlpha(u, v, 0.57, 0.54, 0.052 * scale, 0.14 * scale, 0.75);
  const base = rotatedEllipseAlpha(u, v, 0.5, 0.63, 0.17 * scale, 0.045 * scale, 0, 0.08);
  const glow = rotatedEllipseAlpha(u, v, 0.5, 0.54, 0.25 * scale, 0.25 * scale, 0, 0.12);

  blend(pixel, color, glow * 0.06);
  blend(pixel, color, base * 0.92);
  blend(pixel, color, left * 0.96);
  blend(pixel, color, right * 0.96);
  blend(pixel, color, center * 0.98);
};

const drawBeads = (pixel, u, v, color, scale = 1) => {
  const radius = 0.285 * scale;
  const beadRadius = 0.016 * scale;
  let alpha = 0;

  for (let i = 0; i < 22; i += 1) {
    const angle = (-Math.PI / 2) + (i / 22) * Math.PI * 2;
    const bx = 0.5 + Math.cos(angle) * radius;
    const by = 0.52 + Math.sin(angle) * radius;
    const distance = Math.hypot(u - bx, v - by);
    alpha = Math.max(alpha, 1 - smooth(beadRadius * 0.72, beadRadius * 1.18, distance));
  }

  blend(pixel, color, alpha * 0.98);
};

const drawIconPixel = (u, v, options = {}) => {
  const transparent = options.transparent || false;
  const symbolOnly = options.symbolOnly || false;
  const monochrome = options.monochrome || false;
  const pixel = transparent ? [255, 255, 255, 0] : [225, 241, 237, 255];

  if (!symbolOnly) {
    const top = [36, 144, 134];
    const bottom = [210, 232, 225];
    const side = [119, 179, 162];
    const vertical = v;
    const horizontal = u * 0.2;
    pixel[0] = mix(mix(top[0], bottom[0], vertical), side[0], horizontal);
    pixel[1] = mix(mix(top[1], bottom[1], vertical), side[1], horizontal);
    pixel[2] = mix(mix(top[2], bottom[2], vertical), side[2], horizontal);
    pixel[3] = 255;

    const centerGlow = 1 - smooth(0.05, 0.58, Math.hypot(u - 0.5, v - 0.5));
    blend(pixel, [255, 255, 255], centerGlow * 0.18);

    const innerCircle = 1 - smooth(0.345, 0.365, Math.hypot(u - 0.5, v - 0.52));
    blend(pixel, [255, 255, 255], innerCircle * 0.1);

    const vignette = smooth(0.44, 0.72, Math.hypot(u - 0.5, v - 0.5));
    blend(pixel, [5, 59, 59], vignette * 0.15);
  }

  const markColor = monochrome ? [255, 255, 255] : [250, 255, 253];
  const scale = symbolOnly ? 0.9 : 1;
  drawBeads(pixel, u, v, markColor, scale);
  drawLotusMark(pixel, u, v, markColor, scale);

  return pixel;
};

const drawBackgroundPixel = (u, v) => {
  const top = [47, 141, 133];
  const bottom = [214, 236, 230];
  return [mix(top[0], bottom[0], v), mix(top[1], bottom[1], v), mix(top[2], bottom[2], v), 255];
};

const writePng = (file, width, height, draw) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = Buffer.alloc((width * 4 + 1) * height);

  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = draw((x + 0.5) / width, (y + 0.5) / height);
      const offset = row + 1 + x * 4;
      raw[offset] = pixel[0];
      raw[offset + 1] = pixel[1];
      raw[offset + 2] = pixel[2];
      raw[offset + 3] = pixel[3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  fs.writeFileSync(file, png);
};

const publicIcons = [
  ['public/icon.png', 1024],
  ['public/icon-512.png', 512],
  ['public/icon-192.png', 192],
  ['public/maskable-icon-512.png', 512],
  ['public/apple-touch-icon.png', 180],
  ['public/favicon-48.png', 48],
  ['public/icon-v2-1024.png', 1024],
  ['public/icon-v2-512.png', 512],
  ['public/icon-v2-192.png', 192],
  ['public/icon-safe-1024.png', 1024],
  ['public/icon-safe-512.png', 512],
  ['public/icon-safe-192.png', 192],
  ['public/icon-male-1024.png', 1024],
  ['public/icon-male-512.png', 512],
  ['public/icon-male-192.png', 192],
  ['public/apple-touch-icon-v2.png', 180],
  ['public/apple-touch-icon-safe.png', 180],
  ['public/apple-touch-icon-male.png', 180],
  ['public/favicon-v2-48.png', 48],
  ['public/favicon-safe-48.png', 48],
  ['public/favicon-male-48.png', 48],
];

for (const [target, size] of publicIcons) {
  writePng(path.join(root, target), size, size, (u, v) => drawIconPixel(u, v));
}

writePng(path.join(root, 'assets/images/icon.png'), 1024, 1024, (u, v) => drawIconPixel(u, v));
writePng(path.join(root, 'assets/images/splash-icon.png'), 1024, 1024, (u, v) => drawIconPixel(u, v));
writePng(path.join(root, 'assets/images/favicon.png'), 48, 48, (u, v) => drawIconPixel(u, v));
writePng(path.join(root, 'assets/images/android-icon-background.png'), 1024, 1024, drawBackgroundPixel);
writePng(path.join(root, 'assets/images/android-icon-foreground.png'), 1024, 1024, (u, v) =>
  drawIconPixel(u, v, { transparent: true, symbolOnly: true })
);
writePng(path.join(root, 'assets/images/android-icon-monochrome.png'), 1024, 1024, (u, v) =>
  drawIconPixel(u, v, { transparent: true, symbolOnly: true, monochrome: true })
);

console.log('Generated zen PWA and native icon assets.');
