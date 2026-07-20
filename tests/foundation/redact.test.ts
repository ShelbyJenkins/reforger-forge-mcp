import { describe, expect, it } from "vitest";
import {
  redactArguments,
  redactDiagnostic,
  redactText,
} from "../../src/foundation/redact.js";

describe("foundation redaction boundary", () => {
  it("redacts diagnostic text before applying an output bound", () => {
    const secret = "opaque-dynamic-token-sentinel";
    const value = redactText(`prefix ${secret} tail`, {
      profile: "diagnostic",
      knownSecretValues: [secret],
      replacement: "<redacted>",
      maxLength: 24,
    });

    expect(value).toBe("prefix <redacted> tail");
    expect(value).not.toContain(secret);
  });

  it("redacts bearer, named credentials, contract bodies, and owner arguments", () => {
    const value = redactText(
      'Authorization: Bearer bearer-sentinel launchNonce="nonce-sentinel" -reforgerForgeOwnerToken owner-sentinel contractPayload={"sessionToken":"contract-sentinel"}',
      { profile: "diagnostic" }
    );

    for (const sentinel of ["bearer-sentinel", "nonce-sentinel", "owner-sentinel", "contract-sentinel"]) {
      expect(value).not.toContain(sentinel);
    }
    expect(value).toContain("-reforgerForgeOwnerToken=[REDACTED]");
  });

  it("uses exact dynamic values longest-first and is idempotent", () => {
    const options = {
      profile: "diagnostic" as const,
      knownSecretValues: ["opaque-token-sentinel", "token-sentinel"],
      replacement: "[redacted]",
    };
    const once = redactText("opaque-token-sentinel token-sentinel", options);

    expect(once).toBe("[redacted] [redacted]");
    expect(redactText(once, options)).toBe(once);
  });

  it("walks only own plain data properties without getters and bounds hostile values", () => {
    let getterCalls = 0;
    const cyclic: Record<string, unknown> = { safe: "control-sentinel", nested: { sessionToken: "nested-token-sentinel" } };
    cyclic.self = cyclic;
    Object.defineProperty(cyclic, "credential", { enumerable: true, get: () => { getterCalls += 1; return "must-not-run"; } });
    const classValue = new (class Value { value = "class-sentinel"; })();
    const result = redactDiagnostic({ cyclic, classValue, values: Array.from({ length: 257 }, (_, index) => index) }, {
      profile: "diagnostic",
    });
    const rendered = JSON.stringify(result);

    expect(getterCalls).toBe(0);
    expect(rendered).toContain("control-sentinel");
    expect(rendered).not.toContain("nested-token-sentinel");
    expect(rendered).toContain("[REDACTED:ACCESSOR]");
    expect(rendered).toContain("[REDACTED:CYCLE]");
    expect(rendered).toContain("[REDACTED:UNSUPPORTED]");
    expect(rendered).toContain("[REDACTED:BREADTH]");
  });

  it("returns the unsupported marker for a revoked proxy", () => {
    const revocable = Proxy.revocable([], {});
    revocable.revoke();

    expect(redactDiagnostic(revocable.proxy, { profile: "diagnostic" })).toBe("[REDACTED:UNSUPPORTED]");
  });

  it("keeps command vectors tokenized while masking owner-token forms", () => {
    const raw = ["-run", "-reforgerForgeOwnerToken=owner-sentinel", "-reforgerForgeOwnerToken owner-sentinel", "ordinary argument"];
    const result = redactArguments(raw, { profile: "command_argument", replacement: "[redacted]" });

    expect(result).toEqual([
      "-run",
      "-reforgerForgeOwnerToken=[redacted]",
      "-reforgerForgeOwnerToken=[redacted]",
      "ordinary argument",
    ]);
    expect(raw[1]).toContain("owner-sentinel");
  });

  it("normalizes evidence paths, UNC paths, all-absolute lists, and Steam IDs", () => {
    const result = redactArguments([
      "C:\\evidence\\run",
      "\\\\server\\share\\run",
      "-addonsDir=C:\\one,D:\\two",
      "-mixed=C:\\one,relative",
      "76561191234567890",
    ], { profile: "evidence_portability" });

    expect(result).toEqual([
      "<absolute-path>",
      "<absolute-path>",
      "-addonsDir=<absolute-path-list:2>",
      "-mixed=<absolute-path>,relative",
      "<steam-id>",
    ]);
    expect(redactText("failed at C:\\Users\\name\\file; safe-control", {
      profile: "evidence_portability",
    })).toBe("failed at <absolute-path>; safe-control");
    expect(redactText("failed at C:\\Users\\name\\file; safe-control", {
      profile: "diagnostic",
    })).toBe("failed at <absolute-path>; safe-control");
  });

  it("rejects invalid options", () => {
    expect(() => redactText("value", { profile: "unknown" as never })).toThrow(/profile/i);
    expect(() => redactText("value", { profile: "diagnostic", maxLength: -1 })).toThrow(/maximum/i);
    expect(() => redactText("value", { profile: "diagnostic", knownSecretValues: ["x".repeat(16_385)] })).toThrow(/secret/i);
  });
});
