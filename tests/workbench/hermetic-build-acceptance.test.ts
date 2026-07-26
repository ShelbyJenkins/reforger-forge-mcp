import type { SpawnOptions } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChildSupervisor } from "../../src/foundation/child-supervisor.js";
import {
  WorkbenchActivityGate,
  WorkbenchActivityError,
} from "../../src/workbench/activity-gate.js";
import {
  WORKBENCH_HELPER_ADDON_GUID,
  WORKBENCH_HELPER_ADDON_ID,
} from "../../src/workbench/helper-addon.js";
import { buildCliEditorLaunchPlan } from "../../src/workbench/launch-plan.js";
import type { CompanionReadinessOptions } from "../../src/workbench/readiness.js";
import { WORKBENCH_OWNER_ARG_PREFIX } from "../../src/workbench/process-guard.js";
import type {
  WorkbenchBuildReceipt,
} from "../../src/workbench/runner.js";
import { WorkbenchSessionController } from "../../src/workbench/session-controller.js";
import {
  createWorkbenchPolicyFixture,
  exerciseHermeticTargetPlan,
  FakeWorkbenchChild,
  type WorkbenchPolicyFixture,
} from "./workbench-policy-fixture.js";
import {
  closeTrackedWorkbenchProcessGuards,
  WorkbenchProcessGuard,
} from "./tracked-process-guard.js";

const fixtures: WorkbenchPolicyFixture[] = [];

function createFixture(): WorkbenchPolicyFixture {
  const fixture = createWorkbenchPolicyFixture();
  fixtures.push(fixture);
  return fixture;
}

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

afterEach(async () => {
  await closeTrackedWorkbenchProcessGuards();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

describe("hermetic target-build acceptance", () => {
  it("executes the target policy without helper activation, -run, NET calls, or child leaks", async () => {
    const fixture = createFixture();
    const plan = fixture.targetPlan(300_000);
    const startedAt = fixture.clock.now();
    const deadline = fixture.clock.deadlineAfter(plan.lifetime.timeoutMs);

    expect(plan).toMatchObject({
      kind: "target_build",
      window: "hidden",
      process: "foreground",
      helper: null,
      readiness: { kind: "none" },
      lifetime: {
        kind: "bounded_exit_and_output",
        timeoutMs: 300_000,
        absoluteDeadline: true,
      },
      spawnOptions: {
        detached: false,
        windowsHide: true,
        shell: false,
      },
    });
    expect(deadline).toBe(startedAt + 300_000);
    fixture.clock.advanceBy(125);
    expect(fixture.clock.remaining(deadline)).toBe(299_875);

    expect(plan.argv).toContain("-wbModule=ResourceManager");
    expect(plan.argv).toContain("-builddata");
    expect(plan.argv).not.toContain("-buildData");
    expect(plan.argv).not.toContain("-run");
    expect(plan.argv).not.toContain("-addons");
    expect(plan.argv).not.toContain(WORKBENCH_HELPER_ADDON_GUID);
    expect(plan.argv).not.toContain(WORKBENCH_HELPER_ADDON_ID);
    expect(plan.addonDirectories).not.toContain(fixture.companion.addonSearchRoot);
    expect(plan.argv).not.toContain(fixture.companion.addonDirectory);
    expect(plan.argv).not.toContain(fixture.companion.workbenchProfilePath);

    const evidence = await exerciseHermeticTargetPlan(fixture, plan);

    expect(evidence).toMatchObject({
      planKind: "target_build",
      targetAddon: plan.targetAddon,
      beforeOutput: { entries: [] },
      exit: { code: 0, signal: null },
    });
    expect(fixture.reservation.checks).toBe(1);
    expect(fixture.childFactory.spawns).toHaveLength(1);
    expect(fixture.netApi.calls).toEqual([]);
    expect(fixture.supervisor.counts()).toEqual({ active: 0, reconciling: 0, total: 0 });
    expect(fixture.trace.entries.map((entry) => entry.event)).toEqual([
      "output_revalidated",
      "spawn",
      "exit",
    ]);
  });

  it("refuses an occupied final output reservation before any target spawn", async () => {
    const fixture = createFixture();
    const plan = fixture.targetPlan();
    writeFileSync(`${fixture.outputPath}/raced-after-claim.txt`, "occupied");

    await expect(exerciseHermeticTargetPlan(fixture, plan)).rejects.toThrow(
      /reservation is no longer empty/
    );

    expect(fixture.reservation.checks).toBe(1);
    expect(fixture.childFactory.spawns).toHaveLength(0);
    expect(fixture.netApi.calls).toHaveLength(0);
    expect(fixture.supervisor.counts()).toEqual({ active: 0, reconciling: 0, total: 0 });
  });

  it("uses one helper-free build receipt that binds the target process", async () => {
    const fixture = createFixture();
    const plan = fixture.targetPlan();
    const evidence = await exerciseHermeticTargetPlan(fixture, plan);
    const receipt = {
      intent: "build",
      pid: evidence.process.pid,
      executablePath: evidence.process.executablePath,
      creationTime: "133900000000031000",
      target: plan.project.displayPath,
      targetAddon: { ...plan.targetAddon },
      lifecycleGeneration: "target-generation",
      processOwnership: "verified",
      endpointVacancy: "verified",
      logDirectory: "redacted-target-log",
      output: {
        root: fixture.outputPath,
        freshArtifactCount: 1,
        freshBytes: 64,
        resourceDatabasePath: `${fixture.outputPath}/resourceDatabase.rdb`,
        previousResourceDatabaseSha256: null,
        resourceDatabaseSha256: "a".repeat(64),
      },
      validationFailure: null,
      exitStatus: {
        reason: "exited",
        exitCode: 0,
        signal: null,
        timedOut: false,
      },
    } satisfies WorkbenchBuildReceipt;

    expect(receipt.pid).toBe(evidence.process.pid);
    expect(receipt.targetAddon).toEqual(plan.targetAddon);
    for (const receiptOnlyField of [
      "intent",
      "pid",
      "output",
      "exitStatus",
    ]) {
      expect(plan).not.toHaveProperty(receiptOnlyField);
    }
    expect(receipt).not.toHaveProperty("preflight");
    expect(receipt).not.toHaveProperty("companionIdentity");
    expect(receipt).not.toHaveProperty("version");
  });
});

describe("shared session-controller adapter trace", () => {
  it("preserves the shared durable spawn and cleanup transaction across all three policies", async () => {
    type Kind = "mcp_editor" | "cli_editor" | "target_build";
    const runAdapter = async (kind: Kind) => {
      const fixture = createFixture();
      const trace: string[] = [];
      const backend = fixture.backend;
      backend.beforeTerminate = () => { trace.push("process:terminate"); };
      const inspectProcess = backend.inspectProcess.bind(backend);
      backend.inspectProcess = async (...args) => {
        trace.push("process:inspect");
        return inspectProcess(...args);
      };
      let spawnObserved = false;
      let cleanupVacancyLag = 0;
      const verifyEndpointVacant = backend.verifyEndpointVacant.bind(backend);
      backend.verifyEndpointVacant = async (...args) => {
        trace.push("endpoint:vacant");
        if (kind !== "mcp_editor" && spawnObserved && backend.workbenchPids.size === 0 &&
            cleanupVacancyLag === 0) {
          cleanupVacancyLag += 1;
          return {
            kind: "occupied",
            listenerPid: 32_000,
            message: "socket release lags exact process absence by one probe",
          };
        }
        return verifyEndpointVacant(...args);
      };
      const verifyEndpointOwner = backend.verifyEndpointOwner.bind(backend);
      backend.verifyEndpointOwner = async (...args) => {
        trace.push("endpoint:owner");
        return verifyEndpointOwner(...args);
      };

      // A non-MCP child exits on its own, but only *after* the lifecycle has
      // been durably published for its policy. Keying the exit on the durable
      // write instead of a wall-clock timer keeps the expected trace ordering
      // deterministic regardless of how long durable publication takes.
      let releaseChild: (() => void) | null = null;
      let childReleased = false;
      const releaseChildOnce = (): void => {
        if (childReleased || !releaseChild) return;
        childReleased = true;
        setTimeout(releaseChild, 0);
      };

      const guard = new WorkbenchProcessGuard({
        backend,
        stateDir: join(fixture.root, `trace-${kind}`),
        mutexName: `Global\\ReforgerForge.Stage3Trace.${kind}.${fixture.root}`,
        beforeLifecycleReplace: ({ next }) => {
          trace.push(`state:${next.phase}:${next.workbench === null ? "unbound" : "bound"}`);
        },
        afterLifecycleReplace: ({ next }) => {
          if (kind === "cli_editor" && next.phase === "running") releaseChildOnce();
        },
        beforeSpawnJournalReplace: ({ next }) => {
          trace.push(`journal:${next.record.phase}`);
        },
        afterSpawnJournalReplace: ({ next }) => {
          if (kind === "target_build" && next.record.phase === "published") releaseChildOnce();
        },
      });
      const supervisor = new ChildSupervisor();
      const spawns: Array<{ argv: readonly string[]; options: Readonly<SpawnOptions> }> = [];
      const spawnProcess = (command: string, argv: readonly string[], options: SpawnOptions) => {
        const child = new FakeWorkbenchChild(32_000);
        const owner = argv.find((argument) => argument.startsWith(WORKBENCH_OWNER_ARG_PREFIX));
        if (!owner || spawns.length > 0) throw new Error("Trace adapter requires one owned spawn.");
        backend.addWorkbench({
          pid: child.pid,
          executablePath: command,
          creationTime: "133900000000032000",
        }, owner);
        spawnObserved = true;
        spawns.push({ argv: Object.freeze([...argv]), options: Object.freeze({ ...options }) });
        trace.push(`spawn:${kind}`);
        if (kind !== "mcp_editor") {
          releaseChild = () => {
            backend.processes.delete(child.pid);
            backend.workbenchPids.delete(child.pid);
            trace.push("child:exit");
            child.finish(0);
          };
        }
        return child.asChildProcess();
      };
      const readiness = async (options: CompanionReadinessOptions) => {
        trace.push("readiness:start");
        expect(await options.verifyEndpointOwner(options.endpoint, options.process))
          .toMatchObject({ kind: "owned" });
        await options.netApi.call("EMCP_WB_Ping", {}, { timeoutMs: 100 });
        await options.attestCompanion();
        trace.push("readiness:qualified");
        const helper = options.companion;
        return {
          addonId: helper.addonId, addonGuid: helper.addonGuid,
          addonVersion: helper.addonVersion, protocolVersion: helper.protocolVersion,
          workbenchProtocol: helper.protocolVersion, buildIdentity: helper.buildIdentity,
          bundleDigest: helper.bundleDigest,
        };
      };
      const lifecycleExecution = WorkbenchSessionController.composeLifecycleExecution({
        processGuard: guard, childSupervisor: supervisor, spawnProcess,
      });
      const controller = new WorkbenchSessionController(
        fixture.config.workbenchHost,
        fixture.config.workbenchPort,
        fixture.config,
        `stage3-trace-${kind}`,
        guard,
        {
          companionProvider: fixture.companionProvider,
          netApi: fixture.netApi,
          companionReadiness: readiness,
          childSupervisor: supervisor,
          lifecycleExecution,
        }
      );
      const verifyStaged = fixture.companionProvider.verifyStaged!;
      let exitCode: number | null = null;
      if (kind === "mcp_editor") {
        expect(await controller.ensureRunning(fixture.projectPath)).toMatchObject({ action: "launched" });
        await controller.shutdownOwnedWorkbench();
      } else if (kind === "cli_editor") {
        const plan = buildCliEditorLaunchPlan({
          kind,
          config: fixture.config,
          project: fixture.project,
          companion: fixture.companion,
          endpoint: { host: fixture.config.workbenchHost, port: fixture.config.workbenchPort },
          ownerArgument: controller.createPlanOwnerCredential().argument,
          managedRoot: fixture.managedRoot,
        });
        exitCode = (await controller.runForegroundEditor(plan, {
          qualify: (context) => controller.qualifyCompanion(context, {
            netApi: fixture.netApi,
            attestCompanion: () => verifyStaged(fixture.companion, fixture.projectPath),
            deadlineMs: Date.now() + 1_000,
            pollIntervalMs: 1,
          }),
          terminationTimeoutMs: 50,
          recoveryTimeoutMs: 50,
        })).exitStatus.exitCode;
      } else {
        const reservation = {
          root: fixture.outputPath,
          assertStillReservedAndSnapshot: () => {
            trace.push("output:revalidated");
            return fixture.reservation.assertStillReservedAndSnapshot();
          },
        };
        exitCode = (await controller.runTargetBuild(fixture.targetPlan(1_000), reservation, {
          deadlineMs: Date.now() + 1_000,
          terminationTimeoutMs: 50,
          recoveryTimeoutMs: 50,
        })).exitStatus.exitCode;
      }
      const lifecycle = await guard.readLifecycleState();
      expect(lifecycle).toMatchObject({
        kind: "valid",
        state: { phase: "vacant", workbench: null, operation: null },
      });
      expect(supervisor.counts()).toEqual({ active: 0, reconciling: 0, total: 0 });
      const spawn = spawns[0];
      if (!spawn) throw new Error("Trace adapter did not spawn Workbench.");
      return { trace, spawn, exitCode, fixture, cleanupVacancyLag };
    };

    const expectOrdered = (kind: Kind, trace: readonly string[], expected: readonly string[]) => {
      let cursor = -1;
      for (const event of expected) {
        const next = trace.indexOf(event, cursor + 1);
        expect(next, `${kind} trace omitted or reordered ${event}: ${trace.join(" -> ")}`)
          .toBeGreaterThan(cursor);
        cursor = next;
      }
    };

    for (const kind of ["mcp_editor", "cli_editor", "target_build"] as const) {
      const { trace, spawn, exitCode, fixture, cleanupVacancyLag } = await runAdapter(kind);
      expectOrdered(kind, trace, [
        "state:starting:unbound",
        "journal:pre_spawn",
        `spawn:${kind}`,
        "journal:spawned_unverified",
        "process:inspect",
        "journal:identity_verified",
        "state:starting:bound",
        "journal:published",
        "state:stopping:bound",
        "endpoint:vacant",
        "state:vacant:unbound",
      ]);
      const editor = kind !== "target_build";
      expect(spawn.argv.includes("-addons")).toBe(editor);
      expect(spawn.argv.includes("-run")).toBe(kind === "cli_editor");
      expect(spawn.argv.includes("-builddata")).toBe(kind === "target_build");
      expect(spawn.options).toMatchObject({
        detached: kind === "mcp_editor",
        windowsHide: kind === "target_build",
        shell: false,
      });
      expect(exitCode).toBe(kind === "mcp_editor" ? null : 0);
      expect(fixture.netApi.calls).toHaveLength(editor ? 1 : 0);
      expect(fixture.backend.endpointOwnershipCalls).toHaveLength(editor ? 1 : 0);
      expect(fixture.reservation.checks).toBe(kind === "target_build" ? 3 : 0);
      expect(cleanupVacancyLag).toBe(kind === "mcp_editor" ? 0 : 1);
      if (editor) {
        expectOrdered(kind, trace, [
          "journal:published", "readiness:start", "endpoint:owner",
          "readiness:qualified", "state:running:bound",
        ]);
        expectOrdered(kind, trace, kind === "mcp_editor"
          ? ["state:running:bound", "state:stopping:bound", "process:terminate"]
          : ["state:running:bound", "child:exit", "state:stopping:bound"]);
      }
      else {
        expect(trace).not.toContain("readiness:start");
        expectOrdered(kind, trace, [
          "output:revalidated",
          "state:starting:unbound",
          "output:revalidated",
          "journal:pre_spawn",
          "output:revalidated",
          "spawn:target_build",
          "child:exit",
          "state:stopping:bound",
        ]);
      }
    }
  });
});

describe("hermetic arbitration acceptance", () => {
  it("preserves writer priority and remains reusable after reader drain and writer failure", async () => {
    const gate = new WorkbenchActivityGate({ restoreTimeoutMs: 1_000 });
    const releaseFirstReader = deferred();
    const releaseWriter = deferred();
    const trace: string[] = [];
    const firstReader = gate.runManaged("first reader", async () => {
      trace.push("reader:start");
      await releaseFirstReader.promise;
      trace.push("reader:end");
    });
    const writer = gate.runLifecycle("restart", async () => {
      trace.push("writer:start");
      await releaseWriter.promise;
      trace.push("writer:end");
    });

    await expect(gate.runManaged("late reader", async () => undefined)).rejects.toMatchObject({
      code: "LIFECYCLE_BUSY",
    });
    releaseFirstReader.resolve();
    await firstReader;
    await vi.waitFor(() => expect(trace).toContain("writer:start"));
    await expect(gate.runManaged("reader during writer", async () => undefined)).rejects
      .toMatchObject({ code: "LIFECYCLE_BUSY" });
    releaseWriter.resolve();
    await writer;

    await expect(gate.runLifecycle("failing restart", async () => {
      throw new Error("injected lifecycle failure");
    })).rejects.toThrow(/injected lifecycle failure/);
    await expect(gate.runManaged("post-failure reader", async () => "admitted"))
      .resolves.toBe("admitted");
    await expect(gate.runLifecycle("post-failure writer", async () => "admitted"))
      .resolves.toBe("admitted");
    expect(trace).toEqual(["reader:start", "reader:end", "writer:start", "writer:end"]);
  });

  it("removes a cancelled writer without leaving reader admission blocked", async () => {
    const gate = new WorkbenchActivityGate({ restoreTimeoutMs: 1_000 });
    const releaseReader = deferred();
    const activeReader = gate.runManaged("blocking reader", async () => releaseReader.promise);
    const abort = new AbortController();
    const cancelledWriter = gate.runLifecycle(
      "shutdown",
      async () => undefined,
      { signal: abort.signal }
    );

    abort.abort();
    await expect(cancelledWriter).rejects.toBeInstanceOf(WorkbenchActivityError);
    await expect(gate.runManaged("reader after cancellation", async () => "admitted"))
      .resolves.toBe("admitted");
    releaseReader.resolve();
    await activeReader;
    await expect(gate.runLifecycle("writer after cancellation", async () => "admitted"))
      .resolves.toBe("admitted");
  });
});

describe("hermetic child-supervision acceptance", () => {
  it("drains listeners and bounded reconciliation after terminal failure", async () => {
    const supervisor = new ChildSupervisor({
      reconciliationAttempts: 2,
      reconciliationRetryMs: 0,
    });
    const child = new FakeWorkbenchChild(41_000);
    const callbackErrors: unknown[] = [];
    const reconcile = vi.fn().mockRejectedValue(new Error("injected CAS outage"));
    const handle = supervisor.supervise("target-build", child.asChildProcess(), {
      onExit: reconcile,
      onCallbackError: (error) => callbackErrors.push(error),
    });

    child.finish(1);
    await expect(handle.terminal).resolves.toEqual({
      kind: "exit",
      exit: { code: 1, signal: null },
    });
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      expect(supervisor.counts()).toEqual({ active: 0, reconciling: 0, total: 0 });
    });

    expect(callbackErrors).toHaveLength(2);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);

    const nextChild = new FakeWorkbenchChild(41_001);
    const nextHandle = supervisor.supervise("target-build", nextChild.asChildProcess());
    nextChild.finish(0);
    await expect(nextHandle.exit).resolves.toEqual({ code: 0, signal: null });
    expect(supervisor.counts()).toEqual({ active: 0, reconciling: 0, total: 0 });
  });
});
