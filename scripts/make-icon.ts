// Renders the 1024×1024 source icon (§10.5 palette) that `tauri icon` expands into every platform size.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const size = 1024;
const bg = [0x1a, 0x1a, 0x2e];
const ring = [0x00, 0xd9, 0xff];
const eye = [0x00, 0xff, 0x88];
const raw = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) {
  raw[y * (size * 4 + 1)] = 0;
  for (let x = 0; x < size; x++) {
    const dx = x - size / 2;
    const dy = y - size / 2;
    const r = Math.hypot(dx, dy);
    const corner = Math.max(Math.abs(dx), Math.abs(dy)) > size / 2 - 1;
    const color = r < 120 ? eye : r > 300 && r < 380 ? ring : bg;
    const o = y * (size * 4 + 1) + 1 + x * 4;
    raw[o] = color[0]!;
    raw[o + 1] = color[1]!;
    raw[o + 2] = color[2]!;
    raw[o + 3] = corner ? 0 : 255;
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0);
ihdr.writeUInt32BE(size, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'icon.png', png);
