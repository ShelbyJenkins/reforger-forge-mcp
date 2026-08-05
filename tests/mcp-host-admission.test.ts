import { describe, expect, it } from "vitest";
import {
  McpHostAdmissionError,
  McpHostAdmissionGate,
  type McpAdmissionRevisionSource,
} from "../src/mcp-host-admission.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settled) => { resolve = settled; });
  return { promise, resolve };
}

describe("MCP host admission gate", () => {
  it("tracks synchronous admission, release, and revision changes", () => {
    const gate = new McpHostAdmissionGate();
    expect(gate.snapshot()).toEqual({ state: "open", activeTokens: 0, revision: 0 });
    const first = gate.acquire("first operation");
    const second = gate.acquire("second operation");
    expect(gate.snapshot()).toEqual({ state: "open", activeTokens: 2, revision: 2 });
    first.release();
    first.release();
    second.release();
    expect(gate.snapshot()).toEqual({ state: "open", activeTokens: 0, revision: 4 });
  });

  it("holds run admission through the full async finally lifetime", async () => {
    const gate = new McpHostAdmissionGate();
    const work = deferred<number>();
    const running = gate.run("async work", () => work.promise);
    expect(gate.snapshot().activeTokens).toBe(1);
    work.resolve(42);
    await expect(running).resolves.toBe(42);
    expect(gate.snapshot().activeTokens).toBe(0);
  });

  it("transfers detached work without publishing a zero-token gap", () => {
    const gate = new McpHostAdmissionGate();
    const parent = gate.acquire("parent");
    const before = gate.snapshot().revision;
    const detached = parent.transfer("detached continuation");
    expect(parent.active).toBe(false);
    expect(detached.active).toBe(true);
    expect(gate.snapshot()).toMatchObject({ activeTokens: 1, revision: before + 1 });
    parent.release();
    expect(gate.snapshot().activeTokens).toBe(1);
    detached.release();
    expect(gate.snapshot().activeTokens).toBe(0);
  });

  it("seals only a fresh one-use proof with matching provider revisions", () => {
    const gate = new McpHostAdmissionGate();
    let revision = 7;
    const provider: McpAdmissionRevisionSource = { currentIdleRevision: () => revision };
    const stale = gate.issueIdleSealProof([{ source: provider, revision }]);
    revision += 1;
    expect(gate.trySealIdleAdmissions(stale)).toBe(false);
    expect(gate.snapshot().state).toBe("open");
    expect(gate.trySealIdleAdmissions(stale)).toBe(false);

    const fresh = gate.issueIdleSealProof([{ source: provider, revision }]);
    expect(gate.trySealIdleAdmissions(fresh)).toBe(true);
    expect(gate.snapshot().state).toBe("sealed");
    expect(gate.trySealIdleAdmissions(fresh)).toBe(false);
    expect(() => gate.acquire("late work")).toThrow(McpHostAdmissionError);
  });

  it("leaves the gate open when a token races a previously issued proof", () => {
    const gate = new McpHostAdmissionGate();
    const proof = gate.issueIdleSealProof([]);
    const raced = gate.acquire("same-turn race");
    expect(gate.trySealIdleAdmissions(proof)).toBe(false);
    expect(gate.snapshot().state).toBe("open");
    raced.release();
    expect(gate.acquire("subsequent work").active).toBe(true);
  });

  it("allows disposer-authorized cleanup after sealing", async () => {
    const gate = new McpHostAdmissionGate();
    expect(gate.trySealIdleAdmissions(gate.issueIdleSealProof([]))).toBe(true);
    await expect(gate.runPrivilegedCleanup(async () => "closed")).resolves.toBe("closed");
  });
});
