import { deflateSync, inflateSync } from "node:zlib";
import { DEFAULT_LIMITS } from "../protocol/index.js";
import { ObserverError } from "./errors.js";

export interface ImageInfo {
  width: number;
  height: number;
  mimeType: "image/png";
  sourceFormat: "bmp24" | "bmp32" | "png";
}

export interface ValidatedImage extends ImageInfo {
  png: Buffer;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const DEFAULT_MAX_PIXELS = 32_000_000;
const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[index] = value >>> 0;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

function dimensions(width: number, height: number, maxWidth: number, maxHeight: number, maxPixels: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > maxWidth || height > maxHeight) {
    throw new ObserverError("ARTIFACT_INVALID", `Image dimensions are outside supported bounds: ${width}x${height}`);
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > maxPixels) {
    throw new ObserverError("ARTIFACT_TOO_LARGE", "Image decoded pixel count exceeds the configured limit");
  }
}

export function convertBmpToPng(
  bmp: Buffer,
  options: { maxWidth?: number; maxHeight?: number; maxPixels?: number; maxBytes?: number } = {}
): ValidatedImage {
  const maxWidth = options.maxWidth ?? DEFAULT_LIMITS.maxArtifactWidth;
  const maxHeight = options.maxHeight ?? DEFAULT_LIMITS.maxArtifactHeight;
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;
  const maxBytes = options.maxBytes ?? DEFAULT_LIMITS.maxArtifactBytes;
  if (bmp.length > maxBytes) throw new ObserverError("ARTIFACT_TOO_LARGE", "BMP exceeds the configured byte limit");
  if (bmp.length < 54 || bmp[0] !== 0x42 || bmp[1] !== 0x4d) throw new ObserverError("ARTIFACT_INVALID", "BMP signature or header is invalid");
  const declaredSize = bmp.readUInt32LE(2);
  const pixelOffset = bmp.readUInt32LE(10);
  const dibSize = bmp.readUInt32LE(14);
  const width = bmp.readInt32LE(18);
  const signedHeight = bmp.readInt32LE(22);
  const height = Math.abs(signedHeight);
  const planes = bmp.readUInt16LE(26);
  const bitsPerPixel = bmp.readUInt16LE(28);
  const compression = bmp.readUInt32LE(30);
  dimensions(width, height, maxWidth, maxHeight, maxPixels);
  if (declaredSize !== bmp.length) throw new ObserverError("ARTIFACT_INVALID", "BMP declared length does not match the file length");
  if (dibSize < 40 || pixelOffset < 14 + dibSize || pixelOffset > bmp.length) throw new ObserverError("ARTIFACT_INVALID", "BMP DIB header or pixel offset is invalid");
  if (planes !== 1 || (bitsPerPixel !== 24 && bitsPerPixel !== 32) || compression !== 0) {
    throw new ObserverError("ARTIFACT_INVALID", "Only uncompressed 24-bit and 32-bit BMP files are supported");
  }
  const bytesPerPixel = bitsPerPixel / 8;
  const rowStride = Math.floor((bitsPerPixel * width + 31) / 32) * 4;
  const pixelLength = rowStride * height;
  if (!Number.isSafeInteger(pixelLength) || pixelOffset + pixelLength !== bmp.length) {
    throw new ObserverError("ARTIFACT_INVALID", "BMP row stride or total pixel length is invalid");
  }
  const colorChannels = bitsPerPixel === 32 ? 4 : 3;
  const scanlineLength = 1 + width * colorChannels;
  const raw = Buffer.alloc(scanlineLength * height);
  for (let outputY = 0; outputY < height; outputY += 1) {
    const sourceY = signedHeight > 0 ? height - 1 - outputY : outputY;
    const sourceRow = pixelOffset + sourceY * rowStride;
    const outputRow = outputY * scanlineLength;
    raw[outputRow] = 0;
    for (let x = 0; x < width; x += 1) {
      const source = sourceRow + x * bytesPerPixel;
      const output = outputRow + 1 + x * colorChannels;
      raw[output] = bmp[source + 2];
      raw[output + 1] = bmp[source + 1];
      raw[output + 2] = bmp[source];
      if (colorChannels === 4) raw[output + 3] = bmp[source + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorChannels === 4 ? 6 : 2;
  const png = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return { png, width, height, mimeType: "image/png", sourceFormat: bitsPerPixel === 32 ? "bmp32" : "bmp24" };
}

export function validatePng(
  png: Buffer,
  options: { maxWidth?: number; maxHeight?: number; maxPixels?: number; maxBytes?: number } = {}
): ValidatedImage {
  const maxWidth = options.maxWidth ?? DEFAULT_LIMITS.maxArtifactWidth;
  const maxHeight = options.maxHeight ?? DEFAULT_LIMITS.maxArtifactHeight;
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;
  const maxBytes = options.maxBytes ?? DEFAULT_LIMITS.maxArtifactBytes;
  if (png.length > maxBytes) throw new ObserverError("ARTIFACT_TOO_LARGE", "PNG exceeds the configured byte limit");
  if (png.length < 45 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new ObserverError("ARTIFACT_INVALID", "PNG signature is invalid");
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;
  let dataEnded = false;
  let colorChannels = 0;
  const compressed: Buffer[] = [];
  while (offset < png.length) {
    if (offset + 12 > png.length) throw new ObserverError("ARTIFACT_INVALID", "PNG chunk header is truncated");
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > png.length) throw new ObserverError("ARTIFACT_INVALID", "PNG chunk exceeds file bounds");
    const body = png.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = png.readUInt32BE(offset + 8 + length);
    if (crc32(Buffer.concat([Buffer.from(type, "ascii"), body])) !== expectedCrc) throw new ObserverError("ARTIFACT_INVALID", `PNG ${type} CRC is invalid`);
    if (type === "IHDR") {
      if (sawHeader || offset !== 8 || length !== 13) throw new ObserverError("ARTIFACT_INVALID", "PNG IHDR placement is invalid");
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      dimensions(width, height, maxWidth, maxHeight, maxPixels);
      if (body[8] !== 8 || ![2, 6].includes(body[9]) || body[10] !== 0 || body[11] !== 0 || body[12] !== 0) {
        throw new ObserverError("ARTIFACT_INVALID", "PNG encoding is outside the supported RGB/RGBA non-interlaced subset");
      }
      colorChannels = body[9] === 6 ? 4 : 3;
      sawHeader = true;
    } else if (type === "IDAT") {
      if (!sawHeader || dataEnded) throw new ObserverError("ARTIFACT_INVALID", "PNG IDAT placement is invalid");
      sawData = true;
      compressed.push(body);
    }
    else if (type === "IEND") {
      if (length !== 0 || end !== png.length) throw new ObserverError("ARTIFACT_INVALID", "PNG IEND or trailing data is invalid");
      sawEnd = true;
    } else {
      if (sawData) dataEnded = true;
      if (/^[A-Z]/.test(type)) throw new ObserverError("ARTIFACT_INVALID", `PNG critical chunk ${type} is outside the supported subset`);
    }
    offset = end;
  }
  if (!sawHeader || !sawData || !sawEnd) throw new ObserverError("ARTIFACT_INVALID", "PNG is missing required chunks");
  const expectedDecodedBytes = height * (1 + width * colorChannels);
  if (!Number.isSafeInteger(expectedDecodedBytes)) throw new ObserverError("ARTIFACT_TOO_LARGE", "PNG decoded size exceeds the configured limit");
  let decoded: Buffer;
  try {
    decoded = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedDecodedBytes + 1 });
  } catch {
    throw new ObserverError("ARTIFACT_INVALID", "PNG compressed image data is invalid or exceeds its decoded budget");
  }
  if (decoded.length !== expectedDecodedBytes) throw new ObserverError("ARTIFACT_INVALID", "PNG decoded image length is invalid");
  const rowLength = 1 + width * colorChannels;
  for (let row = 0; row < height; row += 1) {
    if (decoded[row * rowLength] > 4) throw new ObserverError("ARTIFACT_INVALID", "PNG scanline uses an invalid filter type");
  }
  return { png, width, height, mimeType: "image/png", sourceFormat: "png" };
}

export function validateOrConvertImage(data: Buffer, extension: string, options: { maxWidth?: number; maxHeight?: number; maxPixels?: number; maxBytes?: number } = {}): ValidatedImage {
  if (extension.toLowerCase() === ".bmp") return convertBmpToPng(data, options);
  if (extension.toLowerCase() === ".png") return validatePng(data, options);
  throw new ObserverError("ARTIFACT_INVALID", "Observer screenshot extension is not supported");
}
