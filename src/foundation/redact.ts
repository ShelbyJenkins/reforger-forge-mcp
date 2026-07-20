/**
 * The single presentation boundary for diagnostics and portable evidence.
 *
 * Callers must keep operational values raw until they reach a log, receipt,
 * error, or exported artifact. This module intentionally does not serialize
 * arbitrary values; `redactDiagnostic` returns a bounded, inert value that a
 * caller may then serialize with its existing formatter.
 */

export type RedactionProfile =
  | "diagnostic"
  | "command_argument"
  | "evidence_portability";

export interface RedactionOptions {
  readonly profile: RedactionProfile;
  readonly replacement?: string;
  readonly knownSecretValues?: readonly string[];
  readonly maxLength?: number;
}

const DEFAULT_REPLACEMENT = "[REDACTED]";
const MAX_REPLACEMENT_LENGTH = 256;
const MAX_KNOWN_SECRET_LENGTH = 16_384;
const MAX_TEXT_LENGTH = 1_048_576;
const DEFAULT_DIAGNOSTIC_TEXT_LENGTH = 16_384;
const MAX_DIAGNOSTIC_DEPTH = 8;
const MAX_DIAGNOSTIC_BREADTH = 256;

const MARKERS = {
  accessor: "[REDACTED:ACCESSOR]",
  breadth: "[REDACTED:BREADTH]",
  cycle: "[REDACTED:CYCLE]",
  depth: "[REDACTED:DEPTH]",
  unsupported: "[REDACTED:UNSUPPORTED]",
} as const;

const PROFILE_NAMES = new Set<RedactionProfile>([
  "diagnostic",
  "command_argument",
  "evidence_portability",
]);
const CONTRACT_KEY = /(?:^|[^a-z0-9])[a-z0-9]*contract(?:body|payload)?(?:$|[^a-z0-9])/i;
const SECRET_KEY = /authorization|bearer|credential|password|private[ _-]?key|nonce|token|secret/i;
const OWNER_ARGUMENT = /-reforgerForgeOwnerToken(?:=|\s+)[^\s"']+/gi;
const BEARER_CREDENTIAL = /Bearer\s+[A-Za-z0-9._~-]+/gi;
const STEAM_ID = /\b7656119\d{10}\b/g;
const PORTABLE_PATH_SPAN = /(?:[A-Za-z]:[\\/][^\s"'<>|?*\r\n]*|\\\\[^\\/\s"'<>|?*]+[\\/][^\s"'<>|?*\r\n]+)/g;
const SECRET_ASSIGNMENT = /((?:"?(?:[A-Za-z0-9_-]*(?:token|nonce|secret|credential|password)|authorization|bearer|private[ _-]?key)"?\s*[:=]\s*))(?!Bearer\s+(?:\[[^\]]+\]|<[^>]+>))(?:(?:"(?:\\.|[^"\\])*")|[^\s,;}\]]+)/gi;
const CONTRACT_ASSIGNMENT = /(?:"?[A-Za-z0-9]*contract(?:body|payload)?"?\s*[:=]\s*)/i;

interface ValidatedOptions {
  readonly profile: RedactionProfile;
  readonly replacement: string;
  readonly knownSecretValues: readonly string[];
  readonly maxLength?: number;
}

function validateOptions(options: RedactionOptions): ValidatedOptions {
  if (!options || typeof options !== "object" || !PROFILE_NAMES.has(options.profile)) {
    throw new TypeError("Redaction profile is invalid");
  }
  const replacement = options.replacement ?? DEFAULT_REPLACEMENT;
  if (typeof replacement !== "string" || replacement.length === 0 ||
      replacement.length > MAX_REPLACEMENT_LENGTH || /[\0\r\n]/.test(replacement) ||
      BEARER_CREDENTIAL.test(replacement) || OWNER_ARGUMENT.test(replacement)) {
    throw new TypeError("Redaction replacement is invalid");
  }
  // Global regular expressions retain state between tests. Reset before the
  // next use so validation does not affect redaction output.
  BEARER_CREDENTIAL.lastIndex = 0;
  OWNER_ARGUMENT.lastIndex = 0;

  if (options.maxLength !== undefined &&
      (!Number.isSafeInteger(options.maxLength) || options.maxLength < 0 || options.maxLength > MAX_TEXT_LENGTH)) {
    throw new TypeError("Redaction maximum length is invalid");
  }
  if (options.knownSecretValues !== undefined && !Array.isArray(options.knownSecretValues)) {
    throw new TypeError("Known secret values are invalid");
  }
  const knownSecretValues = [...new Set((options.knownSecretValues ?? []).filter((value): value is string => {
    if (typeof value !== "string" || value.length > MAX_KNOWN_SECRET_LENGTH) {
      throw new TypeError("Known secret value is invalid");
    }
    return value.length > 0;
  }))].sort((left, right) => right.length - left.length);
  return { profile: options.profile, replacement, knownSecretValues, maxLength: options.maxLength };
}

function replaceExactValues(value: string, knownSecretValues: readonly string[], replacement: string): string {
  let result = value;
  for (const secret of knownSecretValues) result = result.replaceAll(secret, replacement);
  return result;
}

/**
 * Contract payloads are deliberately terminal in free-form diagnostics. A
 * child process can emit arbitrary malformed JSON, so trying to parse and
 * selectively retain siblings risks leaking a body through an unmatched
 * delimiter. Structured values take the precise key-based path below.
 */
function redactContractAssignment(value: string, replacement: string): string {
  const match = CONTRACT_ASSIGNMENT.exec(value);
  if (!match || match.index === undefined) return value;
  return `${value.slice(0, match.index + match[0].length)}${replacement}`;
}

function redactOwnerArguments(value: string, replacement: string): string {
  return value.replace(OWNER_ARGUMENT, `-reforgerForgeOwnerToken=${replacement}`);
}

function redactSecretAssignments(value: string, replacement: string): string {
  return value.replace(SECRET_ASSIGNMENT, (match, prefix: string) => {
    const assigned = match.slice(prefix.length);
    return `${prefix}${assigned.startsWith("\"") ? `"${replacement}"` : replacement}`;
  });
}

function redactDiagnosticText(value: string, options: ValidatedOptions): string {
  let result = replaceExactValues(value, options.knownSecretValues, options.replacement);
  result = redactContractAssignment(result, options.replacement);
  result = redactOwnerArguments(result, options.replacement);
  result = result.replace(BEARER_CREDENTIAL, `Bearer ${options.replacement}`);
  result = redactSecretAssignments(result, options.replacement);
  return redactPortablePathSpans(result);
}

function isPortableAbsolutePath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/.test(value);
}

function portableArgument(value: string): string | null {
  const list = value.split(",");
  if (list.length > 1) return list.every(isPortableAbsolutePath) ? `<absolute-path-list:${list.length}>` : null;
  return isPortableAbsolutePath(value) ? "<absolute-path>" : null;
}

function redactPortablePathCandidate(candidate: string): string {
  const trailing = candidate.match(/[.,;:!?()[\]{}]+$/)?.[0] ?? "";
  const core = trailing ? candidate.slice(0, -trailing.length) : candidate;
  const members = core.split(",");
  let result: string;
  if (members.length > 1 && members.every(isPortableAbsolutePath)) {
    result = `<absolute-path-list:${members.length}>`;
  } else if (members.length > 1) {
    result = members.map((member) => isPortableAbsolutePath(member) ? "<absolute-path>" : member).join(",");
  } else {
    result = "<absolute-path>";
  }
  return `${result}${trailing}`;
}

function redactPortablePathSpans(value: string): string {
  return value.replace(PORTABLE_PATH_SPAN, redactPortablePathCandidate);
}

function redactPortableArgument(value: string, options: ValidatedOptions): string {
  const diagnostic = redactDiagnosticText(value, options).replace(STEAM_ID, "<steam-id>");
  const direct = portableArgument(diagnostic);
  if (direct) return direct;
  const equals = diagnostic.indexOf("=");
  if (equals > 0) {
    const portable = portableArgument(diagnostic.slice(equals + 1));
    if (portable) return `${diagnostic.slice(0, equals + 1)}${portable}`;
  }
  return redactPortablePathSpans(diagnostic);
}

function redactTextWithOptions(value: string, options: ValidatedOptions): string {
  let result: string;
  if (options.profile === "command_argument") {
    result = redactOwnerArguments(replaceExactValues(value, options.knownSecretValues, options.replacement), options.replacement);
  } else if (options.profile === "evidence_portability") {
    result = redactPortableArgument(value, options);
  } else {
    result = redactDiagnosticText(value, options);
  }
  return options.maxLength === undefined ? result : result.slice(0, options.maxLength);
}

/** Redact one presentation string while preserving surrounding safe text. */
export function redactText(value: string, options: RedactionOptions): string {
  if (typeof value !== "string") throw new TypeError("Redaction text must be a string");
  return redactTextWithOptions(value, validateOptions(options));
}

/** Redact an argument vector without joining or re-tokenizing it. */
export function redactArguments(values: readonly string[], options: RedactionOptions): readonly string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new TypeError("Redaction arguments must be strings");
  }
  const validated = validateOptions(options);
  return values.map((value) => redactTextWithOptions(value, validated));
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function diagnosticString(value: string, options: ValidatedOptions): string {
  return redactTextWithOptions(value, {
    ...options,
    maxLength: options.maxLength ?? DEFAULT_DIAGNOSTIC_TEXT_LENGTH,
  });
}

function redactDiagnosticValue(
  value: unknown,
  options: ValidatedOptions,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === "string") return diagnosticString(value, options);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (typeof value !== "object" || value === null) return MARKERS.unsupported;
  if (depth >= MAX_DIAGNOSTIC_DEPTH) return MARKERS.depth;
  if (seen.has(value)) return MARKERS.cycle;
  seen.add(value);

  let arrayValue: boolean;
  try {
    arrayValue = Array.isArray(value);
  } catch {
    return MARKERS.unsupported;
  }
  if (arrayValue) {
    const result: unknown[] = [];
    const arrayObject = value as unknown[];
    let actualLength: number;
    try {
      actualLength = arrayObject.length;
    } catch {
      return MARKERS.unsupported;
    }
    const length = Math.min(actualLength, MAX_DIAGNOSTIC_BREADTH);
    for (let index = 0; index < length; index += 1) {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      } catch {
        result.push(MARKERS.unsupported);
        continue;
      }
      if (!descriptor) {
        result.push(null);
      } else if (!("value" in descriptor)) {
        result.push(MARKERS.accessor);
      } else {
        result.push(redactDiagnosticValue(descriptor.value, options, seen, depth + 1));
      }
    }
    if (actualLength > MAX_DIAGNOSTIC_BREADTH) result.push(MARKERS.breadth);
    return result;
  }
  if (!isPlainRecord(value)) return MARKERS.unsupported;

  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let truncated = false;
  try {
    let count = 0;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (count >= MAX_DIAGNOSTIC_BREADTH) {
        truncated = true;
        break;
      }
      count += 1;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        result[key] = MARKERS.accessor;
      } else if (SECRET_KEY.test(key) || CONTRACT_KEY.test(key)) {
        result[key] = options.replacement;
      } else {
        result[key] = redactDiagnosticValue(descriptor.value, options, seen, depth + 1);
      }
    }
  } catch {
    return MARKERS.unsupported;
  }
  if (truncated) result["[REDACTED:BREADTH]"] = MARKERS.breadth;
  return result;
}

/**
 * Return an inert, bounded diagnostic value. Accessors and non-plain objects
 * are never invoked or copied into the result.
 */
export function redactDiagnostic(value: unknown, options: RedactionOptions): unknown {
  return redactDiagnosticValue(value, validateOptions(options), new WeakSet<object>(), 0);
}
