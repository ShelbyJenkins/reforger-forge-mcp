import { describe, expect, it } from "vitest";
import { redactChildLine } from "../../src/observer/agent-client.js";

describe("observer child diagnostic redaction", () => {
  it("removes complete contract bodies and nonce credentials before forwarding stderr", () => {
    const contractLine = redactChildLine('failure {"contract":{"sessionId":"must-not-appear","safeLooking":"also-hidden"},"detail":"tail-hidden"}');
    expect(contractLine).toContain('"contract":[REDACTED]');
    expect(contractLine).not.toContain("must-not-appear");
    expect(contractLine).not.toContain("also-hidden");
    expect(contractLine).not.toContain("tail-hidden");

    const credentialLine = redactChildLine('launchNonce="launch-secret" instanceNonce:instance-secret Authorization: Bearer abc.def');
    expect(credentialLine).not.toContain("launch-secret");
    expect(credentialLine).not.toContain("instance-secret");
    expect(credentialLine).not.toContain("abc.def");
    expect(credentialLine).toContain("[REDACTED]");
  });
});

