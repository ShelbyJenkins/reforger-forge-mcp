import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_BYTES = 64 * 1024 * 1024;
const MAX_PNG_PIXELS = 32_000_000;

const BLOCKING_PROCESS_NAMES = new Set([
  "armareforger",
  "armareforgerdiag",
  "armareforgersteam",
  "armareforgersteamdiag",
  "armareforgerserver",
  "armareforgerserverdiag",
  "armareforgerserversteam",
  "armareforgerserversteamdiag",
  "armareforgerworkbench",
  "armareforgerworkbenchdiag",
  "armareforgerworkbenchsteam",
  "armareforgerworkbenchsteamdiag",
]);

export interface PngMaterialEvidence {
  width: number;
  height: number;
  channels: 3 | 4;
  byteCount: number;
  sha256: string;
  sampledPixels: number;
  quantizedColorCount: number;
  nonBlackRatio: number;
  luminanceMinimum: number;
  luminanceMaximum: number;
  luminanceStandardDeviation: number;
  materiallyVaried: boolean;
}

export interface ProcessRow {
  Id?: unknown;
  ProcessName?: unknown;
}

export interface BlockingProcess {
  id: number;
  processName: string;
}

export function findBlockingProcesses(rows: ProcessRow[]): BlockingProcess[] {
  return rows.flatMap((row) => {
    const processName = typeof row.ProcessName === "string" ? row.ProcessName : "";
    const id = typeof row.Id === "number" ? row.Id : Number(row.Id);
    return BLOCKING_PROCESS_NAMES.has(processName.toLowerCase()) && Number.isSafeInteger(id) && id > 0
      ? [{ id, processName }]
      : [];
  }).sort((left, right) => left.id - right.id);
}

export function inspectBlockingProcesses(): BlockingProcess[] {
  if (process.platform !== "win32") {
    throw new Error("Live Arma Reforger process inspection is Windows-only");
  }
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$items = @(Get-Process -ErrorAction Stop | Select-Object -Property Id,ProcessName)",
    "[Console]::Out.Write((ConvertTo-Json -InputObject $items -Compress))",
  ].join("; ");
  const inspection = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    }
  );
  if (inspection.error || inspection.status !== 0) {
    throw new Error(
      "Cannot prove that Arma Reforger and Workbench are absent; process inspection failed. No application was launched."
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspection.stdout || "[]");
  } catch {
    throw new Error(
      "Cannot prove that Arma Reforger and Workbench are absent; process inspection returned invalid data. No application was launched."
    );
  }
  return findBlockingProcesses(Array.isArray(parsed) ? parsed : [parsed]);
}

function crcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = crcTable();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left: number, above: number, upperLeft: number): number {
  const candidate = left + above - upperLeft;
  const leftDistance = Math.abs(candidate - left);
  const aboveDistance = Math.abs(candidate - above);
  const diagonalDistance = Math.abs(candidate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= diagonalDistance) return left;
  return aboveDistance <= diagonalDistance ? above : upperLeft;
}

export function analyzePngMaterial(png: Buffer): PngMaterialEvidence {
  if (png.length < 45 || png.length > MAX_PNG_BYTES || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Retained capture is not a bounded PNG");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels: 3 | 4 | 0 = 0;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;
  let dataEnded = false;
  const compressed: Buffer[] = [];
  while (offset < png.length) {
    if (offset + 12 > png.length) throw new Error("PNG chunk header is truncated");
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > png.length) throw new Error("PNG chunk exceeds file bounds");
    const body = png.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = png.readUInt32BE(offset + 8 + length);
    const crcInput = Buffer.concat([Buffer.from(type, "ascii"), body]);
    if (crc32(crcInput) !== expectedCrc) throw new Error(`PNG ${type} CRC is invalid`);
    if (type === "IHDR") {
      if (sawHeader || offset !== 8 || length !== 13) throw new Error("PNG IHDR placement is invalid");
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const pixels = width * height;
      if (!Number.isSafeInteger(pixels) || width < 64 || height < 64 || pixels > MAX_PNG_PIXELS) {
        throw new Error(`PNG dimensions are outside the live screenshot bounds: ${width}x${height}`);
      }
      if (body[8] !== 8 || ![2, 6].includes(body[9]) || body[10] !== 0 || body[11] !== 0 || body[12] !== 0) {
        throw new Error("PNG encoding is outside the supported RGB/RGBA non-interlaced subset");
      }
      channels = body[9] === 6 ? 4 : 3;
      sawHeader = true;
    } else if (type === "IDAT") {
      if (!sawHeader || dataEnded) throw new Error("PNG IDAT placement is invalid");
      sawData = true;
      compressed.push(body);
    } else if (type === "IEND") {
      if (length !== 0 || end !== png.length) throw new Error("PNG IEND or trailing data is invalid");
      sawEnd = true;
    } else {
      if (sawData) dataEnded = true;
      if (/^[A-Z]/.test(type)) throw new Error(`Unexpected critical PNG chunk ${type}`);
    }
    offset = end;
  }
  if (!sawHeader || !sawData || !sawEnd || channels === 0) {
    throw new Error("PNG is missing required chunks");
  }

  const stride = width * channels;
  const expectedDecoded = height * (stride + 1);
  let filtered: Buffer;
  try {
    filtered = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedDecoded + 1 });
  } catch {
    throw new Error("PNG compressed image data is invalid or exceeds its decoded budget");
  }
  if (filtered.length !== expectedDecoded) throw new Error("PNG decoded image length is invalid");
  const pixels = Buffer.allocUnsafe(width * height * channels);
  for (let row = 0; row < height; row += 1) {
    const filterOffset = row * (stride + 1);
    const filter = filtered[filterOffset];
    if (filter > 4) throw new Error(`PNG row ${row} uses invalid filter ${filter}`);
    const outputOffset = row * stride;
    for (let column = 0; column < stride; column += 1) {
      const raw = filtered[filterOffset + 1 + column];
      const left = column >= channels ? pixels[outputOffset + column - channels] : 0;
      const above = row > 0 ? pixels[outputOffset + column - stride] : 0;
      const upperLeft = row > 0 && column >= channels
        ? pixels[outputOffset + column - stride - channels]
        : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = Math.floor((left + above) / 2);
      else if (filter === 4) predictor = paeth(left, above, upperLeft);
      pixels[outputOffset + column] = (raw + predictor) & 0xff;
    }
  }

  const pixelCount = width * height;
  const sampleStep = Math.max(1, Math.floor(pixelCount / 100_000));
  const colors = new Set<number>();
  let sampledPixels = 0;
  let nonBlack = 0;
  let luminanceMinimum = 255;
  let luminanceMaximum = 0;
  let luminanceMean = 0;
  let luminanceM2 = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += sampleStep) {
    const pixelOffset = pixel * channels;
    const red = pixels[pixelOffset];
    const green = pixels[pixelOffset + 1];
    const blue = pixels[pixelOffset + 2];
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    sampledPixels += 1;
    if (Math.max(red, green, blue) > 8) nonBlack += 1;
    luminanceMinimum = Math.min(luminanceMinimum, luminance);
    luminanceMaximum = Math.max(luminanceMaximum, luminance);
    const delta = luminance - luminanceMean;
    luminanceMean += delta / sampledPixels;
    luminanceM2 += delta * (luminance - luminanceMean);
    if (colors.size < 4_096) {
      colors.add(((red >> 3) << 10) | ((green >> 3) << 5) | (blue >> 3));
    }
  }
  const standardDeviation = Math.sqrt(luminanceM2 / Math.max(1, sampledPixels - 1));
  const nonBlackRatio = nonBlack / sampledPixels;
  const materiallyVaried = sampledPixels >= 1_000 && colors.size >= 16 && nonBlackRatio >= 0.01 &&
    luminanceMaximum - luminanceMinimum >= 10 && standardDeviation >= 2.5;
  return {
    width,
    height,
    channels,
    byteCount: png.length,
    sha256: createHash("sha256").update(png).digest("hex"),
    sampledPixels,
    quantizedColorCount: colors.size,
    nonBlackRatio: Number(nonBlackRatio.toFixed(6)),
    luminanceMinimum: Number(luminanceMinimum.toFixed(3)),
    luminanceMaximum: Number(luminanceMaximum.toFixed(3)),
    luminanceStandardDeviation: Number(standardDeviation.toFixed(3)),
    materiallyVaried,
  };
}
