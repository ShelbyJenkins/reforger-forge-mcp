import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

export function canonicalPublicObserverErrorCode(value: unknown, fallback = "INTERNAL_ERROR"): string {
  if (typeof value === "string" && PUBLIC_ERROR_SET.has(value)) return value;
  return PUBLIC_ERROR_SET.has(fallback) ? fallback : "INTERNAL_ERROR";
}

export function canonicalPublicObserverError(
  value: unknown,
  diagnostic: unknown,
  fallback = "INTERNAL_ERROR"
): { code: string; message: string; diagnosticDetailsAllowed: boolean } {
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
