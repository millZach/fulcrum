import { zlibSync } from "fflate";

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1)
    crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const writeUint32 = (target: Uint8Array, offset: number, value: number) => {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
};

const chunk = (name: "IHDR" | "IDAT" | "IEND", data: Uint8Array) => {
  const type = new TextEncoder().encode(name);
  const output = new Uint8Array(12 + data.byteLength);
  writeUint32(output, 0, data.byteLength);
  output.set(type, 4);
  output.set(data, 8);
  writeUint32(
    output,
    8 + data.byteLength,
    crc32(output.subarray(4, 8 + data.byteLength)),
  );
  return output;
};

const concatenate = (parts: readonly Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(
    parts.reduce((sum, part) => sum + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
};

export const encodePngRgba = (
  width: number,
  height: number,
  rgba: Uint8Array,
): Uint8Array => {
  if (!Number.isInteger(width) || width <= 0)
    throw new Error("PNG width must be a positive integer.");
  if (!Number.isInteger(height) || height <= 0)
    throw new Error("PNG height must be a positive integer.");
  if (rgba.byteLength !== width * height * 4)
    throw new Error("RGBA byte length does not match PNG dimensions.");

  const ihdr = new Uint8Array(13);
  writeUint32(ihdr, 0, width);
  writeUint32(ihdr, 4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const scanlines = new Uint8Array(height * (stride + 1));
  for (let row = 0; row < height; row += 1) {
    const outputOffset = row * (stride + 1);
    scanlines[outputOffset] = 0;
    scanlines.set(
      rgba.subarray(row * stride, (row + 1) * stride),
      outputOffset + 1,
    );
  }

  return concatenate([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibSync(scanlines, { level: 6 })),
    chunk("IEND", new Uint8Array()),
  ]);
};
