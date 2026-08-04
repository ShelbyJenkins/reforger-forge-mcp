import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repositoryRoot } from "../support/observer-fixtures.js";

describe("Observer application composition architecture", () => {
  it("keeps the host application as the sole host composition root", () => {
    const application = readFileSync(join(repositoryRoot, "src", "observer", "application.ts"), "utf8");
    const server = readFileSync(join(repositoryRoot, "src", "server.ts"), "utf8");
    expect(application).toContain("export interface ObserverApplication");
    expect(application).toContain("export function createObserverApplication");
    expect(server.match(/createObserverApplication\(/g)).toHaveLength(1);
    expect(server.match(/registerObserverTools\(/g)).toHaveLength(1);
    expect(server).not.toMatch(/ObserverCoordinator|new OwnedRuntimeManager/);
  });

  it("keeps export ownership out of the durable run store and domain policy out of IPC", () => {
    const runs = readFileSync(join(repositoryRoot, "observer", "agent", "runs.ts"), "utf8");
    const child = readFileSync(join(repositoryRoot, "observer", "agent", "private-child.ts"), "utf8");
    const server = readFileSync(join(repositoryRoot, "observer", "agent", "server.ts"), "utf8");
    expect(runs).not.toMatch(/JobStore|supportingLogRoots|RESULT\.md|hashMembers|copySupportingFiles/);
    expect(child).not.toMatch(/jobs\.submit|runs\.finalize|artifacts\.release|revokeSession\(/);
    expect(child).toContain('"runSubmitCapture"');
    expect(child).toContain('"runReviseCaptureAdmission"');
    expect(server).toContain("operations.execute");
  });

  it("constructs the host graph once and publishes every runtime module", () => {
    const server = readFileSync(join(repositoryRoot, "src", "server.ts"), "utf8");
    expect(server.match(/createObserverApplication\(/g)).toHaveLength(1);
    expect(server).not.toMatch(/ObserverCoordinator|new OwnedRuntimeManager/);
    expect(server.match(/registerObserverTools\(/g)).toHaveLength(1);
  });
});
