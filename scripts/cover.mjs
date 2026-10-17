// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark-to-teal gradient, a
// NAS box with its drive bays, and a dome camera with a motion arc.
// Plain Node (zlib), no dependency. Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const DARK = [12, 20, 34];
const TEAL = [0, 96, 120];
const BODY = [38, 44, 54];
const BAY = [70, 78, 92];
const WHITE = [240, 244, 248];
const LED = [70, 220, 120];
const ACCENT = [255, 170, 40];

/** Distance from a point to a rounded rectangle (negative inside). */
function roundedBox(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function pixel(x, y) {
  let color = mix(DARK, TEAL, (x / WIDTH) * 0.6 + (y / HEIGHT) * 0.4);
  // The NAS: a dark box with a light outline, four drive bays and LEDs.
  const box = roundedBox(x, y, 270, 280, 150, 175, 18);
  color = mix(color, WHITE, smooth(0, Math.abs(box) - 3));
  color = mix(color, BODY, smooth(0, box + 3));
  for (const [i, bx] of [165, 235, 305, 375].entries()) {
    const bay = roundedBox(x, y, bx, 300, 26, 120, 6);
    color = mix(color, BAY, smooth(0, bay));
    const led = Math.hypot(x - bx, y - 400);
    color = mix(color, i === 3 ? ACCENT : LED, smooth(5, led));
  }
  const power = Math.hypot(x - 270, y - 140);
  color = mix(color, WHITE, smooth(7, Math.abs(power - 12)) * 0.9);
  // The camera: a mount, a dome, a lens.
  const mount = roundedBox(x, y, 590, 170, 90, 16, 8);
  color = mix(color, WHITE, smooth(0, mount));
  const dome = Math.hypot(x - 590, y - 186);
  const lower = y > 186 ? 1 : 0;
  color = mix(color, WHITE, smooth(0, dome - 80) * lower);
  color = mix(color, BODY, smooth(0, Math.hypot(x - 590, y - 220) - 34));
  color = mix(color, TEAL, smooth(0, Math.hypot(x - 590, y - 220) - 16));
  // Motion arcs under the camera.
  const dx = x - 590;
  const dy = y - 220;
  const r = Math.hypot(dx, dy);
  const angle = Math.atan2(dx, dy);
  if (Math.abs(angle) < 0.6 && dy > 0) {
    for (const radius of [140, 185, 230]) {
      color = mix(color, ACCENT, smooth(5, Math.abs(r - radius)) * (1 - (radius - 140) / 200));
    }
  }
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
