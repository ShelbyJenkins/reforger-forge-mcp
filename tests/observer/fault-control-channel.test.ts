import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { defineFaultMatrix, type FaultMatrixCase } from "../../observer/protocol/fault-matrix.js";
import {
  FaultControlAuthorizer,
  FaultControlError,
  FaultMatrixScheduler,
  FilesystemFaultControlMailbox,
  InMemoryFaultControlMailbox,
  createOwnedFaultControlRoot,
  faultControlFilename,
  type FaultControlAcknowledgement,
  type FaultControlBootstrap,
} from "../../scripts/observer-fault-matrix-support.js";
import { ManualTime } from "../support/manual-time.js";

function matrixCase(): FaultMatrixCase {
  return {
    schemaVersion: 1,
    id: "runtime.cancel_capture.lease_acquired.current",
    backend: "runtime",
    view: "current",
    injection: { phase: "lease_acquired", action: "cancel_capture" },
    phaseSupport: Object.fromEntries([
      "before_lease", "lease_acquired", "capture_in_progress", "restoration_in_progress", "terminal_release",
    ].map((phase) => [phase, {
      kind: "observable", publicStatusPredicate: `public ${phase}`, fixtureAcknowledgement: `fixture ${phase}`,
    }])) as FaultMatrixCase["phaseSupport"],
    expectedTerminal: { state: "cancelled", errorCode: null },
    cameraDisposition: "restored",
    requiredChecks: ["lifecycle_vacant"],
    requiredEvidence: ["public_terminal"],
  };
}

function acknowledgement(command: any, kind: FaultControlAcknowledgement["kind"]): FaultControlAcknowledgement {
  return {
    schemaVersion: 1,
    kind,
    requestId: command.requestId,
    caseId: command.caseId,
    phase: command.phase,
    disposition: kind,
    reason: null,
  } as FaultControlAcknowledgement;
}

describe("local observer fault-control channel", () => {
  it("authorizes only the bound per-run filename, run, fixture, lifecycle, and matrix", () => {
    const capability = randomUUID();
    const binding = { fixtureId: "fixture-1", lifecycleId: "life-1", lifecycleGeneration: "gen-1" };
    const bootstrap: FaultControlBootstrap = {
      schemaVersion: 1, runId: "run-1", backend: "runtime", capability,
      fixtureContentIdentity: "fixture-content", generatedProjectIdentity: "project", generatedAddonIdentity: "addon", binding,
    };
    const authorizer = new FaultControlAuthorizer({
      matrix: defineFaultMatrix([matrixCase()]), bootstrap, readLifecycleBinding: () => binding,
    });
    const command = {
      schemaVersion: 1, kind: "arm", runId: "run-1", requestId: randomUUID(),
      caseId: "runtime.cancel_capture.lease_acquired.current", phase: "lease_acquired", action: "cancel_capture", binding,
    };
    const filename = faultControlFilename(1, capability);
    const raw = JSON.stringify(command);
    const accepted = authorizer.authorize(filename, raw);
    expect(accepted.accepted).toBe(true);
    const arrived = acknowledgement(command, "arrived");
    authorizer.remember(accepted.command!, raw, arrived);
    // The same sequence is refused even when its request and body are a valid
    // logical replay. A resend needs a fresh mailbox filename.
    expect(authorizer.authorize(filename, raw).reason).toBe("REPLAY_REFUSED");
    expect(authorizer.authorize(faultControlFilename(2, capability), raw).replay).toEqual(arrived);
    expect(authorizer.authorize(faultControlFilename(3, capability), JSON.stringify({ ...command, kind: "cancel" })).reason)
      .toBe("REPLAY_REFUSED");
    // The capability mismatch happens before malformed JSON is examined.
    expect(authorizer.authorize("000000000004-00000000-0000-4000-8000-000000000000.json", "not-json").reason)
      .toBe("CAPABILITY_MISMATCH");
    expect(authorizer.authorize(faultControlFilename(4, capability), JSON.stringify({ ...command, runId: "other" })).reason)
      .toBe("RUN_MISMATCH");
    expect(authorizer.authorize(faultControlFilename(5, capability), JSON.stringify({ ...command, binding: { ...binding, lifecycleGeneration: "old" } })).reason)
      .toBe("LIFECYCLE_MISMATCH");
    expect(authorizer.authorize(faultControlFilename(6, capability), JSON.stringify({
      ...command, requestId: randomUUID(), binding: { ...binding, fixtureId: "other" },
    })).reason).toBe("FIXTURE_MISMATCH");
    expect(authorizer.authorize(faultControlFilename(7, capability), JSON.stringify({
      ...command, requestId: randomUUID(), caseId: "runtime.cancel_capture.before_lease.current",
    })).reason).toBe("MATRIX_MISMATCH");
    expect(authorizer.authorize(faultControlFilename(8, capability), JSON.stringify({
      ...command, requestId: randomUUID(), phase: "before_lease",
    })).reason).toBe("PHASE_MISMATCH");
    expect(authorizer.authorize(faultControlFilename(9, capability), "x".repeat(32 * 1024 + 1)).reason)
      .toBe("MALFORMED");
  });

  it("validates all generated bootstrap identities before creating the owned root", () => {
    const runRoot = mkdtempSync(join(tmpdir(), "rfo-fault-root-"));
    const controlRoot = join(runRoot, "fault-control");
    const capability = randomUUID();
    const binding = { fixtureId: "fixture", lifecycleId: "life", lifecycleGeneration: "generation" };
    const bootstrap: FaultControlBootstrap = {
      schemaVersion: 1, runId: "run", backend: "runtime", capability,
      fixtureContentIdentity: "", generatedProjectIdentity: "project", generatedAddonIdentity: "addon", binding,
    };
    try {
      expect(() => createOwnedFaultControlRoot({ runRoot, controlRoot, bootstrap }))
        .toThrowError(FaultControlError);
      expect(() => readFileSync(join(controlRoot, "bootstrap.json"))).toThrow();
    } finally {
      rmSync(runRoot, { recursive: true, force: true });
    }
  });

  it("refuses oversized and foreign-capability outbox files before parsing them", async () => {
    const root = mkdtempSync(join(tmpdir(), "rfo-fault-mailbox-"));
    const inboxPath = join(root, "inbox");
    const outboxPath = join(root, "outbox");
    mkdirSync(inboxPath);
    mkdirSync(outboxPath);
    const capability = randomUUID();
    const foreignCapability = randomUUID();
    const mailbox = new FilesystemFaultControlMailbox(inboxPath, outboxPath, capability);
    try {
      writeFileSync(
        join(outboxPath, faultControlFilename(1, capability)),
        "x".repeat(32 * 1024 + 1),
        { encoding: "utf8", mode: 0o600 },
      );
      await expect(mailbox.takeOutbox()).rejects.toMatchObject({ code: "MALFORMED" } satisfies Partial<FaultControlError>);
      rmSync(join(outboxPath, faultControlFilename(1, capability)));
      writeFileSync(
        join(outboxPath, faultControlFilename(2, foreignCapability)),
        "not-json",
        { encoding: "utf8", mode: 0o600 },
      );
      await expect(mailbox.takeOutbox()).rejects.toMatchObject({ code: "CAPABILITY_MISMATCH" } satisfies Partial<FaultControlError>);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires an acknowledged arm before cancellation and refuses every distinct second action", () => {
    const capability = randomUUID();
    const binding = { fixtureId: "fixture", lifecycleId: "life", lifecycleGeneration: "generation" };
    const authorizer = new FaultControlAuthorizer({
      matrix: defineFaultMatrix([matrixCase()]),
      bootstrap: {
        schemaVersion: 1, runId: "run", backend: "runtime", capability,
        fixtureContentIdentity: "fixture-content", generatedProjectIdentity: "project", generatedAddonIdentity: "addon", binding,
      },
      readLifecycleBinding: () => binding,
    });
    const base = {
      schemaVersion: 1, runId: "run", caseId: "runtime.cancel_capture.lease_acquired.current",
      phase: "lease_acquired", action: "cancel_capture", binding,
    };
    const release = { ...base, kind: "release", requestId: randomUUID() };
    const cancel = { ...base, kind: "cancel", requestId: randomUUID() };
    // Neither action is meaningful until a fixture has acknowledged arrival.
    expect(authorizer.authorize(faultControlFilename(1, capability), JSON.stringify(release)).reason).toBe("REPLAY_REFUSED");
    expect(authorizer.authorize(faultControlFilename(2, capability), JSON.stringify(cancel)).reason).toBe("REPLAY_REFUSED");
    const arm = { ...base, kind: "arm", requestId: randomUUID() };
    const rawArm = JSON.stringify(arm);
    const acceptedArm = authorizer.authorize(faultControlFilename(3, capability), rawArm);
    expect(acceptedArm.accepted).toBe(true);
    // Merely accepting the mailbox file is not enough—the arrival receipt is
    // the protocol transition which permits an action.
    expect(authorizer.authorize(faultControlFilename(4, capability), JSON.stringify(release)).reason).toBe("REPLAY_REFUSED");
    authorizer.remember(acceptedArm.command!, rawArm, acknowledgement(arm, "arrived"));
    const acceptedCancel = authorizer.authorize(faultControlFilename(5, capability), JSON.stringify(cancel));
    expect(acceptedCancel.accepted).toBe(true);
    authorizer.remember(acceptedCancel.command!, JSON.stringify(cancel), acknowledgement(cancel, "executed"));
    for (const [sequence, command] of [
      [6, { ...base, kind: "arm", requestId: randomUUID() }],
      [7, { ...base, kind: "release", requestId: randomUUID() }],
      [8, { ...base, kind: "cancel", requestId: randomUUID() }],
    ] as const) {
      expect(authorizer.authorize(faultControlFilename(sequence, capability), JSON.stringify(command)).reason).toBe("REPLAY_REFUSED");
    }
  });

  it("invalidates control authority when a restart or world change changes lifecycle generation", () => {
    const capability = randomUUID();
    const binding = { fixtureId: "fixture", lifecycleId: "life", lifecycleGeneration: "generation-1" };
    let currentBinding = binding;
    const authorizer = new FaultControlAuthorizer({
      matrix: defineFaultMatrix([matrixCase()]),
      bootstrap: {
        schemaVersion: 1, runId: "run", backend: "runtime", capability,
        fixtureContentIdentity: "fixture-content", generatedProjectIdentity: "project", generatedAddonIdentity: "addon", binding,
      },
      readLifecycleBinding: () => currentBinding,
    });
    const arm = {
      schemaVersion: 1, kind: "arm", runId: "run", requestId: randomUUID(),
      caseId: "runtime.cancel_capture.lease_acquired.current", phase: "lease_acquired", action: "cancel_capture", binding,
    };
    const accepted = authorizer.authorize(faultControlFilename(1, capability), JSON.stringify(arm));
    authorizer.remember(accepted.command!, JSON.stringify(arm), acknowledgement(arm, "arrived"));
    currentBinding = { ...binding, lifecycleGeneration: "generation-after-world-change" };
    expect(authorizer.authorize(faultControlFilename(2, capability), JSON.stringify({
      ...arm, kind: "cancel", requestId: randomUUID(),
    })).reason).toBe("LIFECYCLE_MISMATCH");
  });

  it("permits only an exact terminal replay after terminal acknowledgement", () => {
    const capability = randomUUID();
    const binding = { fixtureId: "fixture", lifecycleId: "life", lifecycleGeneration: "generation" };
    const authorizer = new FaultControlAuthorizer({
      matrix: defineFaultMatrix([matrixCase()]),
      bootstrap: {
        schemaVersion: 1, runId: "run", backend: "runtime", capability,
        fixtureContentIdentity: "fixture-content", generatedProjectIdentity: "project", generatedAddonIdentity: "addon", binding,
      },
      readLifecycleBinding: () => binding,
    });
    const arm = {
      schemaVersion: 1, kind: "arm", runId: "run", requestId: randomUUID(),
      caseId: "runtime.cancel_capture.lease_acquired.current", phase: "lease_acquired", action: "cancel_capture", binding,
    };
    const acceptedArm = authorizer.authorize(faultControlFilename(1, capability), JSON.stringify(arm));
    authorizer.remember(acceptedArm.command!, JSON.stringify(arm), acknowledgement(arm, "arrived"));
    const terminal = {
      schemaVersion: 1, kind: "terminal", runId: "run", requestId: randomUUID(),
      caseId: arm.caseId, phase: arm.phase, binding,
    };
    const rawTerminal = JSON.stringify(terminal);
    const acceptedTerminal = authorizer.authorize(faultControlFilename(2, capability), rawTerminal);
    authorizer.remember(acceptedTerminal.command!, rawTerminal, acknowledgement(terminal, "terminalled"));
    expect(authorizer.authorize(faultControlFilename(3, capability), rawTerminal).replay).toMatchObject({ kind: "terminalled" });
    for (const [sequence, command] of [
      [4, { ...arm, kind: "arm", requestId: randomUUID() }],
      [5, { ...arm, kind: "release", requestId: randomUUID() }],
      [6, { ...arm, kind: "cancel", requestId: randomUUID() }],
      [7, { ...terminal, requestId: randomUUID() }],
    ] as const) {
      expect(authorizer.authorize(faultControlFilename(sequence, capability), JSON.stringify(command)).reason).toBe("CASE_TERMINAL");
    }
  });

  it("uses arrival acknowledgement rather than a sleep, then executes one release and seals terminally", async () => {
    const time = new ManualTime();
    const mailbox = new InMemoryFaultControlMailbox();
    const capability = randomUUID();
    const binding = { fixtureId: "fixture-1", lifecycleId: "life-1", lifecycleGeneration: "gen-1" };
    const scheduler = new FaultMatrixScheduler({
      matrix: defineFaultMatrix([matrixCase()]), mailbox, capability, binding, runId: "run-1",
      clock: time, sleeper: time, caseDeadlineMs: 1_000,
    });
    const arming = scheduler.arm("runtime.cancel_capture.lease_acquired.current");
    await Promise.resolve();
    const arm = JSON.parse(mailbox.inbox[0]!.body);
    mailbox.acknowledge(acknowledgement(arm, "arrived"));
    await arming;
    const release = scheduler.releaseBarrier();
    await Promise.resolve();
    const releaseCommand = JSON.parse(mailbox.inbox[1]!.body);
    mailbox.acknowledge(acknowledgement(releaseCommand, "executed"));
    await expect(release).resolves.toMatchObject({ kind: "executed" });
    let finished = false;
    const finishing = scheduler.finishCase().then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    const terminalCommand = JSON.parse(mailbox.inbox[2]!.body);
    mailbox.acknowledge(acknowledgement(terminalCommand, "terminalled"));
    await finishing;
    await expect(scheduler.arm("runtime.cancel_capture.lease_acquired.current"))
      .rejects.toMatchObject({ code: "CASE_TERMINAL" } satisfies Partial<FaultControlError>);
    await expect(scheduler.releaseBarrier()).rejects.toMatchObject({ code: "CASE_TERMINAL" } satisfies Partial<FaultControlError>);
    await expect(scheduler.schedule("runtime.cancel_capture.lease_acquired.current", "cancel"))
      .rejects.toMatchObject({ code: "CASE_TERMINAL" } satisfies Partial<FaultControlError>);
  });

  it("executes cancellation once after arrival and bounds a missing action acknowledgement", async () => {
    const time = new ManualTime();
    const mailbox = new InMemoryFaultControlMailbox();
    const scheduler = new FaultMatrixScheduler({
      matrix: defineFaultMatrix([matrixCase()]), mailbox, capability: randomUUID(),
      binding: { fixtureId: "fixture", lifecycleId: "life", lifecycleGeneration: "generation" },
      runId: "run", clock: time, sleeper: time, caseDeadlineMs: 50, barrierAllowanceMs: 50,
    });
    const arming = scheduler.arm("runtime.cancel_capture.lease_acquired.current");
    await Promise.resolve();
    const arm = JSON.parse(mailbox.inbox[0]!.body);
    mailbox.acknowledge(acknowledgement(arm, "arrived"));
    await arming;
    const cancelling = scheduler.releaseBarrier("cancel");
    await Promise.resolve();
    expect(JSON.parse(mailbox.inbox[1]!.body).kind).toBe("cancel");
    // The action is one-shot even while its acknowledgement is outstanding.
    await expect(scheduler.releaseBarrier()).rejects.toMatchObject({ code: "REPLAY_REFUSED" } satisfies Partial<FaultControlError>);
    await time.advanceBy(50);
    await expect(cancelling).rejects.toMatchObject({ code: "DEADLINE_EXPIRED" } satisfies Partial<FaultControlError>);
  });

  it("aborts an outstanding action wait before consuming the terminal closeout acknowledgement", async () => {
    const time = new ManualTime();
    const mailbox = new InMemoryFaultControlMailbox();
    const scheduler = new FaultMatrixScheduler({
      matrix: defineFaultMatrix([matrixCase()]), mailbox, capability: randomUUID(),
      binding: { fixtureId: "fixture", lifecycleId: "life", lifecycleGeneration: "generation" },
      runId: "run", clock: time, sleeper: time, caseDeadlineMs: 1_000,
    });
    const arming = scheduler.arm("runtime.cancel_capture.lease_acquired.current");
    await Promise.resolve();
    const arm = JSON.parse(mailbox.inbox[0]!.body);
    mailbox.acknowledge(acknowledgement(arm, "arrived"));
    await arming;
    const action = scheduler.releaseBarrier();
    await Promise.resolve();
    const finishing = scheduler.finishCase();
    await Promise.resolve();
    const terminal = JSON.parse(mailbox.inbox[2]!.body);
    expect(terminal.kind).toBe("terminal");
    mailbox.acknowledge(acknowledgement(terminal, "terminalled"));
    await expect(finishing).resolves.toBeUndefined();
    await expect(action).rejects.toMatchObject({ code: "CASE_TERMINAL" } satisfies Partial<FaultControlError>);
  });

  it("retries a lost acknowledgement with the same request ID and permits only one action", async () => {
    const time = new ManualTime();
    const mailbox = new InMemoryFaultControlMailbox();
    const capability = randomUUID();
    const binding = { fixtureId: "fixture", lifecycleId: "life", lifecycleGeneration: "gen" };
    const scheduler = new FaultMatrixScheduler({
      matrix: defineFaultMatrix([matrixCase()]), mailbox, capability, binding, runId: "run",
      clock: time, sleeper: time, caseDeadlineMs: 5_000,
    });
    const arming = scheduler.arm("runtime.cancel_capture.lease_acquired.current");
    for (let turn = 0; turn < 5 && time.pendingSleepCount === 0; turn += 1) await Promise.resolve();
    expect(time.pendingSleepCount).toBe(1);
    const initial = JSON.parse(mailbox.inbox[0]!.body);
    const startedAt = time.now();
    await time.advanceBy(1_000);
    expect(time.now()).toBe(startedAt + 1_000);
    for (let turn = 0; turn < 10 && mailbox.inbox.length < 2; turn += 1) await Promise.resolve();
    expect(mailbox.inbox).toHaveLength(2);
    const retry = JSON.parse(mailbox.inbox[1]!.body);
    expect(retry.requestId).toBe(initial.requestId);
    expect(retry).toEqual(initial);
    // The fixture returns its recorded receipt without repeating its phase
    // arrival work; the host accepts that receipt on the resend path.
    mailbox.acknowledge(acknowledgement(retry, "arrived"));
    for (let turn = 0; turn < 10 && time.pendingSleepCount === 0; turn += 1) await Promise.resolve();
    expect(time.pendingSleepCount).toBe(1);
    await time.runNextSleep();
    await expect(arming).resolves.toMatchObject({ requestId: initial.requestId });

    const authorizer = new FaultControlAuthorizer({
      matrix: defineFaultMatrix([matrixCase()]),
      bootstrap: {
        schemaVersion: 1, runId: "run", backend: "runtime", capability,
        fixtureContentIdentity: "fixture-content", generatedProjectIdentity: "project", generatedAddonIdentity: "addon", binding,
      },
      readLifecycleBinding: () => binding,
    });
    const fixtureArm = {
      schemaVersion: 1, kind: "arm", runId: "run", requestId: randomUUID(),
      caseId: initial.caseId, phase: initial.phase, action: initial.action, binding,
    };
    const acceptedArm = authorizer.authorize(faultControlFilename(1, capability), JSON.stringify(fixtureArm));
    authorizer.remember(acceptedArm.command!, JSON.stringify(fixtureArm), acknowledgement(fixtureArm, "arrived"));
    const release = { ...fixtureArm, kind: "release", requestId: randomUUID() };
    const acceptedRelease = authorizer.authorize(faultControlFilename(2, capability), JSON.stringify(release));
    authorizer.remember(acceptedRelease.command!, JSON.stringify(release), acknowledgement(release, "executed"));
    expect(authorizer.authorize(faultControlFilename(3, capability), JSON.stringify({
      ...release, kind: "arm", requestId: randomUUID(),
    })).reason).toBe("REPLAY_REFUSED");
  });

  it("expires an unanswered barrier using injected manual time", async () => {
    const time = new ManualTime();
    const scheduler = new FaultMatrixScheduler({
      matrix: defineFaultMatrix([matrixCase()]), mailbox: new InMemoryFaultControlMailbox(),
      capability: randomUUID(), binding: { fixtureId: "fixture", lifecycleId: "life", lifecycleGeneration: "gen" },
      runId: "run", clock: time, sleeper: time, caseDeadlineMs: 25, barrierAllowanceMs: 25,
    });
    const pending = scheduler.arm("runtime.cancel_capture.lease_acquired.current");
    await Promise.resolve();
    await time.advanceBy(25);
    await expect(pending).rejects.toMatchObject({ code: "DEADLINE_EXPIRED" });
  });
});
