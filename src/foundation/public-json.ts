import { configure } from "safe-stable-stringify";

export interface PublicJsonRenderOptions {
  readonly maximumDepth: number;
  readonly maximumBreadth: number;
  readonly maximumNodes: number;
  readonly maximumStringLength: number;
  readonly maximumCharacters: number;
}

export interface PublicJsonRenderResult {
  readonly text: string | undefined;
  readonly truncated: boolean;
  readonly fallback: boolean;
}

const PUBLIC_JSON_MARKERS = {
  accessor: "[public-json:accessor]",
  bigint: "[public-json:bigint]",
  breadth: "[public-json:breadth]",
  depth: "[public-json:depth]",
  nodeLimit: "[public-json:node-limit]",
  nonFiniteNumber: "[public-json:non-finite-number]",
  stringLimit: "[public-json:string-limit]",
  uninspectable: "[public-json:uninspectable]",
  unsupported: "[public-json:unsupported]",
} as const;

const PUBLIC_JSON_TRUNCATION = { details: "[public-json:truncated]" };
const PUBLIC_JSON_FAILURE = { details: "[public-json:unavailable]" };

const SERIALIZER_MAXIMUM_DEPTH = 6;
const SERIALIZER_MAXIMUM_BREADTH = 24;
const MAXIMUM_NODES = 128;
const MAXIMUM_STRING_LENGTH = 256;
const MAXIMUM_CHARACTERS = 512;

// This serializer is deliberately presentation-only. The normalizer below
// supplies its own input-work limits and never lets arbitrary objects reach
// this boundary.
const stringifyPublicJson = configure({
  bigint: false,
  circularValue: "[public-json:circular]",
  deterministic: true,
  maximumBreadth: SERIALIZER_MAXIMUM_BREADTH,
  maximumDepth: SERIALIZER_MAXIMUM_DEPTH,
  strict: false,
});

interface ValidatedOptions {
  readonly maximumDepth: number;
  readonly maximumBreadth: number;
  readonly maximumNodes: number;
  readonly maximumStringLength: number;
  readonly maximumCharacters: number;
}

interface NormalizationContext {
  readonly options: ValidatedOptions;
  readonly copies: WeakMap<object, object>;
  nodes: number;
}

function validLimit(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function validateOptions(options: PublicJsonRenderOptions): ValidatedOptions {
  if (!options || typeof options !== "object" ||
      !validLimit(options.maximumDepth, SERIALIZER_MAXIMUM_DEPTH) ||
      !validLimit(options.maximumBreadth, SERIALIZER_MAXIMUM_BREADTH) ||
      !validLimit(options.maximumNodes, MAXIMUM_NODES) ||
      !validLimit(options.maximumStringLength, MAXIMUM_STRING_LENGTH) ||
      !validLimit(options.maximumCharacters, MAXIMUM_CHARACTERS)) {
    throw new TypeError("Public JSON render options are invalid");
  }
  return options;
}

function boundedString(value: string, maximumLength: number): string {
  return value.length <= maximumLength
    ? value
    : `${value.slice(0, maximumLength)}${PUBLIC_JSON_MARKERS.stringLimit}`;
}

function descriptorValue(
  source: object,
  key: string,
): { readonly kind: "value"; readonly value: unknown } | { readonly kind: "accessor" } | { readonly kind: "missing" } | { readonly kind: "uninspectable" } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) return { kind: "missing" };
    if (!("value" in descriptor)) return { kind: "accessor" };
    return { kind: "value", value: descriptor.value };
  } catch {
    return { kind: "uninspectable" };
  }
}

function ownEnumerableDataKeys(source: object): string[] | undefined {
  let names: string[];
  try {
    names = Object.getOwnPropertyNames(source);
  } catch {
    return undefined;
  }

  const keys: string[] = [];
  for (let index = 0; index < names.length; index += 1) {
    const key = names[index];
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(source, key);
    } catch {
      return undefined;
    }
    if (descriptor?.enumerable) keys.push(key);
  }
  keys.sort();
  return keys;
}

function normalizedArray(
  source: object,
  context: NormalizationContext,
  depth: number,
): unknown {
  const lengthDescriptor = descriptorValue(source, "length");
  if (lengthDescriptor.kind !== "value" ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0) {
    return PUBLIC_JSON_MARKERS.uninspectable;
  }

  const destination: unknown[] = [];
  context.copies.set(source, destination);
  const elementLimit = Math.max(0, context.options.maximumBreadth - 1);
  const count = Math.min(lengthDescriptor.value, elementLimit);
  for (let index = 0; index < count; index += 1) {
    const descriptor = descriptorValue(source, String(index));
    if (descriptor.kind === "missing") {
      destination.push(null);
    } else if (descriptor.kind === "accessor") {
      destination.push(PUBLIC_JSON_MARKERS.accessor);
    } else if (descriptor.kind === "uninspectable") {
      destination.push(PUBLIC_JSON_MARKERS.uninspectable);
    } else {
      destination.push(normalize(descriptor.value, context, depth + 1));
    }
  }
  if (lengthDescriptor.value > count) destination.push(PUBLIC_JSON_MARKERS.breadth);
  return destination;
}

function normalizedRecord(
  source: object,
  context: NormalizationContext,
  depth: number,
): unknown {
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(source);
  } catch {
    return PUBLIC_JSON_MARKERS.uninspectable;
  }
  if (prototype !== Object.prototype && prototype !== null) return PUBLIC_JSON_MARKERS.unsupported;

  const keys = ownEnumerableDataKeys(source);
  if (!keys) return PUBLIC_JSON_MARKERS.uninspectable;

  const destination: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  context.copies.set(source, destination);
  const keyLimit = Math.max(0, context.options.maximumBreadth - 1);
  const count = Math.min(keys.length, keyLimit);
  for (let index = 0; index < count; index += 1) {
    const key = keys[index];
    const descriptor = descriptorValue(source, key);
    if (descriptor.kind === "accessor") {
      destination[key] = PUBLIC_JSON_MARKERS.accessor;
    } else if (descriptor.kind === "uninspectable") {
      destination[key] = PUBLIC_JSON_MARKERS.uninspectable;
    } else if (descriptor.kind === "missing") {
      destination[key] = PUBLIC_JSON_MARKERS.uninspectable;
    } else {
      destination[key] = normalize(descriptor.value, context, depth + 1);
    }
  }
  if (keys.length > count) destination[PUBLIC_JSON_MARKERS.breadth] = PUBLIC_JSON_MARKERS.breadth;
  return destination;
}

function normalize(value: unknown, context: NormalizationContext, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return boundedString(value, context.options.maximumStringLength);
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : PUBLIC_JSON_MARKERS.nonFiniteNumber;
  }
  if (typeof value === "bigint") return PUBLIC_JSON_MARKERS.bigint;
  if (typeof value !== "object") return PUBLIC_JSON_MARKERS.unsupported;

  const existing = context.copies.get(value);
  if (existing) return existing;
  if (depth >= context.options.maximumDepth) return PUBLIC_JSON_MARKERS.depth;
  if (context.nodes >= context.options.maximumNodes) return PUBLIC_JSON_MARKERS.nodeLimit;
  context.nodes += 1;

  let arrayValue: boolean;
  try {
    arrayValue = Array.isArray(value);
  } catch {
    return PUBLIC_JSON_MARKERS.uninspectable;
  }
  return arrayValue
    ? normalizedArray(value, context, depth)
    : normalizedRecord(value, context, depth);
}

function serialize(value: unknown): string | undefined {
  const rendered = stringifyPublicJson(value);
  return typeof rendered === "string" ? rendered : undefined;
}

function maximumCharactersFrom(options: unknown): number | undefined {
  try {
    if (!options || typeof options !== "object") return undefined;
    const candidate = (options as { maximumCharacters?: unknown }).maximumCharacters;
    return validLimit(candidate, MAXIMUM_CHARACTERS) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function rendererFailure(maximumCharacters: number | undefined): PublicJsonRenderResult {
  if (maximumCharacters !== undefined) {
    try {
      const text = serialize(PUBLIC_JSON_FAILURE);
      if (text !== undefined && text.length <= maximumCharacters) {
        return { text, truncated: false, fallback: true };
      }
    } catch {
      // A public renderer failure must not surface the caught error.
    }
  }
  return { text: undefined, truncated: false, fallback: true };
}

/**
 * Render an already-redacted diagnostic value as finite, deterministic JSON.
 * This module intentionally owns presentation mechanics only, never secrets
 * or public error policy.
 */
export function renderRedactedPublicJson(
  value: unknown,
  options: PublicJsonRenderOptions,
): PublicJsonRenderResult {
  let validated: ValidatedOptions;
  try {
    validated = validateOptions(options);
  } catch {
    return rendererFailure(maximumCharactersFrom(options));
  }

  try {
    const normalized = normalize(value, {
      options: validated,
      copies: new WeakMap<object, object>(),
      nodes: 0,
    }, 0);
    const text = serialize(normalized);
    if (text !== undefined && text.length <= validated.maximumCharacters) {
      return { text, truncated: false, fallback: false };
    }

    const truncated = serialize(PUBLIC_JSON_TRUNCATION);
    if (truncated !== undefined && truncated.length <= validated.maximumCharacters) {
      return { text: truncated, truncated: true, fallback: false };
    }
    return { text: undefined, truncated: false, fallback: false };
  } catch {
    return rendererFailure(validated.maximumCharacters);
  }
}
