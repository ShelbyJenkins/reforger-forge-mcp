import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OwnedRuntimeManager,
  type OwnedRuntimeObserverGate,
} from "../../../src/observer/owned-runtime-manager.js";
import type { ObserverLaunchInput, ObserverPreparedLaunch } from "../../../src/observer/launch.js";

const roots: string[] = [];
const retainedChildren: ChildProcess[] = [];

afterEach(() => {
  for (const child of retainedChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const readyGate: OwnedRuntimeObserverGate = {
  reserveRuntimeStop: async () => ({
    sessionKnown: true,
    ready: true,
    reserved: true,
    activeJobIds: [],
    cameraLeaseJobIds: [],
    restorationPendingJobIds: [],
  }),
  releaseRuntimeStop: async () => ({ released: true }),
  completeRuntimeStop: async () => ({ completed: true }),
};

describe.skipIf(process.platform !== "win32")("owned runtime native Windows integration", () => {
  it("inspects and terminates a harmless exact-owned fixture through retained native handles", async () => {
    const root = mkdtempSync(join(tmpdir(), "rfo-owned-runtime-native-"));
    roots.push(root);
    const manager = new OwnedRuntimeManager({
      managedRoot: root,
      gamePath: dirname(process.execPath),
      observerGate: readyGate,
      executableResolver: () => process.execPath,
      installationRoot: process.cwd(),
      spawnProcess: ((file: string, args: readonly string[], options: SpawnOptions) => {
        const child = spawn(file, [...args], options);
        retainedChildren.push(child);
        return child;
      }) as unknown as typeof spawn,
      inspectionTimeoutMs: 10_000,
      terminationTimeoutMs: 10_000,
    });
    const input: ObserverLaunchInput = {
      runtimeKind: "testRunner",
      // `--` makes the subsequently appended owner token a fixture argv value,
      // not a Node option. The child is only an inert event-loop process.
      arguments: ["-e", "setInterval(() => {}, 1000)", "--"],
      profilePath: join(root, "profile"),
      sessionTtlMs: 60_000,
      transportPreference: ["rest"],
      forceUpdate: false,
      idempotencyKey: "native-prepare",
    };
    const prepared: ObserverPreparedLaunch = {
      arguments: [...input.arguments],
      sessionId: "native-session",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      bundleDigest: "b".repeat(64),
      profilePath: input.profilePath,
      warnings: [],
    };
    const preparedLaunchId = await manager.recordPreparedLaunch(input, prepared);
    const started = await manager.start({ preparedLaunchId, idempotencyKey: "native-start" });
    expect(await manager.status(started.runtimeId)).toMatchObject({
      state: "running",
      exactOwned: true,
      pid: started.pid,
    });

    const stopped = await manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "native-stop",
    });
    expect(stopped).toMatchObject({
      state: "exited",
      termination: "terminated",
      identityVacant: true,
    });
  }, 30_000);
});
