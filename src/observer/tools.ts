import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import type { ObserverApplication, ObserverCaptureResult } from "./application.js";
import { ObserverCoordinatorError } from "./errors.js";
import { prepareObserverLaunch } from "./launch.js";
import { runObserverSetup } from "./setup.js";
import type { WorkbenchClient } from "../workbench/client.js";
import type { OwnedRuntimeManager } from "./owned-runtime-manager.js";
import { registerObserverRuntime } from "../tools/observer-runtime.js";
import {
  projectPublicObserverToolError,
  PUBLIC_OBSERVER_CAPABILITIES,
  type PublicObserverErrorCandidate,
} from "./public-contract.js";

const finite = () => z.number().finite();

function uniqueEvidenceRoots(
  roots: readonly string[] | undefined
): readonly string[] {
  if (!roots) return [];
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = resolve(root).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Public MCP schemas must use homogeneous array items. Positional tuple schemas
// serialize as draft-07 `items: [...]` with nested item references, which some
// MCP hosts cannot import and may cause them to omit the complete tool. The
// transforms preserve the exact tuple types required by ObserverCaptureView
// after the fixed-length arrays have been validated.
const vector3 = () => finite().array().length(3).transform((value): [number, number, number] => [
  value[0],
  value[1],
  value[2],
]);
const quaternion = () => finite().array().length(4).refine((value) => {
  const length = Math.hypot(...value);
  return length > 0.000001 && Math.abs(length - 1) < 0.01;
}, "orientation must be a normalized non-zero quaternion").transform((value): [number, number, number, number] => [
  value[0],
  value[1],
  value[2],
  value[3],
]);
const viewSchema = z.union([
  z.object({ kind: z.literal("current") }),
  z.object({
    kind: z.literal("pose"),
    position: vector3(),
    orientation: quaternion(),
    fov: finite().min(1).max(179),
  }),
  z.object({
    kind: z.literal("lookAt"),
    position: vector3(),
    target: vector3(),
    fov: finite().min(1).max(179),
  }).refine((value) => Math.hypot(
    value.target[0] - value.position[0],
    value.target[1] - value.position[1],
    value.target[2] - value.position[2]
  ) > 0.000001, { message: "lookAt position and target must differ", path: ["target"] }),
]);
export interface ObserverToolDefaults {
  sessionTtlMs?: number;
  defaultCaptureTimeoutMs?: number;
  workbenchClient?: WorkbenchClient;
  projectPath?: string;
  evidenceRoots?: readonly string[];
  ownedRuntimeManager?: OwnedRuntimeManager;
}

function jsonText(heading: string, value: unknown): string {
  return `${heading}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function extractObserverCoordinatorError(error: unknown): PublicObserverErrorCandidate | undefined {
  if (!(error instanceof ObserverCoordinatorError)) return undefined;
  return {
    code: error.code,
    readDiagnosticMessage: () => error.message,
    readDetails: () => error.details,
  };
}

function toolError(error: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: projectPublicObserverToolError(error, {
        subject: "Observer error",
        extract: extractObserverCoordinatorError,
      }),
    }],
    isError: true,
  };
}

function capturePresentation(result: Extract<ObserverCaptureResult, { asynchronous: false }>): Record<string, unknown> {
  const artifact = result.job.artifact && typeof result.job.artifact === "object"
    ? result.job.artifact as Record<string, unknown>
    : {};
  const metadata = result.metadata;
  return {
    jobId: result.job.jobId,
    instanceId: result.job.instanceId,
    worldRevision: result.job.worldRevision,
    worldId: result.job.worldId,
    worldEpoch: result.job.worldEpoch,
    camera: metadata.actualCamera ?? artifact.actualCamera ?? null,
    fov: metadata.actualFov ?? artifact.actualFov ?? null,
    timestamp: metadata.completedAt ?? artifact.completedAt ?? null,
    dimensions: {
      width: metadata.width ?? null,
      height: metadata.height ?? null,
    },
    sha256: metadata.contentSha256 ?? null,
    warnings: metadata.warnings ?? artifact.warnings ?? [],
    contaminated: metadata.contaminated ?? artifact.contaminated ?? false,
  };
}

function isPng(image: Buffer): boolean {
  return image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

export function registerObserverTools(
  server: McpServer,
  application: ObserverApplication,
  defaults: ObserverToolDefaults = {}
): void {
  const sessionTtlMs = defaults.sessionTtlMs ?? 20 * 60 * 1_000;
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1_000 || sessionTtlMs > 24 * 60 * 60 * 1_000) {
    throw new ObserverCoordinatorError("INVALID_REQUEST", "Observer session TTL must be from 1000 through 86400000 milliseconds");
  }
  server.registerTool(
    "observer_setup",
    {
      description:
        "Manage the private runtime observer and Workbench helper add-ons. ensure verifies and immutably stages both managed companions and applies external retention; status and doctor report both roots; uninstall requests runtime cancellation and refuses while Workbench or camera restoration is active, then removes only managed files. Never launches or signals Arma Reforger or Workbench.",
      inputSchema: {
        action: z.enum(["ensure", "status", "doctor", "uninstall"]).default("status"),
      },
    },
    async ({ action }) => {
      try {
        return {
          content: [{
            type: "text" as const,
            text: jsonText(
              `Observer ${action} completed.`,
              await runObserverSetup(
                application,
                action,
                defaults.workbenchClient
                  ? { client: defaults.workbenchClient, projectPath: defaults.projectPath }
                  : undefined
              )
            ),
          }],
        };
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "observer_prepare_launch",
    {
      description:
        "Prepare an existing Arma Reforger argument array for the staged observer addon and an exclusive profile session. Returns tokens as a structured array and session metadata; never starts the game. Conflicting profile/addon arguments are refused.",
      inputSchema: {
        runtimeKind: z.enum(["client", "listenServer", "dedicated", "testRunner"]),
        arguments: z.array(z.string().max(32_768)).max(512).default([]),
        profilePath: z.string().min(1).max(32_768),
        sessionTtlMs: z.number().int().min(1_000).max(24 * 60 * 60 * 1_000)
          .default(sessionTtlMs),
        transportPreference: z.array(z.enum(["rest", "mailbox"])).min(1).max(2).default(["rest", "mailbox"]),
        forceUpdate: z.boolean().default(false),
        idempotencyKey: z.string().min(1).max(128).optional(),
      },
    },
    async (input) => {
      try {
        const prepared = await prepareObserverLaunch(
          application,
          input,
          defaults.ownedRuntimeManager
        );
        return { content: [{ type: "text" as const, text: jsonText("Observer launch arguments prepared; no process was started.", prepared) }] };
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "observer_instances",
    {
      description:
        "List live and stale observer runtime instances with capabilities, transport, world epoch, active job, and health. Optionally wait for compatible live instances. Headless runtimes are excluded whenever renderersOnly is true.",
      inputSchema: {
        sessionId: z.string().min(1).max(96).optional(),
        requiredCapabilities: z.array(z.enum(PUBLIC_OBSERVER_CAPABILITIES)).max(PUBLIC_OBSERVER_CAPABILITIES.length).default([]),
        renderersOnly: z.boolean().default(false),
        waitMs: z.number().int().min(0).max(5 * 60 * 1_000).default(0),
      },
    },
    async (input, extra) => {
      try {
        const result = await application.instances({ ...input, signal: extra.signal });
        return { content: [{ type: "text" as const, text: jsonText("Observer instance inventory.", result) }] };
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "observer_capture",
    {
      description:
        "Capture reviewed evidence into an open managed observer run. runId and a unique normalized captureLabel are required. sessionId is required for a runtime renderer and optional for an explicitly selected already-running Workbench renderer. expectedWorldId/expectedWorldEpoch close the inventory-to-submit race. Synchronous mode returns one validated PNG; asynchronous mode returns a job ID that observer_job read can retrieve after completion.",
      inputSchema: {
        runId: z.string().regex(/^\d{8}T\d{6}Z-[a-f0-9]{8}$/),
        captureLabel: z.string().min(1).max(128),
        purpose: z.string().min(1).max(512).optional(),
        sessionId: z.string().min(1).max(96).optional(),
        view: viewSchema,
        instanceId: z.string().min(1).max(96).optional(),
        idempotencyKey: z.string().min(1).max(128).optional(),
        asynchronous: z.boolean().default(false),
        timeoutMs: z.number().int().min(1_000).max(5 * 60 * 1_000)
          .default(defaults.defaultCaptureTimeoutMs ?? application.defaultCaptureTimeoutMs),
        settleFrames: z.number().int().min(0).max(30).default(0),
        expectedWorldId: z.string().min(1).max(512).nullable().optional().describe(
          "Exact world ID returned by the immediately preceding observer_instances inventory."
        ),
        expectedWorldEpoch: z.number().int().nonnegative().describe(
          "Exact world epoch returned by the immediately preceding observer_instances inventory."
        ),
        expectedWorldRevision: z.string().regex(/^wr1\.(?:runtime|workbench)\.[A-Za-z0-9_-]+$/).optional().describe(
          "Opaque exact world revision returned by the immediately preceding observer_instances inventory."
        ),
        performancePolicy: z.enum(["evidence", "instrumented"]).default("evidence"),
      },
    },
    async (input, extra) => {
      try {
        const result = await application.capture({
          ...input,
          idempotencyKey: input.idempotencyKey ?? `mcp-${randomUUID()}`,
          signal: extra.signal,
        });
        if (result.asynchronous) {
          return { content: [{ type: "text" as const, text: jsonText("Observer capture queued.", result.job) }] };
        }
        if (result.image.length > application.maxInlineImageBytes) {
          throw new ObserverCoordinatorError(
            "ARTIFACT_TOO_LARGE",
            "Validated PNG exceeds the configured MCP inline limit",
            { job: result.job }
          );
        }
        if (!isPng(result.image)) {
          throw new ObserverCoordinatorError("ARTIFACT_INVALID", "Observer agent did not return a validated PNG");
        }
        return {
          content: [
            { type: "image" as const, data: result.image.toString("base64"), mimeType: "image/png" },
            { type: "text" as const, text: jsonText("Observer capture completed.", capturePresentation(result)) },
          ],
        };
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "observer_job",
    {
      description:
        "Inspect, read, cancel, or release an observer capture job. read returns one completed validated PNG when it fits the inline limit; larger images stay managed and must be exported by observer_run finalize. sessionId is required for runtime jobs and optional for Workbench jobs. Artifacts retained by an open run cannot be released independently.",
      inputSchema: {
        action: z.enum(["status", "read", "cancel", "release"]),
        sessionId: z.string().min(1).max(96).optional(),
        jobId: z.string().min(1).max(96),
      },
    },
    async ({ action, sessionId, jobId }) => {
      try {
        if (action === "read") {
          const result = await application.readJob(sessionId, jobId);
          if (!isPng(result.image)) throw new ObserverCoordinatorError("ARTIFACT_INVALID", "Observer agent did not return a validated PNG");
          return {
            content: [
              { type: "image" as const, data: result.image.toString("base64"), mimeType: "image/png" },
              { type: "text" as const, text: jsonText("Observer completed artifact.", capturePresentation({ asynchronous: false, ...result })) },
            ],
          };
        }
        const result = action === "status"
          ? await application.jobStatus(sessionId, jobId)
          : action === "cancel"
            ? await application.cancelJob(sessionId, jobId)
            : await application.releaseJob(sessionId, jobId);
        return { content: [{ type: "text" as const, text: jsonText(`Observer job ${action} completed.`, result) }] };
      } catch (error) {
        return toolError(error);
      }
    }
  );

  if (defaults.ownedRuntimeManager) {
    registerObserverRuntime(server, defaults.ownedRuntimeManager);
  }

  server.registerTool(
    "observer_run",
    {
      description:
        "Manage a bounded observation run. begin creates external managed run storage; status reports capture labels and artifact availability; finalize writes a standardized reviewed bundle beneath an allowlisted configured evidence root without overwriting; discard releases retained artifacts and removes run work.",
      inputSchema: {
        action: z.enum(["begin", "status", "finalize", "discard"]),
        runId: z.string().regex(/^\d{8}T\d{6}Z-[a-f0-9]{8}$/).optional(),
        title: z.string().min(1).max(256).optional(),
        caseIds: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/)).max(64).optional(),
        sourceRevision: z.string().min(1).max(256).optional(),
        procedureRevision: z.string().min(1).max(256).optional(),
        idempotencyKey: z.string().min(1).max(128).optional(),
        evidenceRoot: z.string().min(1).max(32_768).optional(),
        includeCaptureLabels: z.array(z.string().min(1).max(128)).min(1).max(64).optional(),
        review: z.object({
          imagesReviewed: z.boolean(),
          reviewer: z.string().min(1).max(256).optional(),
          outcome: z.enum(["Passed", "Failed", "Inconclusive", "Unreviewed"]),
          summary: z.string().min(1).max(2_048),
          limitations: z.array(z.string().min(1).max(512)).max(32).optional(),
        }).optional(),
        runtimeConfig: z.object({
          configurationId: z.string().min(1).max(128),
          values: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.null()])),
        }).optional(),
        supportingFiles: z.array(z.object({
          kind: z.literal("relevantLog"),
          label: z.string().min(1).max(128),
          path: z.string().min(1).max(32_768),
        })).max(16).optional(),
        releaseManagedArtifacts: z.boolean().default(true),
      },
    },
    async (input) => {
      try {
        let result: Record<string, unknown>;
        if (input.action === "begin") {
          if (!input.title) throw new ObserverCoordinatorError("INVALID_REQUEST", "title is required for observer_run begin");
          result = await application.beginRun({
            title: input.title,
            ...(input.caseIds ? { caseIds: input.caseIds } : {}),
            ...(input.sourceRevision ? { sourceRevision: input.sourceRevision } : {}),
            ...(input.procedureRevision ? { procedureRevision: input.procedureRevision } : {}),
            ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
          });
        } else if (input.action === "status") {
          if (!input.runId) throw new ObserverCoordinatorError("INVALID_REQUEST", "runId is required for observer_run status");
          result = await application.runStatus(input.runId);
        } else if (input.action === "discard") {
          if (!input.runId) throw new ObserverCoordinatorError("INVALID_REQUEST", "runId is required for observer_run discard");
          result = await application.discardRun(input.runId);
        } else {
          if (!input.runId || !input.includeCaptureLabels || !input.review) {
            throw new ObserverCoordinatorError(
              "INVALID_REQUEST",
              "runId, includeCaptureLabels, and review are required for observer_run finalize"
            );
          }
          const evidenceRoots = uniqueEvidenceRoots(defaults.evidenceRoots);
          if (evidenceRoots.length === 0) {
            throw new ObserverCoordinatorError(
              "CAPABILITY_UNAVAILABLE",
              "observer_run finalize requires an evidence destination; supply --project-path, --observer-evidence-root, or observer.evidenceRoots in an optional --config file"
            );
          }
          const evidenceRoot = input.evidenceRoot ??
            (evidenceRoots.length === 1
              ? evidenceRoots[0]
              : undefined);
          if (!evidenceRoot) {
            throw new ObserverCoordinatorError(
              "INVALID_REQUEST",
              "observer_run finalize is ambiguous because multiple evidence roots are configured; provide evidenceRoot explicitly"
            );
          }
          result = await application.finalizeRun({
            runId: input.runId,
            evidenceRoot,
            includeCaptureLabels: input.includeCaptureLabels,
            review: input.review,
            ...(input.runtimeConfig ? { runtimeConfig: input.runtimeConfig } : {}),
            ...(input.supportingFiles ? { supportingFiles: input.supportingFiles } : {}),
            releaseManagedArtifacts: input.releaseManagedArtifacts,
          });
        }
        return { content: [{ type: "text" as const, text: jsonText(`Observer run ${input.action} completed.`, result) }] };
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
