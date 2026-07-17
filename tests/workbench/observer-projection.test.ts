import { describe, expect, it } from "vitest";

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const FOV_EPSILON_DEGREES = 0.01;
const FOV_SYMMETRY_EPSILON_DEGREES = 0.05;

type Direction = [number, number, number];

function directionAtPixel(
  y: number,
  height: number,
  fovDegrees: number,
  principalOffsetPixels = 0
): Direction {
  // ProjectViewportToWorld samples integer pixels. Positive fractional screen
  // coordinates truncate before projection, as recorded by the 1194x632 live
  // RoadblockRunners failure.
  const pixelY = Math.trunc(y);
  const halfHeight = height * 0.5;
  const ndcY = (pixelY - halfHeight - principalOffsetPixels) / halfHeight;
  const tangent = ndcY * Math.tan(fovDegrees * DEG_TO_RAD * 0.5);
  const length = Math.hypot(tangent, 1);
  return [0, tangent / length, 1 / length];
}

function angle(left: Direction, right: Direction): number {
  const dot = left.reduce((sum, value, index) => sum + value * right[index], 0);
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

function measureProjection(input: {
  centerY: number;
  fovDegrees: number;
  height: number;
  principalOffsetPixels?: number;
  sampleOffset: number;
  sampleScale: number;
}): { topDegrees: number; bottomDegrees: number; fovDegrees: number } {
  const project = (y: number): Direction => directionAtPixel(
    y,
    input.height,
    input.fovDegrees,
    input.principalOffsetPixels
  );
  const center = project(input.centerY);
  const top = angle(center, project(input.centerY - input.sampleOffset));
  const bottom = angle(center, project(input.centerY + input.sampleOffset));
  return {
    topDegrees: top * RAD_TO_DEG,
    bottomDegrees: bottom * RAD_TO_DEG,
    fovDegrees: 2 * Math.atan2(
      Math.tan((top + bottom) * 0.5),
      input.sampleScale
    ) * RAD_TO_DEG,
  };
}

function integerLatticeMeasurement(height: number, fovDegrees = 45) {
  const centerPixel = Math.trunc(height / 2);
  const samplePixelOffset = Math.trunc(height / 4);
  return measureProjection({
    centerY: centerPixel,
    fovDegrees,
    height,
    sampleOffset: samplePixelOffset,
    sampleScale: 2 * samplePixelOffset / height,
  });
}

describe("Workbench observer projection sampling", () => {
  it("reproduces the even-height false-asymmetry incident", () => {
    const height = 632;
    const old = measureProjection({
      centerY: height * 0.5,
      fovDegrees: 45,
      height,
      sampleOffset: (height - 1) * 0.25,
      sampleScale: (height - 1) / (2 * height),
    });

    expect(old.topDegrees).toBeCloseTo(11.700919508, 8);
    expect(old.bottomDegrees).toBeCloseTo(11.628886283, 8);
    expect(Math.abs(old.topDegrees - old.bottomDegrees))
      .toBeGreaterThan(FOV_SYMMETRY_EPSILON_DEGREES);
  });

  it.each([
    [632, 45],
    [632, 55],
    [641, 45],
    [641, 55],
  ])(
    "recovers a stable FOV on a %i-pixel viewport at %i degrees",
    (height, fovDegrees) => {
      const measured = integerLatticeMeasurement(height, fovDegrees);
      expect(Math.abs(measured.topDegrees - measured.bottomDegrees))
        .toBeLessThan(FOV_SYMMETRY_EPSILON_DEGREES);
      expect(Math.abs(measured.fovDegrees - fovDegrees))
        .toBeLessThan(FOV_EPSILON_DEGREES);
    }
  );

  it("still distinguishes a genuinely asymmetric projection", () => {
    const height = 632;
    const centerPixel = Math.trunc(height / 2);
    const samplePixelOffset = Math.trunc(height / 4);
    const measured = measureProjection({
      centerY: centerPixel,
      fovDegrees: 45,
      height,
      principalOffsetPixels: 40,
      sampleOffset: samplePixelOffset,
      sampleScale: 2 * samplePixelOffset / height,
    });

    expect(Math.abs(measured.topDegrees - measured.bottomDegrees))
      .toBeGreaterThan(FOV_SYMMETRY_EPSILON_DEGREES);
  });
});
