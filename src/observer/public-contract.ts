import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderRedactedPublicJson } from "../foundation/public-json.js";
import { redactDiagnostic, redactText } from "../foundation/redact.js";
import type { CaptureErrorCode } from "./capture-contract.js";
import {
  formatObserverRefusalRemedy,
  type ObserverRefusalContext,
  type ObserverRefusalRemedyResolver,
} from "./refusal-remedy.js";

export const PUBLIC_OBSERVER_ERROR_TEXT_MAXIMUM = 512;

const JSON_FENCE_PREFIX = "\n\n```json\n";
const JSON_FENCE_SUFFIX = "\n```";
const MINIMUM_JSON_DETAIL_BLOCK = JSON_FENCE_PREFIX.length + JSON_FENCE_SUFFIX.length + 2;
const PUBLIC_DETAIL_MAXIMUM_DEPTH = 6;
const PUBLIC_DETAIL_MAXIMUM_BREADTH = 24;
const PUBLIC_DETAIL_MAXIMUM_NODES = 128;
const PUBLIC_DETAIL_MAXIMUM_STRING_LENGTH = 256;
const OBSERVER_OPERATION_FAILED = "Observer operation failed.";

function generatedStringArray(name: string): readonly [string, ...string[]] {
  const path = fileURLToPath(new URL(`../../observer/protocol/generated/${name}.json`, import.meta.url));
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed) || parsed.length === 0 ||
      parsed.some((value) => typeof value !== "string" || value.length === 0) ||
      new Set(parsed).size !== parsed.length) {
    throw new Error(`Generated observer ${name} registry is invalid`);
  }
  return parsed as [string, ...string[]];
}

/** Generated from observer/protocol/registry.ts and drift-tested. */
export const PUBLIC_OBSERVER_CAPABILITIES = generatedStringArray("capabilities");
/** Generated from observer/protocol/registry.ts and drift-tested. */
export const PUBLIC_OBSERVER_ERROR_CODES = generatedStringArray("error-codes");

const PUBLIC_ERROR_SET = new Set<string>(PUBLIC_OBSERVER_ERROR_CODES);
const FIXED_ERROR_MESSAGES: Readonly<Record<string, string>> = (() => {
  const path = fileURLToPath(new URL(
    "../../observer/protocol/generated/fixed-error-messages.json",
    import.meta.url
  ));
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.entries(parsed).some(([code, message]) =>
        !PUBLIC_ERROR_SET.has(code) || typeof message !== "string" || message.length === 0 || message.length > 512)) {
    throw new Error("Generated observer fixed-message registry is invalid");
  }
  return parsed as Record<string, string>;
})();

export function canonicalPublicObserverErrorCode(
  value: unknown,
  fallback: CaptureErrorCode = "INTERNAL_ERROR"
): CaptureErrorCode {
  if (typeof value === "string" && PUBLIC_ERROR_SET.has(value)) return value as CaptureErrorCode;
  return PUBLIC_ERROR_SET.has(fallback) ? fallback : "INTERNAL_ERROR";
}

export function canonicalPublicObserverError(
  value: unknown,
  diagnostic: unknown,
  fallback: CaptureErrorCode = "INTERNAL_ERROR"
): { code: CaptureErrorCode; message: string; diagnosticDetailsAllowed: boolean } {
  const code = canonicalPublicObserverErrorCode(value, fallback);
  const fixed = FIXED_ERROR_MESSAGES[code];
  const bounded = typeof diagnostic === "string" ? diagnostic.trim().slice(0, 512) : "";
  return {
    code,
    message: (fixed ?? bounded) || "Observer operation failed.",
    // A fixed-message policy is a complete diagnostic redaction boundary.
    // Verbatim structured details must not reintroduce the hidden diagnostic.
    diagnosticDetailsAllowed: fixed === undefined,
  };
}

export interface PublicObserverErrorCandidate {
  readonly code: unknown;
  readonly readDiagnosticMessage: () => unknown;
  readonly readDetails: () => unknown;
}

export interface PublicObserverErrorProjectionOptions {
  readonly subject: "Observer error" | "Observer runtime error";
  readonly extract: (error: unknown) => PublicObserverErrorCandidate | undefined;
  readonly remedyContext?: ObserverRefusalContext;
  readonly resolveRemedy?: ObserverRefusalRemedyResolver;
  readonly readRemedyContext?: () => unknown;
}

function completeHeader(
  subject: PublicObserverErrorProjectionOptions["subject"],
  code: CaptureErrorCode,
  message: string,
  maximum = PUBLIC_OBSERVER_ERROR_TEXT_MAXIMUM,
): string {
  const prefix = `${subject} (${code}): `;
  if (maximum <= prefix.length) return prefix.slice(0, Math.max(0, maximum));
  return `${prefix}${message.slice(0, maximum - prefix.length)}`;
}

function internalPublicError(subject: PublicObserverErrorProjectionOptions["subject"]): string {
  return completeHeader(
    subject,
    "INTERNAL_ERROR",
    FIXED_ERROR_MESSAGES.INTERNAL_ERROR ?? OBSERVER_OPERATION_FAILED,
  );
}

/**
 * Project a known observer error into the one bounded MCP public-error text.
 * Readers are intentionally lazy so fixed messages never inspect diagnostics.
 */
export function projectPublicObserverToolError(
  error: unknown,
  options: PublicObserverErrorProjectionOptions,
): string {
  let candidate: PublicObserverErrorCandidate | undefined;
  try {
    candidate = options.extract(error);
  } catch {
    return internalPublicError(options.subject);
  }
  if (!candidate) return internalPublicError(options.subject);

  try {
    const code = canonicalPublicObserverErrorCode(candidate.code);
    const fixed = FIXED_ERROR_MESSAGES[code];
    // This gate is deliberately ahead of both diagnostic readers. Fixed public
    // messages are a complete boundary, not merely a preferred presentation.
    if (fixed !== undefined) return completeHeader(options.subject, code, fixed);

    let remedy = "";
    if (options.resolveRemedy !== undefined) {
      if (options.remedyContext === undefined) return internalPublicError(options.subject);
      const selected = options.resolveRemedy({
        code,
        context: options.remedyContext,
        readRemedyContext: options.readRemedyContext ?? (() => undefined),
      });
      remedy = selected === null ? "" : formatObserverRefusalRemedy(selected);
      if (remedy.length >= PUBLIC_OBSERVER_ERROR_TEXT_MAXIMUM) {
        return internalPublicError(options.subject);
      }
    }

    const diagnostic = candidate.readDiagnosticMessage();
    const redactedMessage = typeof diagnostic === "string"
      ? redactText(diagnostic, {
        profile: "diagnostic",
        maxLength: PUBLIC_OBSERVER_ERROR_TEXT_MAXIMUM,
      }).trim()
      : "";
    const header = completeHeader(
      options.subject,
      code,
      redactedMessage || OBSERVER_OPERATION_FAILED,
      PUBLIC_OBSERVER_ERROR_TEXT_MAXIMUM - remedy.length,
    );

    const available = PUBLIC_OBSERVER_ERROR_TEXT_MAXIMUM - header.length - remedy.length;
    if (available < MINIMUM_JSON_DETAIL_BLOCK) return `${header}${remedy}`;

    const details = candidate.readDetails();
    if (details === undefined) return `${header}${remedy}`;

    const rendered = renderRedactedPublicJson(
      redactDiagnostic(details, { profile: "diagnostic" }),
      {
        maximumDepth: PUBLIC_DETAIL_MAXIMUM_DEPTH,
        maximumBreadth: PUBLIC_DETAIL_MAXIMUM_BREADTH,
        maximumNodes: PUBLIC_DETAIL_MAXIMUM_NODES,
        maximumStringLength: PUBLIC_DETAIL_MAXIMUM_STRING_LENGTH,
        maximumCharacters: available - JSON_FENCE_PREFIX.length - JSON_FENCE_SUFFIX.length,
      },
    );
    if (rendered.fallback || rendered.text === undefined) return rendered.fallback
      ? internalPublicError(options.subject)
      : `${header}${remedy}`;

    const result = `${header}${JSON_FENCE_PREFIX}${rendered.text}${JSON_FENCE_SUFFIX}${remedy}`;
    return result.length <= PUBLIC_OBSERVER_ERROR_TEXT_MAXIMUM
      ? result
      : `${header}${remedy}`;
  } catch {
    return internalPublicError(options.subject);
  }
}
