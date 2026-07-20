import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createObserverApplication } from "../../observer/agent/application.js";
import { cleanup, observerAddonSource, temporaryDirectory } from "./helpers.js";

describe("ObserverApplicationOperations", () => {
  it("uses one sanitized dispatcher for status and rejects unknown operations", async () => {
    const root = temporaryDirectory("rfo-operations-");
    try {
      const app = createObserverApplication({ root, sourceDirectory: observerAddonSource });
      const status = await app.operations.execute("status") as Record<string, unknown>;
      expect(status).toMatchObject({ agentInstanceId: app.agentInstanceId, evidence: { enabled: false } });
      expect(JSON.stringify(status)).not.toMatch(/launchNonce|registeredInstanceNonce|artifactPath/);
      await expect(app.operations.execute("unknown" as never)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(app.operations.execute("runBegin", { title: "cannot finish" })).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
      await app.server.close();
    } finally { cleanup(root); }
  });

  it("admits runs when the exporter is configured through the shared root", async () => {
    const root = temporaryDirectory("rfo-operations-export-");
    try {
      const evidence = join(root, "evidence");
      mkdirSync(evidence);
      const app = createObserverApplication({ root: join(root, "managed"), sourceDirectory: observerAddonSource, evidenceRoots: [evidence] });
      await expect(app.operations.execute("runBegin", { title: "exportable", idempotencyKey: "begin-1" }))
        .resolves.toMatchObject({ state: "open" });
      await app.server.close();
    } finally { cleanup(root); }
  });
});
