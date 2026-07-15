import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseJsonText,
  resolveWindowsInspectionFallback,
  WorkbenchProcessGuard,
  type WorkbenchOwnerMarker,
  type WorkbenchProcessIdentity,
  type WorkbenchProcessInspector,
} from "../../src/workbench/process-guard.js";

const tempRoots: string[] = [];

class FakeInspector implements WorkbenchProcessInspector {
  readonly identities = new Map<number, WorkbenchProcessIdentity>();
  readonly terminated: number[] = [];
  inspectionError: Error | null = null;

  async listWorkbenchProcesses(): Promise<WorkbenchProcessIdentity[]> {
    if (this.inspectionError) throw this.inspectionError;
    return [...this.identities.values()];
  }

  async inspectPid(pid: number): Promise<WorkbenchProcessIdentity | null> {
    if (this.inspectionError) throw this.inspectionError;
    return this.identities.get(pid) ?? null;
  }

  terminate(pid: number): boolean {
    this.terminated.push(pid);
    return this.identities.delete(pid);
  }
}

function createStateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "reforger-forge-process-guard-"));
  tempRoots.push(root);
  return root;
}

function createFixture(
  stateDir = createStateDir()
): {
  guard: WorkbenchProcessGuard;
  inspector: FakeInspector;
  identity: WorkbenchProcessIdentity;
  marker: WorkbenchOwnerMarker;
} {
  const inspector = new FakeInspector();
  const guard = new WorkbenchProcessGuard({ stateDir, inspector });
  const token = "de305d54-75b4-431b-adb2-eb6b9e546014";
  const executablePath = join(stateDir, "ArmaReforgerWorkbenchSteamDiag.exe");
  const identity: WorkbenchProcessIdentity = {
    pid: 42421,
    executablePath,
    commandLine: `"${executablePath}" ${guard.ownerArgument(token)}`,
    creationTimeMs: 1_750_000_000_000,
  };
  const marker: WorkbenchOwnerMarker = {
    version: 1,
    token,
    pid: identity.pid,
    executablePath,
    commandLineToken: guard.ownerArgument(token),
    creationTimeMs: identity.creationTimeMs,
    launchedAtMs: identity.creationTimeMs,
    gprojPath: join(stateDir, "RoadblockRunners.gproj"),
    host: "127.0.0.1",
    port: 5775,
  };
  inspector.identities.set(identity.pid, identity);
  return { guard, inspector, identity, marker };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("durable Workbench ownership", () => {
  it("recovers ownership in a new guard only when PID, executable, token, and start time match", async () => {
    const { guard, inspector, marker } = createFixture();
    guard.writeOwnerMarker(marker);

    const restartedGuard = new WorkbenchProcessGuard({
      stateDir: guard.stateDir,
      inspector,
    });

    await expect(restartedGuard.recoverOwnerMarker()).resolves.toEqual(marker);
    expect(inspector.terminated).toEqual([]);
  });

  it("rejects PID reuse, clears stale proof, and never terminates the replacement process", async () => {
    const { guard, inspector, identity, marker } = createFixture();
    guard.writeOwnerMarker(marker);
    inspector.identities.set(identity.pid, {
      ...identity,
      creationTimeMs: identity.creationTimeMs + 10_000,
      commandLine: `"${identity.executablePath}" -unrelatedProcess`,
    });

    await expect(guard.recoverOwnerMarker()).resolves.toBeNull();
    expect(guard.readOwnerMarker()).toBeNull();
    expect(inspector.terminated).toEqual([]);
  });

  it("terminates exactly the freshly reverified owned PID and confirms its exit", async () => {
    const { guard, inspector, marker } = createFixture();
    guard.writeOwnerMarker(marker);

    await expect(guard.terminateVerifiedOwner(marker, 250)).resolves.toBeUndefined();

    expect(inspector.terminated).toEqual([marker.pid]);
    expect(guard.readOwnerMarker()).toBeNull();
  });

  it("refuses termination when any process-instance proof no longer matches", async () => {
    const { guard, inspector, identity, marker } = createFixture();
    inspector.identities.set(identity.pid, {
      ...identity,
      commandLine: `"${identity.executablePath}" -differentOwner`,
    });

    await expect(guard.terminateVerifiedOwner(marker, 250)).rejects.toThrow(
      /Refusing to terminate PID/
    );
    expect(inspector.terminated).toEqual([]);
  });

  it("reads a PowerShell-style UTF-8 marker even if an older writer included a BOM", () => {
    const { guard, marker } = createFixture();
    writeFileSync(guard.ownerMarkerPath, `\uFEFF${JSON.stringify(marker)}\r\n`, "utf8");

    expect(guard.readOwnerMarker()).toEqual(marker);
    expect(parseJsonText("\uFEFF{\"version\":1}")).toEqual({ version: 1 });
  });
});

describe("machine-wide launch exclusion", () => {
  it("allows exactly one holder and fails a concurrent launcher within the bounded timeout", async () => {
    const stateDir = createStateDir();
    const first = new WorkbenchProcessGuard({ stateDir, lockTimeoutMs: 500 });
    const second = new WorkbenchProcessGuard({ stateDir, lockTimeoutMs: 40 });
    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    const entered = new Promise<void>((resolve) => { enterFirst = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const holding = first.withLaunchLock(async () => {
      enterFirst();
      await release;
    });
    await entered;

    await expect(second.withLaunchLock(async () => undefined)).rejects.toThrow(
      /Timed out waiting for the machine-wide Workbench launch lock/
    );
    releaseFirst();
    await expect(holding).resolves.toBeUndefined();
  });

  it("does not hang when an existing lock cannot be read or reclaimed", async () => {
    const stateDir = createStateDir();
    const guard = new WorkbenchProcessGuard({
      stateDir,
      lockTimeoutMs: 40,
      lockStaleMs: 0,
    });
    // A directory at the lock path makes open/stat/read/unlink take the same
    // adversarial error path as a locked or access-denied file on Windows.
    mkdirSync(guard.lockPath);
    const started = Date.now();

    await expect(guard.withLaunchLock(async () => undefined)).rejects.toThrow(
      /Timed out waiting/
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("never reclaims an old lock whose recorded holder PID is still alive", async () => {
    const stateDir = createStateDir();
    const guard = new WorkbenchProcessGuard({
      stateDir,
      lockTimeoutMs: 40,
      lockStaleMs: 0,
    });
    writeFileSync(guard.lockPath, JSON.stringify({ pid: process.pid, token: "live" }));
    const old = new Date(Date.now() - 10_000);
    utimesSync(guard.lockPath, old, old);

    await expect(guard.withLaunchLock(async () => undefined)).rejects.toThrow(/Timed out waiting/);
    expect(existsSync(guard.lockPath)).toBe(true);
    expect(readFileSync(guard.lockPath, "utf8")).toContain(`"pid":${process.pid}`);
  });
});

describe("fail-closed process inspection", () => {
  it("uses Get-Process fallback results to detect machine-wide duplicates", () => {
    const identity: WorkbenchProcessIdentity = {
      pid: 8080,
      executablePath: "C:\\Tools\\ArmaReforgerWorkbenchSteamDiag.exe",
      commandLine: "",
      creationTimeMs: 1234,
    };

    expect(resolveWindowsInspectionFallback(undefined, [identity], new Error("Access denied")))
      .toEqual([identity]);
  });

  it("never adopts or kills a PID when CIM denied command-line inspection", () => {
    const identity: WorkbenchProcessIdentity = {
      pid: 8080,
      executablePath: "C:\\Tools\\ArmaReforgerWorkbenchSteamDiag.exe",
      commandLine: "",
      creationTimeMs: 1234,
    };

    expect(() => resolveWindowsInspectionFallback(8080, [identity], new Error("Access denied")))
      .toThrow(/denied command-line inspection.*Refusing adoption or termination/);
  });

  it("propagates inspection failure instead of treating unknown state as absence", async () => {
    const inspector = new FakeInspector();
    inspector.inspectionError = new Error("process table access denied");
    const guard = new WorkbenchProcessGuard({ stateDir: createStateDir(), inspector });

    await expect(guard.assertNoWorkbenchProcesses()).rejects.toThrow(/access denied/);
  });
});
