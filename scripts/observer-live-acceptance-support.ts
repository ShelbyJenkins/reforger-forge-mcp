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

export interface DecodedPngImage {
  width: number;
  height: number;
  channels: 3 | 4;
  sourceByteCount: number;
  sourceSha256: string;
  pixels: Buffer;
}

/** A resolution-independent region. Every value is expressed as a fraction of the image. */
export interface NormalizedImageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PngComparisonOptions {
  roi?: NormalizedImageRegion;
  /** A pixel is changed when any visible RGB channel exceeds this delta. */
  channelTolerance?: number;
  minimumChangedPixelRatio?: number;
  minimumMeanAbsoluteError?: number;
  maximumChangedPixelRatioForSimilarity?: number;
  maximumMeanAbsoluteErrorForSimilarity?: number;
}

export interface PngComparisonEvidence {
  width: number;
  height: number;
  pixelRegion: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  comparedPixels: number;
  changedPixels: number;
  changedPixelRatio: number;
  meanAbsoluteError: number;
  rootMeanSquareError: number;
  maximumChannelDifference: number;
  similarityScore: number;
  materiallyDifferent: boolean;
  materiallySimilar: boolean;
}

export type RgbColor = readonly [red: number, green: number, blue: number];

export interface ColorMarkerOptions {
  color: RgbColor;
  roi?: NormalizedImageRegion;
  channelTolerance?: number;
  minimumMatchingPixels?: number;
  minimumMatchRatio?: number;
  /** RGBA pixels below this alpha are not eligible to match. */
  minimumAlpha?: number;
}

export interface ColorMarkerEvidence {
  detected: boolean;
  inspectedPixels: number;
  matchingPixels: number;
  matchingPixelRatio: number;
  pixelBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  normalizedCentroid: readonly [x: number, y: number] | null;
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

export function decodePng(png: Buffer): DecodedPngImage {
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

  return {
    width,
    height,
    channels,
    sourceByteCount: png.length,
    sourceSha256: createHash("sha256").update(png).digest("hex"),
    pixels,
  };
}

export function analyzePngMaterial(png: Buffer): PngMaterialEvidence {
  const decoded = decodePng(png);
  const { width, height, channels, pixels } = decoded;

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
    byteCount: decoded.sourceByteCount,
    sha256: decoded.sourceSha256,
    sampledPixels,
    quantizedColorCount: colors.size,
    nonBlackRatio: Number(nonBlackRatio.toFixed(6)),
    luminanceMinimum: Number(luminanceMinimum.toFixed(3)),
    luminanceMaximum: Number(luminanceMaximum.toFixed(3)),
    luminanceStandardDeviation: Number(standardDeviation.toFixed(3)),
    materiallyVaried,
  };
}

interface PixelRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

function assertDecodedImage(image: DecodedPngImage, label: string): void {
  const pixelCount = image.width * image.height;
  if (!Number.isSafeInteger(pixelCount) || image.width < 1 || image.height < 1 || pixelCount > MAX_PNG_PIXELS) {
    throw new Error(`${label} dimensions are invalid: ${image.width}x${image.height}`);
  }
  if (image.channels !== 3 && image.channels !== 4) {
    throw new Error(`${label} must contain RGB or RGBA pixels`);
  }
  if (!Buffer.isBuffer(image.pixels) || image.pixels.length !== pixelCount * image.channels) {
    throw new Error(`${label} decoded pixel length is invalid`);
  }
}

function boundedNumber(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function pixelRegionFor(
  image: Pick<DecodedPngImage, "width" | "height">,
  roi: NormalizedImageRegion | undefined
): PixelRegion {
  if (!roi) return { x: 0, y: 0, width: image.width, height: image.height };
  const x = boundedNumber("ROI x", roi.x, 0, 1);
  const y = boundedNumber("ROI y", roi.y, 0, 1);
  const width = boundedNumber("ROI width", roi.width, Number.MIN_VALUE, 1);
  const height = boundedNumber("ROI height", roi.height, Number.MIN_VALUE, 1);
  if (x + width > 1 + 1e-12 || y + height > 1 + 1e-12) {
    throw new Error("ROI must fit within the normalized image bounds");
  }

  // The small epsilon prevents an exact normalized boundary such as 0.1 + 0.2
  // from including a neighboring pixel solely because of floating-point rounding.
  const left = Math.min(image.width - 1, Math.floor(x * image.width + 1e-9));
  const top = Math.min(image.height - 1, Math.floor(y * image.height + 1e-9));
  const right = Math.max(
    left + 1,
    Math.min(image.width, Math.ceil(Math.min(1, x + width) * image.width - 1e-9))
  );
  const bottom = Math.max(
    top + 1,
    Math.min(image.height, Math.ceil(Math.min(1, y + height) * image.height - 1e-9))
  );
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function visibleChannel(image: DecodedPngImage, pixelOffset: number, channel: 0 | 1 | 2): number {
  const value = image.pixels[pixelOffset + channel];
  if (image.channels === 3) return value;
  return Math.round(value * image.pixels[pixelOffset + 3] / 255);
}

/**
 * Compare decoded screenshots over the same normalized region.
 *
 * Similar and materially different intentionally use separate thresholds. A result can be
 * neither, which prevents small animation/rendering noise from being promoted to evidence of
 * a changed view while still allowing strict restoration checks.
 */
export function compareDecodedPng(
  reference: DecodedPngImage,
  candidate: DecodedPngImage,
  options: PngComparisonOptions = {}
): PngComparisonEvidence {
  assertDecodedImage(reference, "Reference image");
  assertDecodedImage(candidate, "Candidate image");
  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    throw new Error(
      `Screenshot dimensions differ: ${reference.width}x${reference.height} versus ` +
      `${candidate.width}x${candidate.height}`
    );
  }

  const channelTolerance = boundedNumber(
    "Comparison channel tolerance",
    options.channelTolerance ?? 8,
    0,
    255
  );
  const minimumChangedPixelRatio = boundedNumber(
    "Minimum changed-pixel ratio",
    options.minimumChangedPixelRatio ?? 0.02,
    0,
    1
  );
  const minimumMeanAbsoluteError = boundedNumber(
    "Minimum mean absolute error",
    options.minimumMeanAbsoluteError ?? 2,
    0,
    255
  );
  if (minimumChangedPixelRatio === 0 && minimumMeanAbsoluteError === 0) {
    throw new Error("Material-difference thresholds cannot both be zero");
  }
  const maximumChangedPixelRatioForSimilarity = boundedNumber(
    "Maximum changed-pixel ratio for similarity",
    options.maximumChangedPixelRatioForSimilarity ?? 0.01,
    0,
    1
  );
  const maximumMeanAbsoluteErrorForSimilarity = boundedNumber(
    "Maximum mean absolute error for similarity",
    options.maximumMeanAbsoluteErrorForSimilarity ?? 1,
    0,
    255
  );
  const pixelRegion = pixelRegionFor(reference, options.roi);

  let comparedPixels = 0;
  let changedPixels = 0;
  let absoluteDifference = 0;
  let squaredDifference = 0;
  let maximumChannelDifference = 0;
  for (let y = pixelRegion.y; y < pixelRegion.y + pixelRegion.height; y += 1) {
    for (let x = pixelRegion.x; x < pixelRegion.x + pixelRegion.width; x += 1) {
      const referenceOffset = (y * reference.width + x) * reference.channels;
      const candidateOffset = (y * candidate.width + x) * candidate.channels;
      let pixelMaximum = 0;
      for (let channel = 0 as 0 | 1 | 2; channel < 3; channel += 1) {
        const delta = Math.abs(
          visibleChannel(reference, referenceOffset, channel) -
          visibleChannel(candidate, candidateOffset, channel)
        );
        absoluteDifference += delta;
        squaredDifference += delta * delta;
        pixelMaximum = Math.max(pixelMaximum, delta);
        maximumChannelDifference = Math.max(maximumChannelDifference, delta);
      }
      comparedPixels += 1;
      if (pixelMaximum > channelTolerance) changedPixels += 1;
    }
  }

  const channelSamples = comparedPixels * 3;
  const changedPixelRatio = changedPixels / comparedPixels;
  const meanAbsoluteError = absoluteDifference / channelSamples;
  const rootMeanSquareError = Math.sqrt(squaredDifference / channelSamples);
  return {
    width: reference.width,
    height: reference.height,
    pixelRegion,
    comparedPixels,
    changedPixels,
    changedPixelRatio: Number(changedPixelRatio.toFixed(6)),
    meanAbsoluteError: Number(meanAbsoluteError.toFixed(6)),
    rootMeanSquareError: Number(rootMeanSquareError.toFixed(6)),
    maximumChannelDifference,
    similarityScore: Number(Math.max(0, 1 - rootMeanSquareError / 255).toFixed(6)),
    materiallyDifferent:
      changedPixelRatio >= minimumChangedPixelRatio && meanAbsoluteError >= minimumMeanAbsoluteError,
    materiallySimilar:
      changedPixelRatio <= maximumChangedPixelRatioForSimilarity &&
      meanAbsoluteError <= maximumMeanAbsoluteErrorForSimilarity,
  };
}

export function comparePngImages(
  reference: Buffer,
  candidate: Buffer,
  options: PngComparisonOptions = {}
): PngComparisonEvidence {
  return compareDecodedPng(decodePng(reference), decodePng(candidate), options);
}

export function detectColorMarker(
  image: DecodedPngImage,
  options: ColorMarkerOptions
): ColorMarkerEvidence {
  assertDecodedImage(image, "Marker image");
  if (!Array.isArray(options.color) || options.color.length !== 3) {
    throw new Error("Marker color must contain exactly three RGB channels");
  }
  const markerChannel = (channel: number, index: number): number => {
    if (!Number.isInteger(channel)) {
      throw new Error(`Marker color channel ${index} must be an integer`);
    }
    return boundedNumber(`Marker color channel ${index}`, channel, 0, 255);
  };
  const color: [number, number, number] = [
    markerChannel(options.color[0], 0),
    markerChannel(options.color[1], 1),
    markerChannel(options.color[2], 2),
  ];
  const channelTolerance = boundedNumber(
    "Marker channel tolerance",
    options.channelTolerance ?? 24,
    0,
    255
  );
  const minimumMatchingPixels = options.minimumMatchingPixels ?? 16;
  if (!Number.isSafeInteger(minimumMatchingPixels) || minimumMatchingPixels < 1) {
    throw new Error("Minimum matching marker pixels must be a positive safe integer");
  }
  const minimumMatchRatio = boundedNumber(
    "Minimum marker match ratio",
    options.minimumMatchRatio ?? 0.001,
    0,
    1
  );
  const minimumAlpha = boundedNumber("Minimum marker alpha", options.minimumAlpha ?? 128, 0, 255);
  const pixelRegion = pixelRegionFor(image, options.roi);

  let matchingPixels = 0;
  let sumX = 0;
  let sumY = 0;
  let minimumX = image.width;
  let minimumY = image.height;
  let maximumX = -1;
  let maximumY = -1;
  for (let y = pixelRegion.y; y < pixelRegion.y + pixelRegion.height; y += 1) {
    for (let x = pixelRegion.x; x < pixelRegion.x + pixelRegion.width; x += 1) {
      const offset = (y * image.width + x) * image.channels;
      const alpha = image.channels === 4 ? image.pixels[offset + 3] : 255;
      if (
        alpha >= minimumAlpha &&
        Math.abs(image.pixels[offset] - color[0]) <= channelTolerance &&
        Math.abs(image.pixels[offset + 1] - color[1]) <= channelTolerance &&
        Math.abs(image.pixels[offset + 2] - color[2]) <= channelTolerance
      ) {
        matchingPixels += 1;
        sumX += x;
        sumY += y;
        minimumX = Math.min(minimumX, x);
        minimumY = Math.min(minimumY, y);
        maximumX = Math.max(maximumX, x);
        maximumY = Math.max(maximumY, y);
      }
    }
  }

  const inspectedPixels = pixelRegion.width * pixelRegion.height;
  const matchingPixelRatio = matchingPixels / inspectedPixels;
  return {
    detected: matchingPixels >= minimumMatchingPixels && matchingPixelRatio >= minimumMatchRatio,
    inspectedPixels,
    matchingPixels,
    matchingPixelRatio: Number(matchingPixelRatio.toFixed(6)),
    pixelBounds: matchingPixels > 0
      ? {
          x: minimumX,
          y: minimumY,
          width: maximumX - minimumX + 1,
          height: maximumY - minimumY + 1,
        }
      : null,
    normalizedCentroid: matchingPixels > 0
      ? [
          Number(((sumX / matchingPixels + 0.5) / image.width).toFixed(6)),
          Number(((sumY / matchingPixels + 0.5) / image.height).toFixed(6)),
        ]
      : null,
  };
}

export function detectPngColorMarker(png: Buffer, options: ColorMarkerOptions): ColorMarkerEvidence {
  return detectColorMarker(decodePng(png), options);
}
