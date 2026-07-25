import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createObserverApplication } from "../../observer/agent/application.js";
import { observerAddonSource } from "../support/observer-fixtures.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

describe("ObserverApplicationOperations", () => {
  it("uses one sanitized dispatcher for status and rejects unknown operations", async () => {
    await withTemporaryDirectory(async (root) => {
      const app = createObserverApplication({ root, sourceDirectory: observerAddonSource });
      const status = await app.operations.execute("status") as Record<string, unknown>;
      expect(status).toMatchObject({ agentInstanceId: app.agentInstanceId, evidence: { enabled: false } });
      expect(JSON.stringify(status)).not.toMatch(/launchNonce|registeredInstanceNonce|artifactPath/);
      await expect(app.operations.execute("unknown" as never)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      const run = await app.operations.execute("runBegin", {
        title: "can capture but cannot finalize",
      }) as { runId: string };
      await expect(app.operations.execute("runFinalize", {
        runId: run.runId,
        evidenceRoot: join(root, "unconfigured-evidence"),
        includeCaptureLabels: ["proof"],
        review: {
          imagesReviewed: false,
          outcome: "Unreviewed",
          summary: "No exporter configured.",
        },
      })).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
      await app.server.close();
    }, { prefix: "rfo-operations-" });
  });

  it("admits runs when the exporter is configured through the shared root", async () => {
    await withTemporaryDirectory(async (root) => {
      const evidence = join(root, "evidence");
      mkdirSync(evidence);
      const app = createObserverApplication({ root: join(root, "managed"), sourceDirectory: observerAddonSource, evidenceRoots: [evidence] });
      await expect(app.operations.execute("runBegin", { title: "exportable", idempotencyKey: "begin-1" }))
        .resolves.toMatchObject({ state: "open" });
      await app.server.close();
    }, { prefix: "rfo-operations-export-" });
  });
});
