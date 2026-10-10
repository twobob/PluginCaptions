import fs from "fs";
import path from "path";
import zlib from "zlib";
function createPNG(size) {
  const width = size;
  const height = size;
  const rawBytes = Buffer.alloc(height * (width * 4 + 1));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    rawBytes[offset++] = 0;
    for (let x = 0; x < width; x++) {
      const nx = x / width * 2 - 1;
      const ny = y / height * 2 - 1;
      const dist = Math.sqrt(nx * nx + ny * ny);
      const cornerR = 0.85;
      const inside = dist < cornerR;
      if (!inside) {
        rawBytes[offset++] = 0;
        rawBytes[offset++] = 0;
        rawBytes[offset++] = 0;
        rawBytes[offset++] = 0;
      } else {
        const t = (x + y) / (width + height);
        let r = Math.round(79 * (1 - t) + 14 * t);
        let g = Math.round(70 * (1 - t) + 165 * t);
        let b = Math.round(229 * (1 - t) + 233 * t);
        const isCaptionBox = x >= width * 0.2 && x <= width * 0.8 && y >= height * 0.35 && y <= height * 0.75;
        const isCaptionInner = x >= width * 0.28 && x <= width * 0.72 && y >= height * 0.42 && y <= height * 0.68;
        const isSubLine1 = x >= width * 0.34 && x <= width * 0.66 && y >= height * 0.48 && y <= height * 0.53;
        const isSubLine2 = x >= width * 0.34 && x <= width * 0.54 && y >= height * 0.58 && y <= height * 0.63;
        if (isSubLine1 || isSubLine2) {
          r = 255;
          g = 255;
          b = 255;
        } else if (isCaptionInner) {
          r = Math.round(r * 0.25);
          g = Math.round(g * 0.25);
          b = Math.round(b * 0.35);
        } else if (isCaptionBox) {
          r = 240;
          g = 245;
          b = 255;
        }
        const lx = width * 0.76;
        const ly = height * 0.24;
        const ldist = Math.hypot(x - lx, y - ly);
        if (ldist < width * 0.12) {
          r = 56;
          g = 239;
          b = 125;
        }
        rawBytes[offset++] = r;
        rawBytes[offset++] = g;
        rawBytes[offset++] = b;
        rawBytes[offset++] = 255;
      }
    }
  }
  const compressedData = zlib.deflateSync(rawBytes);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const ihdrChunk = createChunk("IHDR", ihdr);
  const idatChunk = createChunk("IDAT", compressedData);
  const iendChunk = createChunk("IEND", Buffer.alloc(0));
  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}
function createChunk(type, data) {
  const len = data.length;
  const chunk = Buffer.alloc(4 + 4 + len + 4);
  chunk.writeUInt32BE(len, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  const crcTarget = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = crc32(crcTarget);
  chunk.writeInt32BE(crc, 8 + len);
  return chunk;
}
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
  }
  crcTable[n] = c;
}
function crc32(buf) {
  let crc = 4294967295;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 255] ^ crc >>> 8;
  }
  return crc ^ 4294967295 | 0;
}
const sizes = [16, 32, 48, 128];
const iconDir = path.resolve("icons");
if (!fs.existsSync(iconDir)) fs.mkdirSync(iconDir, { recursive: true });
for (const s of sizes) {
  const png = createPNG(s);
  fs.writeFileSync(path.join(iconDir, `icon-${s}.png`), png);
  console.log(`Generated icon-${s}.png (${s}x${s})`);
}
