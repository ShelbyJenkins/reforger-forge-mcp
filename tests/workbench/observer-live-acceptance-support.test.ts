import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  analyzePngMaterial,
  compareDecodedPng,
  comparePngImages,
  decodePng,
  detectColorMarker,
  detectPngColorMarker,
  findBlockingProcesses,
} from "../../scripts/observer-live-acceptance-support.js";

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

function pngChunk(type: string, body: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + body.length);
  result.writeUInt32BE(body.length, 0);
  typeBytes.copy(result, 4);
  body.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, body])), 8 + body.length);
  return result;
}

function pixelPng(
  width: number,
  height: number,
  channels: 3 | 4,
  pixelAt: (x: number, y: number) => readonly number[]
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  const rows = Buffer.alloc(height * (1 + width * channels));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * channels);
    rows[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * channels;
      const values = pixelAt(x, y);
      for (let channel = 0; channel < channels; channel += 1) {
        rows[pixel + channel] = values[channel] ?? (channel === 3 ? 255 : 0);
      }
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function rgbPng(varied: boolean): Buffer {
  return pixelPng(64, 64, 3, (x, y) => varied
    ? [(x * 4) & 0xff, (y * 4) & 0xff, ((x + y) * 2) & 0xff]
    : [0, 0, 0]);
}

function gradientPixel(x: number, y: number): readonly [number, number, number] {
  return [(x * 3) & 0xff, (y * 3) & 0xff, ((x + y) * 2) & 0xff];
}

describe("live observer acceptance support", () => {
  it("filters and sorts only relevant engine/editor processes", () => {
    expect(findBlockingProcesses([
      { Id: "52", ProcessName: "ArmaReforgerWorkbench" },
      { Id: 8, ProcessName: "node" },
      { Id: 11, ProcessName: "ArmaReforgerSteamDiag" },
      { Id: -1, ProcessName: "ArmaReforger" },
    ])).toEqual([
      { id: 11, processName: "ArmaReforgerSteamDiag" },
      { id: 52, processName: "ArmaReforgerWorkbench" },
    ]);
  });

  it("independently validates screenshot structure and material variation", () => {
    const blank = analyzePngMaterial(rgbPng(false));
    expect(blank).toMatchObject({
      width: 64,
      height: 64,
      channels: 3,
      materiallyVaried: false,
      quantizedColorCount: 1,
    });

    const variedPng = rgbPng(true);
    const varied = analyzePngMaterial(variedPng);
    expect(varied.materiallyVaried).toBe(true);
    expect(varied.sha256).toBe(createHash("sha256").update(variedPng).digest("hex"));
    expect(varied.quantizedColorCount).toBeGreaterThanOrEqual(16);
  });

  it("rejects a PNG whose chunk CRC is corrupted", () => {
    const corrupted = Buffer.from(rgbPng(true));
    corrupted[corrupted.length - 5] ^= 0xff;
    expect(() => analyzePngMaterial(corrupted)).toThrow(/CRC is invalid/);
  });

  it("decodes screenshot pixels once for shared acceptance oracles", () => {
    const png = pixelPng(64, 64, 4, (x, y) => [x, y, x + y, 200]);
    const decoded = decodePng(png);
    expect(decoded).toMatchObject({
      width: 64,
      height: 64,
      channels: 4,
      sourceByteCount: png.length,
      sourceSha256: createHash("sha256").update(png).digest("hex"),
    });
    expect([...decoded.pixels.subarray(0, 8)]).toEqual([0, 0, 0, 200, 1, 0, 1, 200]);
  });

  it("distinguishes similar, materially changed, and out-of-ROI screenshots", () => {
    const baseline = pixelPng(64, 64, 3, gradientPixel);
    const quietNoise = pixelPng(64, 64, 3, (x, y) => gradientPixel(x, y).map(
      (channel) => Math.min(255, channel + 1)
    ));
    const displaced = pixelPng(64, 64, 3, (x, y) =>
      x >= 16 && x < 48 && y >= 16 && y < 48 ? [255, 0, 0] : gradientPixel(x, y)
    );

    expect(comparePngImages(baseline, quietNoise)).toMatchObject({
      materiallyDifferent: false,
      materiallySimilar: true,
      changedPixels: 0,
    });

    const fullFrame = comparePngImages(baseline, displaced);
    expect(fullFrame.materiallyDifferent).toBe(true);
    expect(fullFrame.materiallySimilar).toBe(false);
    expect(fullFrame.changedPixelRatio).toBeGreaterThan(0.24);
    expect(fullFrame.maximumChannelDifference).toBeGreaterThan(200);

    const unchangedLeftEdge = comparePngImages(baseline, displaced, {
      roi: { x: 0, y: 0, width: 0.25, height: 1 },
    });
    expect(unchangedLeftEdge).toMatchObject({
      comparedPixels: 1_024,
      changedPixels: 0,
      materiallyDifferent: false,
      materiallySimilar: true,
    });

    const changedCenter = compareDecodedPng(decodePng(baseline), decodePng(displaced), {
      roi: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    });
    expect(changedCenter.pixelRegion).toEqual({ x: 16, y: 16, width: 32, height: 32 });
    expect(changedCenter.materiallyDifferent).toBe(true);
    expect(changedCenter.changedPixelRatio).toBeGreaterThan(0.99);
  });

  it("rejects comparisons with incompatible dimensions or invalid normalized regions", () => {
    const square = decodePng(pixelPng(64, 64, 3, gradientPixel));
    const wide = decodePng(pixelPng(65, 64, 3, gradientPixel));
    expect(() => compareDecodedPng(square, wide)).toThrow(/dimensions differ/);
    expect(() => compareDecodedPng(square, square, {
      roi: { x: 0.8, y: 0, width: 0.3, height: 1 },
    })).toThrow(/fit within/);
  });

  it("detects a tolerant color marker only inside the requested ROI", () => {
    const png = pixelPng(64, 64, 4, (x, y) => {
      if (x >= 40 && x < 48 && y >= 8 && y < 16) return [250, 5, 5, 255];
      // A transparent target-colored block must not satisfy the marker oracle.
      if (x >= 8 && x < 16 && y >= 8 && y < 16) return [250, 5, 5, 0];
      return [10, 20, 30, 255];
    });
    const screenshot = decodePng(png);

    const marker = detectPngColorMarker(png, {
      color: [245, 10, 10],
      channelTolerance: 6,
      minimumMatchingPixels: 32,
      minimumMatchRatio: 0.01,
      roi: { x: 0.5, y: 0, width: 0.5, height: 0.5 },
    });
    expect(marker).toEqual({
      detected: true,
      inspectedPixels: 1_024,
      matchingPixels: 64,
      matchingPixelRatio: 0.0625,
      pixelBounds: { x: 40, y: 8, width: 8, height: 8 },
      normalizedCentroid: [0.6875, 0.1875],
    });

    expect(detectColorMarker(screenshot, {
      color: [245, 10, 10],
      channelTolerance: 6,
      roi: { x: 0, y: 0, width: 0.5, height: 0.5 },
    })).toMatchObject({
      detected: false,
      matchingPixels: 0,
      pixelBounds: null,
      normalizedCentroid: null,
    });
  });
});
