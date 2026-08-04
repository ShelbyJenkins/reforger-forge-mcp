import { describe, expect, it } from "vitest";
import { CaptureError } from "../../src/observer/capture-contract.js";
import { decodeCaptureTarget, encodeCaptureTarget } from "../../src/observer/capture-target.js";
import { runtimeWorldRevision, workbenchWorldRevision } from "../../src/observer/world-revision.js";

function rawTarget(value: unknown): string {
  return `ct1.${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}

describe("opaque capture targets", () => {
  it("round-trips exact runtime and Workbench bindings", () => {
    const runtime = {
      backend: "runtime" as const,
      sessionId: "session-1",
      instanceId: "runtime-1",
      expectedWorldRevision: runtimeWorldRevision("world-1", 7),
    };
    const workbench = {
      backend: "workbench" as const,
      instanceId: "workbench-1",
      expectedWorldRevision: workbenchWorldRevision("project|world|scene|false"),
    };
    expect(decodeCaptureTarget(encodeCaptureTarget(runtime))).toEqual(runtime);
    expect(decodeCaptureTarget(encodeCaptureTarget(workbench))).toEqual(workbench);
  });

  it.each([
    ["unknown version", "ct2.eyJ9"],
    ["malformed base64", "ct1.%%%"],
    ["malformed JSON", `ct1.${Buffer.from("not-json").toString("base64url")}`],
    ["missing fields", rawTarget({ backend: "workbench" })],
    ["runtime without session", rawTarget({
      backend: "runtime", instanceId: "runtime-1",
      expectedWorldRevision: runtimeWorldRevision("world", 1),
    })],
    ["Workbench carrying session", rawTarget({
      backend: "workbench", sessionId: "forbidden", instanceId: "wb-1",
      expectedWorldRevision: workbenchWorldRevision("world"),
    })],
    ["backend revision mismatch", rawTarget({
      backend: "workbench", instanceId: "wb-1",
      expectedWorldRevision: runtimeWorldRevision("world", 1),
    })],
    ["extra field", rawTarget({
      backend: "workbench", instanceId: "wb-1",
      expectedWorldRevision: workbenchWorldRevision("world"), authority: true,
    })],
  ])("rejects %s", (_label, target) => {
    expect(() => decodeCaptureTarget(target)).toThrowError(CaptureError);
  });

  it("rejects an oversized token before decoding", () => {
    expect(() => decodeCaptureTarget(`ct1.${"a".repeat(8_192)}`))
      .toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });
});
