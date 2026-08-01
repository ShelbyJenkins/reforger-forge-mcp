import { Transformer } from "@napi-rs/image";
import { describe, expect, it } from "vitest";
import {
  ImageOutputError,
  inspectImage,
  transformImage,
  transformImageSync,
} from "../../src/foundation/image-output.js";

const limits = {
  maxSourceBytes: 8 * 1024 * 1024,
  maxRetainedBytes: 8 * 1024 * 1024,
  maxWidth: 16_384,
  maxHeight: 16_384,
  maxPixels: 32_000_000,
};

function sourcePng(width = 400, height = 200): Buffer {
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = (index / 4) % 251;
    pixels[index + 1] = Math.floor(index / 4 / width) % 251;
    pixels[index + 2] = 127;
    pixels[index + 3] = 255;
  }
  return Transformer.fromRgbaPixels(pixels, width, height).pngSync();
}

describe("@napi-rs/image capture output", () => {
  it("preserves native PNG bytes when no resize or transcode is requested", async () => {
    const input = sourcePng();
    const source = inspectImage(input, "png", limits);
    const result = await transformImage(input, source, { format: "png" }, limits);

    expect(result.image).toEqual(input);
    expect(result).toMatchObject({
      format: "png",
      mimeType: "image/png",
      extension: ".png",
      width: 400,
      height: 200,
      resized: false,
      transcoded: false,
    });
  });

  it("fits inside one or two bounds without enlargement", async () => {
    const input = sourcePng();
    const source = inspectImage(input, "png", limits);

    const widthBound = await transformImage(input, source, { format: "png", maxWidth: 100 }, limits);
    expect(widthBound).toMatchObject({ width: 100, height: 50, resized: true });

    const twoBounds = transformImageSync(
      input,
      source,
      { format: "png", maxWidth: 300, maxHeight: 80 },
      limits,
    );
    expect(twoBounds).toMatchObject({ width: 160, height: 80, resized: true });

    const noEnlargement = await transformImage(input, source, { format: "png", maxWidth: 800 }, limits);
    expect(noEnlargement.image).toEqual(input);
    expect(noEnlargement).toMatchObject({ width: 400, height: 200, resized: false });
  });

  it.each([
    ["jpeg", "image/jpeg", ".jpg"],
    ["webp", "image/webp", ".webp"],
  ] as const)("encodes bounded %s output with explicit quality", async (format, mimeType, extension) => {
    const input = sourcePng(64, 32);
    const result = await transformImage(
      input,
      inspectImage(input, "png", limits),
      { format, quality: 60, maxWidth: 32 },
      limits,
    );

    expect(result).toMatchObject({
      format,
      mimeType,
      extension,
      quality: 60,
      width: 32,
      height: 16,
      transcoded: true,
    });
    expect(inspectImage(result.image, format, limits)).toMatchObject({ width: 32, height: 16 });
  });

  it("rejects a valid final encoding that exceeds the retained-byte limit", async () => {
    const input = sourcePng(96, 48);
    const source = inspectImage(input, "png", limits);
    const encoded = await transformImage(
      input,
      source,
      { format: "webp", quality: 75, maxWidth: 64 },
      limits,
    );

    await expect(transformImage(
      input,
      source,
      { format: "webp", quality: 75, maxWidth: 64 },
      { ...limits, maxRetainedBytes: encoded.bytes - 1 },
    )).rejects.toMatchObject({
      code: "ARTIFACT_TOO_LARGE",
      message: "Encoded image exceeds the configured retained-artifact limit",
    });
  });

  it("rejects invalid contracts and bounded-source violations", async () => {
    const input = sourcePng(16, 8);
    const source = inspectImage(input, "png", limits);

    await expect(transformImage(input, source, { format: "png", quality: 75 }, limits))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(() => inspectImage(input, "jpeg", limits))
      .toThrowError(expect.objectContaining({ code: "ARTIFACT_INVALID" }));
    expect(() => inspectImage(input, "png", { ...limits, maxSourceBytes: input.length - 1 }))
      .toThrowError(expect.objectContaining({ code: "ARTIFACT_TOO_LARGE" }));
    expect(() => transformImageSync(input, source, { format: "webp", quality: 101 }, limits))
      .toThrowError(ImageOutputError);
  });

  it("honors cancellation before decoding", async () => {
    const input = sourcePng(16, 8);
    const controller = new AbortController();
    controller.abort();
    await expect(transformImage(
      input,
      inspectImage(input, "png", limits),
      { format: "webp", quality: 75 },
      limits,
      controller.signal,
    )).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
