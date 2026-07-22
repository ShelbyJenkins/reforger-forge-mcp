import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { ExactProcessInspection } from "../../src/foundation/exact-process-backend.js";
import type {
  WorkbenchNetApiCallOptions,
  WorkbenchNetApiPort,
} from "../../src/workbench/net-api-client.js";
import {
  FixtureOnlyWorkbenchNetApiFaultPort,
  FixtureWorkbenchHandlerLossError,
  WORKBENCH_FAILURE_PNG_MAX_BYTES,
  WorkbenchPngMutationError,
  compareWorkbenchDecoyIdentity,
  createOneShotWorkbenchPngArtifactHook,
  extractFixtureWorkbenchHandlerLoss,
  mutateWorkbenchPngArtifact,
  mutateWorkbenchPngBytes,
  type WorkbenchHandlerLossPlan,
} from "../../scripts/observer-workbench-failure-support.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

interface RecordedCall {
  readonly apiFunc: string;
  readonly params: Record<string, unknown>;
  readonly options: WorkbenchNetApiCallOptions | undefined;
}

class DelegatePort implements WorkbenchNetApiPort {
  readonly calls: RecordedCall[] = [];

  constructor(
    private readonly invoke: (
      apiFunc: string,
      params: Record<string, unknown>,
      options: WorkbenchNetApiCallOptions | undefined,
      callIndex: number
    ) => Promise<unknown> | unknown = () => ({ status: "real" })
  ) {}

  async call<T = Record<string, unknown>>(
    apiFunc: string,
    params: Record<string, unknown> = {},
    options?: WorkbenchNetApiCallOptions
  ): Promise<T> {
    this.calls.push({ apiFunc, params, options });
    return await this.invoke(apiFunc, params, options, this.calls.length - 1) as T;
  }
}

describe("FixtureOnlyWorkbenchNetApiFaultPort", () => {
  it("routes every argument and the delegate's real response unchanged while inactive", async () => {
    const realResponse = Object.freeze({ status: "ok", sequence: 7 });
    const delegate = new DelegatePort(() => realResponse);
    const port = new FixtureOnlyWorkbenchNetApiFaultPort(delegate);
    const params = { jobId: "job-1" };
    const options = { timeoutMs: 321, responseCapBytes: 654 };

    const response = await port.call("EMCP_WB_ObserverStatus", params, options);

    expect(response).toBe(realResponse);
    expect(delegate.calls).toHaveLength(1);
    expect(delegate.calls[0]?.params).toBe(params);
    expect(delegate.calls[0]?.options).toBe(options);
    expect(port.result()).toEqual({ category: "inactive", faultInjected: false });
  });

  it("loses exactly the first matching request without invoking the delegate", async () => {
    const delegate = new DelegatePort();
    const port = new FixtureOnlyWorkbenchNetApiFaultPort(delegate);
    port.armOneShotLoss({
      handler: "EMCP_WB_ObserverStatus",
      boundary: "request",
      matchParams: { jobId: "selected-job", sequence: 4 },
    });

    await expect(port.call("EMCP_WB_ObserverPing", {})).resolves.toEqual({ status: "real" });
    await expect(port.call("EMCP_WB_ObserverStatus", {
      jobId: "other-job",
      sequence: 4,
    })).resolves.toEqual({ status: "real" });
    expect(port.result()).toEqual({ category: "armed", faultInjected: false });

    let thrown: unknown;
    try {
      await port.call("EMCP_WB_ObserverStatus", {
        jobId: "selected-job",
        sequence: 4,
        unrelated: "allowed",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FixtureWorkbenchHandlerLossError);
    expect((thrown as FixtureWorkbenchHandlerLossError).code).toBe("timeout");
    expect(extractFixtureWorkbenchHandlerLoss(thrown)).toEqual({
      category: "handler_request_lost",
    });
    expect(delegate.calls).toHaveLength(2);
    expect(port.result()).toEqual({
      category: "handler_request_lost",
      faultInjected: true,
    });

    await expect(port.call("EMCP_WB_ObserverStatus", {
      jobId: "selected-job",
      sequence: 4,
    })).resolves.toEqual({ status: "real" });
    expect(delegate.calls).toHaveLength(3);
  });

  it("snapshots matching fields and refuses to arm a second loss", async () => {
    const delegate = new DelegatePort();
    const port = new FixtureOnlyWorkbenchNetApiFaultPort(delegate);
    const mutableMatch: Record<string, string> = { jobId: "original" };
    port.armOneShotLoss({
      handler: "EMCP_WB_ObserverCancel",
      boundary: "request",
      matchParams: mutableMatch,
    });
    mutableMatch.jobId = "mutated";

    await expect(port.call("EMCP_WB_ObserverCancel", { jobId: "mutated" }))
      .resolves.toEqual({ status: "real" });
    await expect(port.call("EMCP_WB_ObserverCancel", { jobId: "original" }))
      .rejects.toMatchObject({ category: "handler_request_lost" });
    expect(() => port.armOneShotLoss({
      handler: "EMCP_WB_ObserverStatus",
      boundary: "response",
    })).toThrow(/already armed/);
  });

  it("delivers a real request then discards exactly one successful response", async () => {
    const realResponse = Object.freeze({ status: "ok", state: "completed" });
    const delegate = new DelegatePort(() => realResponse);
    const port = new FixtureOnlyWorkbenchNetApiFaultPort(delegate);
    port.armOneShotLoss({
      handler: "EMCP_WB_ObserverStatus",
      boundary: "response",
    });

    await expect(port.call("EMCP_WB_ObserverStatus", { jobId: "job-1" }))
      .rejects.toMatchObject({
        code: "timeout",
        category: "handler_response_lost",
      });
    expect(delegate.calls).toHaveLength(1);
    expect(port.result()).toEqual({
      category: "handler_response_lost",
      faultInjected: true,
    });

    await expect(port.call("EMCP_WB_ObserverStatus", { jobId: "job-1" }))
      .resolves.toBe(realResponse);
    expect(delegate.calls).toHaveLength(2);
  });

  it("atomically consumes a response loss before a concurrent matching call", async () => {
    let releaseFirst!: (value: unknown) => void;
    const firstResponse = new Promise<unknown>((resolve) => { releaseFirst = resolve; });
    const delegate = new DelegatePort((_api, _params, _options, callIndex) =>
      callIndex === 0 ? firstResponse : { status: "second-real-response" }
    );
    const port = new FixtureOnlyWorkbenchNetApiFaultPort(delegate);
    port.armOneShotLoss({
      handler: "EMCP_WB_ObserverStatus",
      boundary: "response",
      matchParams: { jobId: "same-job" },
    });

    const first = port.call("EMCP_WB_ObserverStatus", { jobId: "same-job" });
    expect(port.result()).toEqual({ category: "response_pending", faultInjected: false });
    const second = port.call("EMCP_WB_ObserverStatus", { jobId: "same-job" });
    await expect(second).resolves.toEqual({ status: "second-real-response" });
    releaseFirst({ status: "first-real-response" });
    await expect(first).rejects.toMatchObject({ category: "handler_response_lost" });
    expect(delegate.calls).toHaveLength(2);
  });

  it("preserves a delegate failure and does not claim that response loss occurred", async () => {
    const delegateError = new Error("delegate transport failed");
    const delegate = new DelegatePort(() => { throw delegateError; });
    const port = new FixtureOnlyWorkbenchNetApiFaultPort(delegate);
    port.armOneShotLoss({
      handler: "EMCP_WB_ObserverRelease",
      boundary: "response",
    });

    await expect(port.call("EMCP_WB_ObserverRelease", {})).rejects.toBe(delegateError);
    expect(port.result()).toEqual({ category: "delegate_failed", faultInjected: false });
    expect(extractFixtureWorkbenchHandlerLoss(delegateError)).toBeNull();
  });

  it("rejects broad, malformed, and mutable re-arming plans", () => {
    const port = new FixtureOnlyWorkbenchNetApiFaultPort(new DelegatePort());
    expect(() => port.armOneShotLoss({
      handler: "EMCP_WB_ExecuteAction",
      boundary: "request",
    } as unknown as WorkbenchHandlerLossPlan)).toThrow(/known observer handler/);
    expect(() => port.armOneShotLoss({
      handler: "EMCP_WB_ObserverStatus",
      boundary: "request",
      matchParams: { jobId: "x".repeat(513) },
    })).toThrow(/bounded scalar/);

    const tooMany = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`field${index}`, index])
    );
    expect(() => port.armOneShotLoss({
      handler: "EMCP_WB_ObserverStatus",
      boundary: "request",
      matchParams: tooMany,
    })).toThrow(/limited to 16/);
    expect(port.result()).toEqual({ category: "inactive", faultInjected: false });
  });

  it("returns immutable, handler-name-free result and extraction records", async () => {
    const port = new FixtureOnlyWorkbenchNetApiFaultPort(new DelegatePort());
    port.armOneShotLoss({
      handler: "EMCP_WB_ObserverSubmit",
      boundary: "request",
      matchParams: { jobId: "private-job-identity" },
    });
    let error: unknown;
    try {
      await port.call("EMCP_WB_ObserverSubmit", { jobId: "private-job-identity" });
    } catch (candidate) {
      error = candidate;
    }
    const result = port.result();
    const extracted = extractFixtureWorkbenchHandlerLoss(error);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(extracted)).toBe(true);
    expect(JSON.stringify({ result, extracted })).not.toMatch(
      /private-job-identity|EMCP_WB_ObserverSubmit/
    );
  });
});

function testCrc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, body: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + body.length);
  result.writeUInt32BE(body.length, 0);
  typeBytes.copy(result, 4);
  body.copy(result, 8);
  result.writeUInt32BE(testCrc32(Buffer.concat([typeBytes, body])), 8 + body.length);
  return result;
}

function validPng(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 10, 20, 30]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

interface ParsedTestChunk {
  readonly type: string;
  readonly crcOffset: number;
  readonly crcValid: boolean;
}

function parseTestPng(bytes: Buffer): ParsedTestChunk[] {
  const chunks: ParsedTestChunk[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) throw new Error("truncated test PNG");
    const length = bytes.readUInt32BE(offset);
    const typeOffset = offset + 4;
    const bodyOffset = offset + 8;
    const crcOffset = bodyOffset + length;
    if (crcOffset + 4 > bytes.length) throw new Error("truncated test PNG");
    chunks.push({
      type: bytes.subarray(typeOffset, bodyOffset).toString("ascii"),
      crcOffset,
      crcValid: bytes.readUInt32BE(crcOffset) === testCrc32(bytes.subarray(typeOffset, crcOffset)),
    });
    offset = crcOffset + 4;
  }
  return chunks;
}

describe("bounded Workbench PNG fault mutations", () => {
  it("truncates one byte from a previously valid PNG without mutating the source", () => {
    const source = validPng();
    const snapshot = Buffer.from(source);
    const mutated = mutateWorkbenchPngBytes(source, "truncated");

    expect(source).toEqual(snapshot);
    expect(mutated).toEqual(source.subarray(0, source.length - 1));
    expect(() => parseTestPng(mutated)).toThrow(/truncated/);
  });

  it("corrupts exactly one IDAT CRC byte while preserving all image bytes and length", () => {
    const source = validPng();
    const chunks = parseTestPng(source);
    const idat = chunks.find((chunk) => chunk.type === "IDAT");
    expect(idat).toBeDefined();

    const mutated = mutateWorkbenchPngBytes(source, "crc_corruption");
    const differingOffsets = [...source.keys()].filter((offset) => source[offset] !== mutated[offset]);
    expect(mutated).toHaveLength(source.length);
    expect(differingOffsets).toEqual([idat!.crcOffset]);
    expect(parseTestPng(mutated).find((chunk) => chunk.type === "IDAT")?.crcValid).toBe(false);
    expect(source).toEqual(validPng());
  });

  it("creates an exact one-byte length mismatch with an otherwise unchanged PNG prefix", () => {
    const source = validPng();
    const mutated = mutateWorkbenchPngBytes(source, "byte_length_mismatch");

    expect(mutated).toHaveLength(source.length + 1);
    expect(mutated.subarray(0, source.length)).toEqual(source);
    expect(mutated.at(-1)).toBe(0);
  });

  it("requires a complete, CRC-valid source before applying any mutation", () => {
    const source = validPng();
    const alreadyCorrupt = Buffer.from(source);
    const idat = parseTestPng(alreadyCorrupt).find((chunk) => chunk.type === "IDAT")!;
    alreadyCorrupt[idat.crcOffset] ^= 1;

    expect(() => mutateWorkbenchPngBytes(Buffer.from("not-a-png"), "truncated"))
      .toThrow(WorkbenchPngMutationError);
    expect(() => mutateWorkbenchPngBytes(alreadyCorrupt, "truncated"))
      .toThrow(/already contains a corrupt/);
    expect(() => mutateWorkbenchPngBytes(
      Buffer.concat([source, Buffer.from([1])]),
      "crc_corruption"
    )).toThrow(/IEND or trailing/);
  });

  it("enforces both the hard cap and a caller-lowered output bound", () => {
    const source = validPng();
    expect(() => mutateWorkbenchPngBytes(source, "byte_length_mismatch", {
      maxBytes: source.length,
    })).toThrow(/would exceed/);
    expect(() => mutateWorkbenchPngBytes(source, "truncated", {
      maxBytes: 44,
    })).toThrow(/45 bytes/);
    expect(() => mutateWorkbenchPngBytes(source, "truncated", {
      maxBytes: WORKBENCH_FAILURE_PNG_MAX_BYTES + 1,
    })).toThrow(/64 MiB/);
    expect(() => mutateWorkbenchPngBytes(
      source,
      "unknown" as never
    )).toThrow(/kind is unknown/);
  });

  it("mutates the real reported file through a sanitized pre-validation result", async () => {
    await withTemporaryDirectory((root) => {
      const path = join(root, "job-1.png");
      const source = validPng();
      writeFileSync(path, source);

      const result = mutateWorkbenchPngArtifact({
        artifactPath: path,
        artifactBytes: source.length,
      }, "crc_corruption");

      expect(result).toEqual({
        mutation: "crc_corruption",
        originalByteLength: source.length,
        mutatedByteLength: source.length,
        byteLengthChanged: false,
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(path);
      expect(parseTestPng(readFileSync(path)).find((chunk) => chunk.type === "IDAT")?.crcValid)
        .toBe(false);
    });
  });

  it("provides a one-shot hook and records a physical byte-length change", async () => {
    await withTemporaryDirectory((root) => {
      const path = join(root, "job-2.png");
      const source = validPng();
      writeFileSync(path, source);
      const hook = createOneShotWorkbenchPngArtifactHook("byte_length_mismatch");

      expect(hook({ artifactPath: path, artifactBytes: source.length })).toEqual({
        mutation: "byte_length_mismatch",
        originalByteLength: source.length,
        mutatedByteLength: source.length + 1,
        byteLengthChanged: true,
      });
      expect(readFileSync(path)).toHaveLength(source.length + 1);
      expect(() => hook({ artifactPath: path, artifactBytes: source.length + 1 }))
        .toThrowError(expect.objectContaining({ category: "hook_already_used" }));
    });
  });

  it("refuses stale handler length, relative paths, and non-files before writing", async () => {
    await withTemporaryDirectory((root) => {
      const path = join(root, "job-3.png");
      const source = validPng();
      writeFileSync(path, source);
      expect(() => mutateWorkbenchPngArtifact({
        artifactPath: path,
        artifactBytes: source.length + 1,
      }, "truncated")).toThrowError(expect.objectContaining({ category: "artifact_changed" }));
      expect(readFileSync(path)).toEqual(source);

      expect(() => mutateWorkbenchPngArtifact({
        artifactPath: "relative.png",
        artifactBytes: source.length,
      }, "truncated")).toThrowError(expect.objectContaining({ category: "invalid_input" }));

      const directory = join(root, "directory.png");
      mkdirSync(directory);
      expect(() => mutateWorkbenchPngArtifact({
        artifactPath: directory,
        artifactBytes: source.length,
      }, "truncated")).toThrowError(expect.objectContaining({ category: "invalid_input" }));
    });
  });
});

function inspection(
  overrides: Partial<ExactProcessInspection["identity"]> = {},
  ownerArgumentMatched: boolean | null = true
): ExactProcessInspection {
  return {
    identity: {
      pid: 42_424,
      executablePath: "C:\\Program Files\\nodejs\\node.exe",
      creationTime: "133700000000000000",
      ...overrides,
    },
    ownerArgumentMatched,
  };
}

describe("compareWorkbenchDecoyIdentity", () => {
  it("requires the full exact identity while normalizing Windows path syntax", () => {
    const result = compareWorkbenchDecoyIdentity(
      inspection(),
      inspection({ executablePath: "c:/PROGRAM FILES/nodejs/.\\node.exe" })
    );

    expect(result).toEqual({ category: "unchanged", identityUnchanged: true });
    expect(Object.keys(result).sort()).toEqual(["category", "identityUnchanged"]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ["pid", inspection(), inspection({ pid: 42_425 }), "pid_changed"],
    ["path", inspection(), inspection({ executablePath: "C:\\Other\\node.exe" }), "executable_path_changed"],
    ["creation time", inspection(), inspection({ creationTime: "133700000000000001" }), "creation_time_changed"],
  ] as const)("rejects a changed %s", (_label, before, after, category) => {
    expect(compareWorkbenchDecoyIdentity(before, after)).toEqual({
      category,
      identityUnchanged: false,
    });
  });

  it.each([
    [null, inspection(), "before_absent"],
    [inspection(), null, "after_absent"],
    [inspection({}, false), inspection(), "before_owner_unverified"],
    [inspection(), inspection({}, null), "after_owner_unverified"],
  ] as const)("fails closed for incomplete inspection proof %#", (before, after, category) => {
    expect(compareWorkbenchDecoyIdentity(before, after)).toEqual({
      category,
      identityUnchanged: false,
    });
  });

  it("rejects malformed identity fields on either side", () => {
    const malformedBefore = inspection({ pid: 0 });
    const malformedAfter = inspection({ executablePath: "relative\\node.exe" });
    expect(compareWorkbenchDecoyIdentity(malformedBefore, inspection())).toEqual({
      category: "before_identity_invalid",
      identityUnchanged: false,
    });
    expect(compareWorkbenchDecoyIdentity(inspection(), malformedAfter)).toEqual({
      category: "after_identity_invalid",
      identityUnchanged: false,
    });
  });

  it("serializes no PID, path, creation time, or owner argument material", () => {
    const result = compareWorkbenchDecoyIdentity(
      inspection(),
      inspection({ executablePath: "C:\\private-user\\replacement.exe" })
    );
    const serialized = JSON.stringify(result);

    expect(serialized).toBe(
      '{"category":"executable_path_changed","identityUnchanged":false}'
    );
    for (const sensitive of [
      "42424",
      "private-user",
      "133700000000000000",
      "ownerArgumentMatched",
      "executablePath",
      "creationTime",
    ]) {
      expect(serialized).not.toContain(sensitive);
    }
  });
});

describe("fixture-only Workbench shutdown decoy", () => {
  it("retains a unique owner argument and exits only through its generated sentinel", () => {
    const source = readFileSync(
      join("tests", "fixtures", "workbench-observer-failure-matrix-decoy.mjs"),
      "utf8"
    );
    expect(source).toContain('option("--owner")');
    expect(source).toContain('option("--exit-sentinel")');
    expect(source).toContain('if (existsSync(exitSentinel)) process.exit(0)');
    expect(source).toContain('process.on("SIGINT", () => undefined)');
    expect(source).toContain('process.on("SIGTERM", () => undefined)');
    expect(source).not.toMatch(/child\.kill|taskkill|Stop-Process|KillProcess/i);
  });
});
