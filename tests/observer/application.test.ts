import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createObserverApplication as createAgentApplication } from "../../observer/agent/application.js";
import { createObserverApplication as createHostApplication } from "../../src/observer/application.js";
import { cleanup, observerAddonSource, temporaryDirectory } from "./helpers.js";

describe("observer application composition roots", () => {
  it("constructs one agent graph and reports disabled evidence without roots", async () => {
    const root = temporaryDirectory("rfo-agent-root-");
    try {
      const app = createAgentApplication({ root, sourceDirectory: observerAddonSource });
      expect(app.server).toBeDefined();
      expect(app.operations).toBeDefined();
      expect(app.runs.evidenceDiagnostics()).toMatchObject({ enabled: false });
      await app.server.close();
    } finally { cleanup(root); }
  });

  it("constructs the optional exporter only for an explicitly allowed destination", async () => {
    const root = temporaryDirectory("rfo-agent-exporter-");
    try {
      const evidence = join(root, "evidence");
      mkdirSync(evidence);
      const app = createAgentApplication({ root: join(root, "managed"), sourceDirectory: observerAddonSource, evidenceRoots: [evidence] });
      expect(app.evidenceBundle).toBeDefined();
      expect(app.runs.evidenceDiagnostics()).toMatchObject({ enabled: true, evidenceRootCount: 1 });
      await app.server.close();
    } finally { cleanup(root); }
  });

  it("composes host transport, capture, runs, and diagnostics once", async () => {
    const root = temporaryDirectory("rfo-host-root-");
    try {
      const app = createHostApplication({ managedRoot: join(root, "managed"), profileRoot: join(root, "profiles") });
      expect(app.agentClient).toBeDefined();
      expect(app.captureService).toBeDefined();
      expect(app.evidenceRuns).toBeDefined();
      expect(app.diagnosticPrivateChildCount()).toBe(0);
      await app.close();
      expect(app.diagnosticPrivateChildCount()).toBe(0);
    } finally { cleanup(root); }
  });
});
