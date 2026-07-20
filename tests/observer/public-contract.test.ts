import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PUBLIC_OBSERVER_ERROR_TEXT_MAXIMUM,
  projectPublicObserverToolError,
  type PublicObserverErrorCandidate,
} from "../../src/observer/public-contract.js";

const subject = "Observer error" as const;

function candidate(
  code: unknown,
  message: unknown = "invalid request",
  details: unknown = undefined,
): PublicObserverErrorCandidate {
  return {
    code,
    readDiagnosticMessage: () => message,
    readDetails: () => details,
  };
}

function project(value: PublicObserverErrorCandidate | undefined): string {
  return projectPublicObserverToolError(value, {
    subject,
    extract: (error) => error === value ? value : undefined,
  });
}

describe("public observer error projection", () => {
  it("keeps both public tool boundaries on the central projector", () => {
    for (const path of [
      resolve("src/observer/tools.ts"),
      resolve("src/tools/observer-runtime.ts"),
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source).toContain("projectPublicObserverToolError");
      expect(source).not.toContain("JSON.stringify(details");
    }
  });

  it("canonicalizes unknown values without publishing their messages", () => {
    const text = projectPublicObserverToolError(new Error("token=must-not-appear"), {
      subject,
      extract: () => undefined,
    });

    expect(text).toBe("Observer error (INTERNAL_ERROR): Observer operation failed.");
    expect(text).not.toContain("must-not-appear");
  });

  it("uses every fixed message without inspecting diagnostic readers", () => {
    const fixedMessages = {
      UNAUTHORIZED: "Observer request was not authorized.",
      STORAGE_UNVERIFIABLE: "Observer lifecycle storage could not be verified.",
      INTERNAL_ERROR: "Observer operation failed.",
    } as const;

    for (const [code, message] of Object.entries(fixedMessages)) {
      let messageReads = 0;
      let detailReads = 0;
      const text = projectPublicObserverToolError({ code }, {
        subject,
        extract: () => ({
          code,
          readDiagnosticMessage: () => {
            messageReads += 1;
            throw new Error("must-not-read");
          },
          readDetails: () => {
            detailReads += 1;
            return new Proxy({}, { ownKeys: () => { throw new Error("must-not-inspect"); } });
          },
        }),
      });

      expect(text).toBe(`Observer error (${code}): ${message}`);
      expect(messageReads).toBe(0);
      expect(detailReads).toBe(0);
    }
  });

  it("redacts permitted diagnostics before rendering deterministic fenced JSON", () => {
    const text = project(candidate(
      "INVALID_REQUEST",
      "Authorization: Bearer bearer-sentinel -reforgerForgeOwnerToken=owner-token-sentinel nonce=nonce-sentinel at C:\\Users\\name\\secret",
      {
        token: "token-sentinel",
        nonce: "nonce-sentinel",
        contractBody: { hidden: "contract-body-sentinel" },
        path: "C:\\Users\\name\\secret",
        safe: "control-sentinel",
      },
    ));

    expect(text).toContain("Observer error (INVALID_REQUEST):");
    expect(text).toContain("```json");
    for (const sentinel of [
      "bearer-sentinel",
      "owner-token-sentinel",
      "token-sentinel",
      "nonce-sentinel",
      "contract-body-sentinel",
      "C:\\Users\\name\\secret",
    ]) {
      expect(text, `public error leaked ${sentinel}`).not.toContain(sentinel);
    }
    expect(text).toContain("control-sentinel");
    expect(text.length).toBeLessThanOrEqual(PUBLIC_OBSERVER_ERROR_TEXT_MAXIMUM);
  });

  it("handles false, null, and empty-string details without a truthiness gate", () => {
    for (const details of [false, null, ""]) {
      const text = project(candidate("INVALID_REQUEST", "diagnostic", details));
      const match = text.match(/```json\n([\s\S]*)\n```$/);
      expect(match).not.toBeNull();
      expect(JSON.parse(match![1])).toBe(details);
    }
  });

  it("uses complete truncation JSON or omits details without exceeding the response bound", () => {
    const detail: Record<string, string> = {};
    for (let index = 0; index < 24; index += 1) detail[`key-${index}`] = "x".repeat(256);

    const truncated = project(candidate("INVALID_REQUEST", "diagnostic", detail));
    const truncatedMatch = truncated.match(/```json\n([\s\S]*)\n```$/);
    expect(truncatedMatch).not.toBeNull();
    expect(JSON.parse(truncatedMatch![1])).toEqual({ details: "[public-json:truncated]" });
    expect(truncated.length).toBeLessThanOrEqual(PUBLIC_OBSERVER_ERROR_TEXT_MAXIMUM);

    let detailReads = 0;
    const omitted = projectPublicObserverToolError({ code: "INVALID_REQUEST" }, {
      subject,
      extract: () => ({
        code: "INVALID_REQUEST",
        readDiagnosticMessage: () => "x".repeat(2_000),
        readDetails: () => {
          detailReads += 1;
          return { safe: true };
        },
      }),
    });
    expect(omitted.length).toBe(PUBLIC_OBSERVER_ERROR_TEXT_MAXIMUM);
    expect(omitted).not.toContain("```json");
    expect(detailReads).toBe(0);
  });

  it("falls back to the harmless internal result when an extractor or reader fails", () => {
    const extractorFailure = projectPublicObserverToolError("value", {
      subject,
      extract: () => { throw new Error("owner-token-sentinel"); },
    });
    const readerFailure = projectPublicObserverToolError("value", {
      subject,
      extract: () => ({
        code: "INVALID_REQUEST",
        readDiagnosticMessage: () => { throw new Error("token-sentinel"); },
        readDetails: () => ({ safe: true }),
      }),
    });

    for (const text of [extractorFailure, readerFailure]) {
      expect(text).toBe("Observer error (INTERNAL_ERROR): Observer operation failed.");
      expect(text).not.toMatch(/sentinel/);
    }
  });
});
