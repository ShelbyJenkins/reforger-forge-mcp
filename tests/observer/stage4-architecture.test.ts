import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repositoryRoot } from "./helpers.js";

describe("Stage 4 observer architecture", () => {
  it("keeps the compatibility coordinator free of transport, backend maps, polling, and export policy", () => {
    const coordinator = readFileSync(join(repositoryRoot, "src", "observer", "coordinator.ts"), "utf8");
    expect(coordinator.split(/\r?\n/).length).toBeLessThan(160);
    expect(coordinator).not.toMatch(/node:child_process|captureRuntime|captureWorkbench|WorkbenchJob|setInterval|manifest\.json|pendingRequests/);
  });

  it("keeps export ownership out of the durable run store and domain policy out of IPC", () => {
    const runs = readFileSync(join(repositoryRoot, "observer", "agent", "runs.ts"), "utf8");
    const child = readFileSync(join(repositoryRoot, "observer", "agent", "private-child.ts"), "utf8");
    const server = readFileSync(join(repositoryRoot, "observer", "agent", "server.ts"), "utf8");
    expect(runs).not.toMatch(/JobStore|supportingLogRoots|RESULT\.md|hashMembers|copySupportingFiles/);
    expect(child).not.toMatch(/jobs\.submit|runs\.finalize|artifacts\.release|revokeSession\(/);
    expect(server).toContain("operations.execute");
  });

  it("constructs the host graph once and publishes every Stage 4 runtime module", () => {
    const server = readFileSync(join(repositoryRoot, "src", "server.ts"), "utf8");
    expect(server.match(/createObserverApplication\(/g)).toHaveLength(1);
    expect(server).not.toMatch(/new ObserverCoordinator|new OwnedRuntimeManager/);
    expect(server.match(/registerObserverTools\(/g)).toHaveLength(1);
  });
});
