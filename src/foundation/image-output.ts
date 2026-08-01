import {
  CompressionType,
  FilterType,
  ResizeFilterType,
  ResizeFit,
  Transformer,
} from "@napi-rs/image";
import { createHash } from "node:crypto";

export const IMAGE_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
export type ImageOutputFormat = (typeof IMAGE_OUTPUT_FORMATS)[number];
export type ImageSourceFormat = ImageOutputFormat | "bmp";

export interface ImageOutputRequest {
  maxWidth?: number;
  maxHeight?: number;
  format?: ImageOutputFormat;
  quality?: number;
}

export interface CanonicalImageOutputPolicy {
  format: ImageOutputFormat;
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
}

export interface ImageSourceDescriptor {
  format: ImageSourceFormat;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

export interface ImageTransformLimits {
  maxSourceBytes: number;
  maxRetainedBytes: number;
  maxWidth: number;
  maxHeight: number;
  maxPixels: number;
}

export interface TransformedImage {
  image: Buffer;
  format: ImageOutputFormat;
  mimeType: ImageOutputMimeType;
  extension: ImageOutputExtension;
  width: number;
  height: number;
  bytes: number;
  quality?: number;
  resized: boolean;
  transcoded: boolean;
}

export type ImageOutputMimeType = "image/png" | "image/jpeg" | "image/webp";
export type ImageOutputExtension = ".png" | ".jpg" | ".webp";

const OUTPUT_DESCRIPTORS = Object.freeze({
  png: { mimeType: "image/png", extension: ".png" },
  jpeg: { mimeType: "image/jpeg", extension: ".jpg" },
  webp: { mimeType: "image/webp", extension: ".webp" },
} satisfies Record<ImageOutputFormat, {
  mimeType: ImageOutputMimeType;
  extension: ImageOutputExtension;
}>);

export class ImageOutputError extends Error {
  constructor(
    public readonly code: "INVALID_REQUEST" | "ARTIFACT_INVALID" | "ARTIFACT_TOO_LARGE" | "CANCELLED",
    message: string,
  ) {
    super(message);
    this.name = "ImageOutputError";
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ImageOutputError("INVALID_REQUEST", `${label} must be a positive safe integer`);
  }
  return value;
}

function assertLimits(limits: ImageTransformLimits): void {
  positiveInteger(limits.maxSourceBytes, "Image source byte limit");
  positiveInteger(limits.maxRetainedBytes, "Image retained byte limit");
  positiveInteger(limits.maxWidth, "Image width limit");
  positiveInteger(limits.maxHeight, "Image height limit");
  positiveInteger(limits.maxPixels, "Image pixel limit");
}

function assertSource(source: ImageSourceDescriptor, limits: ImageTransformLimits, inputBytes: number): void {
  if (!["bmp", ...IMAGE_OUTPUT_FORMATS].includes(source.format)) {
    throw new ImageOutputError("ARTIFACT_INVALID", "Image source format is unsupported");
  }
  positiveInteger(source.width, "Image source width");
  positiveInteger(source.height, "Image source height");
  if (source.bytes !== inputBytes || source.bytes > limits.maxSourceBytes) {
    throw new ImageOutputError(
      source.bytes > limits.maxSourceBytes ? "ARTIFACT_TOO_LARGE" : "ARTIFACT_INVALID",
      source.bytes > limits.maxSourceBytes
        ? "Image source exceeds the configured byte limit"
        : "Image source byte count does not match its descriptor",
    );
  }
  if (source.width > limits.maxWidth || source.height > limits.maxHeight) {
    throw new ImageOutputError("ARTIFACT_TOO_LARGE", "Image source dimensions exceed the configured limit");
  }
  const pixels = source.width * source.height;
  if (!Number.isSafeInteger(pixels) || pixels > limits.maxPixels) {
    throw new ImageOutputError("ARTIFACT_TOO_LARGE", "Image source pixel count exceeds the configured limit");
  }
  if (!/^[a-f0-9]{64}$/.test(source.sha256)) {
    throw new ImageOutputError("ARTIFACT_INVALID", "Image source digest is invalid");
  }
}

function targetDimensions(
  sourceWidth: number,
  sourceHeight: number,
  policy: CanonicalImageOutputPolicy,
): { width: number; height: number; resized: boolean } {
  if (policy.maxWidth !== undefined) positiveInteger(policy.maxWidth, "Image output maximum width");
  if (policy.maxHeight !== undefined) positiveInteger(policy.maxHeight, "Image output maximum height");
  const widthRatio = policy.maxWidth === undefined ? 1 : policy.maxWidth / sourceWidth;
  const heightRatio = policy.maxHeight === undefined ? 1 : policy.maxHeight / sourceHeight;
  const scale = Math.min(1, widthRatio, heightRatio);
  const width = Math.max(1, Math.floor(sourceWidth * scale));
  const height = Math.max(1, Math.floor(sourceHeight * scale));
  return { width, height, resized: width !== sourceWidth || height !== sourceHeight };
}

function mappedError(error: unknown): ImageOutputError {
  if (error instanceof ImageOutputError) return error;
  if ((error as { name?: unknown } | null)?.name === "AbortError") {
    return new ImageOutputError("CANCELLED", "Image transformation was cancelled");
  }
  return new ImageOutputError(
    "ARTIFACT_INVALID",
    error instanceof Error ? `Image transformation failed: ${error.message}` : "Image transformation failed",
  );
}

export function imageOutputDescriptor(format: ImageOutputFormat): {
  mimeType: ImageOutputMimeType;
  extension: ImageOutputExtension;
} {
  return OUTPUT_DESCRIPTORS[format];
}

export function imageOutputFormatFromMimeType(value: unknown): ImageOutputFormat | null {
  if (value === "image/png") return "png";
  if (value === "image/jpeg") return "jpeg";
  if (value === "image/webp") return "webp";
  return null;
}

export function inspectImage(
  input: Buffer,
  expectedFormat: ImageSourceFormat,
  limits: Pick<ImageTransformLimits, "maxSourceBytes" | "maxWidth" | "maxHeight" | "maxPixels">,
): ImageSourceDescriptor {
  const fullLimits: ImageTransformLimits = {
    ...limits,
    maxRetainedBytes: limits.maxSourceBytes,
  };
  assertLimits(fullLimits);
  if (!Buffer.isBuffer(input) || input.length < 1 || input.length > limits.maxSourceBytes) {
    throw new ImageOutputError(
      input.length > limits.maxSourceBytes ? "ARTIFACT_TOO_LARGE" : "ARTIFACT_INVALID",
      input.length > limits.maxSourceBytes
        ? "Image source exceeds the configured byte limit"
        : "Image source is empty",
    );
  }
  try {
    const metadata = new Transformer(input).metadataSync(false);
    const detected = metadata.format === "jpg" ? "jpeg" : metadata.format;
    if (detected !== expectedFormat) {
      throw new ImageOutputError("ARTIFACT_INVALID", "Image bytes do not match the declared format");
    }
    const descriptor: ImageSourceDescriptor = {
      format: expectedFormat,
      width: metadata.width,
      height: metadata.height,
      bytes: input.length,
      sha256: createHash("sha256").update(input).digest("hex"),
    };
    assertSource(descriptor, fullLimits, input.length);
    return descriptor;
  } catch (error) {
    throw mappedError(error);
  }
}

export async function transformImage(
  input: Buffer,
  source: ImageSourceDescriptor,
  policy: CanonicalImageOutputPolicy,
  limits: ImageTransformLimits,
  signal?: AbortSignal,
): Promise<TransformedImage> {
  assertLimits(limits);
  assertSource(source, limits, input.length);
  if (signal?.aborted) throw new ImageOutputError("CANCELLED", "Image transformation was cancelled");
  if (!IMAGE_OUTPUT_FORMATS.includes(policy.format)) {
    throw new ImageOutputError("INVALID_REQUEST", "Image output format is unsupported");
  }
  if (policy.quality !== undefined && policy.format === "png") {
    throw new ImageOutputError("INVALID_REQUEST", "PNG output does not accept a quality value");
  }
  if (policy.quality !== undefined &&
      (!Number.isSafeInteger(policy.quality) || policy.quality < 1 || policy.quality > 100)) {
    throw new ImageOutputError("INVALID_REQUEST", "Image output quality must be from 1 through 100");
  }
  const dimensions = targetDimensions(source.width, source.height, policy);
  const descriptor = imageOutputDescriptor(policy.format);
  const mustApplyLossyQuality = policy.format !== "png" && policy.quality !== undefined;
  if (!dimensions.resized && source.format === policy.format && !mustApplyLossyQuality &&
      input.length <= limits.maxRetainedBytes) {
    return {
      image: Buffer.from(input),
      format: policy.format,
      ...descriptor,
      width: source.width,
      height: source.height,
      bytes: input.length,
      ...(policy.quality === undefined ? {} : { quality: policy.quality }),
      resized: false,
      transcoded: false,
    };
  }

  try {
    const transformer = new Transformer(input);
    if (dimensions.resized) {
      transformer.resize({
        width: dimensions.width,
        height: dimensions.height,
        fit: ResizeFit.Inside,
        filter: ResizeFilterType.Lanczos3,
      });
    }
    const output = policy.format === "png"
      ? await transformer.png({
          compressionType: CompressionType.Best,
          filterType: FilterType.Adaptive,
        }, signal)
      : policy.format === "jpeg"
        ? await transformer.jpeg(policy.quality, signal)
        : await transformer.webp(policy.quality, signal);
    if (output.length < 1 || output.length > limits.maxRetainedBytes) {
      throw new ImageOutputError("ARTIFACT_TOO_LARGE", "Encoded image exceeds the configured retained-artifact limit");
    }
    const metadata = await new Transformer(output).metadata(false, signal);
    const format = metadata.format === "jpg" ? "jpeg" : metadata.format;
    if (format !== policy.format || metadata.width !== dimensions.width || metadata.height !== dimensions.height) {
      throw new ImageOutputError("ARTIFACT_INVALID", "Encoded image does not match the requested output contract");
    }
    return {
      image: output,
      format: policy.format,
      ...descriptor,
      width: dimensions.width,
      height: dimensions.height,
      bytes: output.length,
      ...(policy.quality === undefined ? {} : { quality: policy.quality }),
      resized: dimensions.resized,
      transcoded: source.format !== policy.format,
    };
  } catch (error) {
    throw mappedError(error);
  }
}

/**
 * Synchronous variant for adapters whose artifact-validation boundary is
 * intentionally synchronous. Prefer transformImage in request-serving code.
 */
export function transformImageSync(
  input: Buffer,
  source: ImageSourceDescriptor,
  policy: CanonicalImageOutputPolicy,
  limits: ImageTransformLimits,
): TransformedImage {
  assertLimits(limits);
  assertSource(source, limits, input.length);
  if (!IMAGE_OUTPUT_FORMATS.includes(policy.format)) {
    throw new ImageOutputError("INVALID_REQUEST", "Image output format is unsupported");
  }
  if (policy.quality !== undefined && policy.format === "png") {
    throw new ImageOutputError("INVALID_REQUEST", "PNG output does not accept a quality value");
  }
  if (policy.quality !== undefined &&
      (!Number.isSafeInteger(policy.quality) || policy.quality < 1 || policy.quality > 100)) {
    throw new ImageOutputError("INVALID_REQUEST", "Image output quality must be from 1 through 100");
  }
  const dimensions = targetDimensions(source.width, source.height, policy);
  const descriptor = imageOutputDescriptor(policy.format);
  const mustApplyLossyQuality = policy.format !== "png" && policy.quality !== undefined;
  if (!dimensions.resized && source.format === policy.format && !mustApplyLossyQuality &&
      input.length <= limits.maxRetainedBytes) {
    return {
      image: Buffer.from(input),
      format: policy.format,
      ...descriptor,
      width: source.width,
      height: source.height,
      bytes: input.length,
      resized: false,
      transcoded: false,
    };
  }
  try {
    const transformer = new Transformer(input);
    if (dimensions.resized) {
      transformer.resize({
        width: dimensions.width,
        height: dimensions.height,
        fit: ResizeFit.Inside,
        filter: ResizeFilterType.Lanczos3,
      });
    }
    const output = policy.format === "png"
      ? transformer.pngSync({
          compressionType: CompressionType.Best,
          filterType: FilterType.Adaptive,
        })
      : policy.format === "jpeg"
        ? transformer.jpegSync(policy.quality)
        : transformer.webpSync(policy.quality);
    if (output.length < 1 || output.length > limits.maxRetainedBytes) {
      throw new ImageOutputError("ARTIFACT_TOO_LARGE", "Encoded image exceeds the configured retained-artifact limit");
    }
    const metadata = new Transformer(output).metadataSync(false);
    const format = metadata.format === "jpg" ? "jpeg" : metadata.format;
    if (format !== policy.format || metadata.width !== dimensions.width || metadata.height !== dimensions.height) {
      throw new ImageOutputError("ARTIFACT_INVALID", "Encoded image does not match the requested output contract");
    }
    return {
      image: output,
      format: policy.format,
      ...descriptor,
      width: dimensions.width,
      height: dimensions.height,
      bytes: output.length,
      ...(policy.quality === undefined ? {} : { quality: policy.quality }),
      resized: dimensions.resized,
      transcoded: source.format !== policy.format,
    };
  } catch (error) {
    throw mappedError(error);
  }
}
