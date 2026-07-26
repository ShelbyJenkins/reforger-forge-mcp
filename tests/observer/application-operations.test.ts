import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createObserverApplication } from "../../observer/agent/application.js";
import { OBSERVER_BUILD_IDENTITY } from "../../observer/protocol/index.js";
import {
  observerAddonSource,
  testBundleDigest,
} from "../support/observer-fixtures.js";
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

  it("finalizes an exact-vacant runtime after direct-exit reconciliation released its lifecycle", async () => {
    await withTemporaryDirectory(async (root) => {
      const profileRoot = join(root, "profiles");
      const profilePath = join(profileRoot, "one-point-zero-one-direct-exit");
      mkdirSync(profilePath, { recursive: true });
      const app = createObserverApplication({
        root: join(root, "managed"),
        profileRoot,
        sourceDirectory: observerAddonSource,
      });
      try {
        const created = app.control.sessions.create({
          bundleDigest: testBundleDigest,
          stagedAddonPath: join(root, "staged", "ReforgerForgeObserver"),
          profilePath,
          agent: {
            host: "127.0.0.1",
            port: 47831,
            instanceId: app.control.agentInstanceId,
          },
          buildIdentity: OBSERVER_BUILD_IDENTITY,
          expectedRuntimeKind: "listenServer",
          ttlMs: 60_000,
          transportPreference: ["rest"],
        });
        const unrelatedProfilePath = join(
          profileRoot,
          "unrelated-known-session"
        );
        mkdirSync(unrelatedProfilePath, { recursive: true });
        const unrelated = app.control.sessions.create({
          bundleDigest: testBundleDigest,
          stagedAddonPath: join(root, "staged", "ReforgerForgeObserver"),
          profilePath: unrelatedProfilePath,
          agent: {
            host: "127.0.0.1",
            port: 47831,
            instanceId: app.control.agentInstanceId,
          },
          buildIdentity: OBSERVER_BUILD_IDENTITY,
          expectedRuntimeKind: "listenServer",
          ttlMs: 60_000,
          transportPreference: ["rest"],
        });
        const runtimeId = "rt-00000000-0000-4000-8000-000000000001";
        const authority = {
          preparedLaunchId: "pl-00000000-0000-4000-8000-000000000002",
          profilePath,
          runtimeKind: "listenServer" as const,
          pid: 24_001,
          executablePath: "C:\\ArmaReforger\\ArmaReforgerSteamDiag.exe",
          creationTimeFileTime: "134000000000000001",
          ownerTokenArgument: `-reforgerForgeOwnerToken=${"a".repeat(48)}`,
          launchedAtMs: Date.parse("2026-07-25T12:00:00.000Z"),
        };
        const generation = createHash("sha256").update(JSON.stringify({
          runtimeId,
          sessionId: created.record.sessionId,
          preparedLaunchId: authority.preparedLaunchId,
          pid: authority.pid,
          executablePath: authority.executablePath,
          creationTimeFileTime: authority.creationTimeFileTime,
          ownerTokenArgument: authority.ownerTokenArgument,
          launchedAtMs: authority.launchedAtMs,
        })).digest("hex");
        app.server.retainOwnedRuntimeLifecycle(
          created.record.sessionId,
          runtimeId,
          generation,
          authority
        );
        app.server.releaseOwnedRuntimeLifecycle(
          created.record.sessionId,
          runtimeId,
          generation
        );

        const invalidBindings = [
          {
            label: "missing authority",
            sessionId: created.record.sessionId,
            runtimeId: "rt-00000000-0000-4000-8000-000000000004",
            generation: "b".repeat(64),
          },
          {
            label: "wrong known session",
            sessionId: unrelated.record.sessionId,
            runtimeId,
            generation,
          },
          {
            label: "wrong generation",
            sessionId: created.record.sessionId,
            runtimeId,
            generation: "c".repeat(64),
          },
        ];
        for (const invalid of invalidBindings) {
          await expect(app.operations.execute("runtimeStopPreflight", {
            sessionId: invalid.sessionId,
            runtimeId: invalid.runtimeId,
            generation: invalid.generation,
            reservationId: "00000000-0000-4000-8000-000000000003",
            exactRuntimeVacant: true,
          }), invalid.label).rejects.toMatchObject({ code: "SESSION_MISMATCH" });
          await expect(app.operations.execute("runtimeStopComplete", {
            sessionId: invalid.sessionId,
            runtimeId: invalid.runtimeId,
            generation: invalid.generation,
            exactRuntimeVacant: true,
          }), invalid.label).rejects.toMatchObject({ code: "SESSION_MISMATCH" });
          expect(app.control.sessions.peek(created.record.sessionId)?.revokedAt)
            .toBeNull();
          expect(app.control.sessions.peek(unrelated.record.sessionId)?.revokedAt)
            .toBeNull();
        }
        await expect(app.operations.execute("runtimeStopComplete", {
          sessionId: created.record.sessionId,
          runtimeId,
          generation,
          exactRuntimeVacant: false,
        }), "released authority without exact vacancy").rejects.toMatchObject({
          code: "SESSION_MISMATCH",
        });
        expect(app.control.sessions.peek(created.record.sessionId)?.revokedAt)
          .toBeNull();
        expect(app.control.sessions.peek(unrelated.record.sessionId)?.revokedAt)
          .toBeNull();

        await expect(app.operations.execute("runtimeStopPreflight", {
          sessionId: created.record.sessionId,
          runtimeId,
          generation,
          reservationId: "00000000-0000-4000-8000-000000000003",
          exactRuntimeVacant: true,
        })).resolves.toMatchObject({
          sessionKnown: true,
          ready: true,
          reserved: false,
          reservationRequired: false,
        });
        await expect(app.operations.execute("runtimeStopComplete", {
          sessionId: created.record.sessionId,
          runtimeId,
          generation,
          exactRuntimeVacant: true,
          // A live reservation may predate the direct exit/release. Exact
          // released authority scopes cleanup even though the child-side
          // release acknowledgement no longer retains that reservation.
          reservationId: "00000000-0000-4000-8000-000000000005",
        })).resolves.toMatchObject({
          completed: true,
          revoked: true,
          lifecycleReleased: false,
        });
        expect(app.control.sessions.peek(unrelated.record.sessionId)?.revokedAt)
          .toBeNull();
      } finally {
        await app.server.close();
      }
    }, { prefix: "rfo-operations-direct-exit-" });
  });
});
