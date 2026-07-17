import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  analyzePngMaterial,
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

function rgbPng(varied: boolean): Buffer {
  const width = 64;
  const height = 64;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    rows[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 3;
      if (varied) {
        rows[pixel] = (x * 4) & 0xff;
        rows[pixel + 1] = (y * 4) & 0xff;
        rows[pixel + 2] = ((x + y) * 2) & 0xff;
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
});
