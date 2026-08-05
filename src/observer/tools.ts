import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import type { ObserverApplication, ObserverCaptureResult } from "./application.js";
import { CaptureError } from "./capture-contract.js";
import { ActiveRunContext } from "./active-run-context.js";
import { decodeCaptureTarget } from "./capture-target.js";
import { resolveExpectedWorldRevision } from "./capture-request.js";
import { ObserverApplicationError } from "./errors.js";
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
import {
  resolveObserverRefusalRemedy,
  type ObserverRefusalContext,
} from "./refusal-remedy.js";

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
const imageOutputSchema = z.object({
  maxWidth: z.number().int().min(1).max(16_384).optional(),
  maxHeight: z.number().int().min(1).max(16_384).optional(),
  format: z.enum(["png", "jpeg", "webp"]).default("png"),
  quality: z.number().int().min(1).max(100).optional(),
}).refine(
  (value) => value.format !== "png" || value.quality === undefined,
  { message: "quality is valid only for jpeg or webp output", path: ["quality"] },
).refine(
  (value) => value.maxWidth === undefined || value.maxHeight === undefined ||
    value.maxWidth * value.maxHeight <= 32_000_000,
  { message: "requested image bounds exceed the 32000000-pixel limit" },
);
const runIdSchema = z.string().regex(/^\d{8}T\d{6}Z-[a-f0-9]{8}$/);
const reviewSchema = z.object({
  imagesReviewed: z.boolean(),
  reviewer: z.string().min(1).max(256).optional(),
  outcome: z.enum(["Passed", "Failed", "Inconclusive", "Unreviewed"]),
  summary: z.string().min(1).max(2_048),
  limitations: z.array(z.string().min(1).max(512)).max(32).optional(),
});
const runtimeConfigSchema = z.object({
  configurationId: z.string().min(1).max(128),
  values: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.null()])),
});
const supportingFilesSchema = z.array(z.union([
  z.object({
    kind: z.literal("relevantLog"),
    label: z.string().min(1).max(128),
    path: z.string().min(1).max(32_768),
  }).strict(),
  z.object({
    kind: z.literal("relevantLog"),
    label: z.string().min(1).max(128),
    sourceCaptureLabel: z.string().min(1).max(128),
  }).strict(),
])).max(16);
const forceNonNativeWindowSizeSchema = z.object({
  width: z.number().int().min(640).max(16_384).describe(
    "Exceptional window width in pixels.",
  ),
  height: z.number().int().min(480).max(16_384).describe(
    "Exceptional window height in pixels.",
  ),
  justification: z.string().trim().min(20).max(512).describe(
    "Why native fullscreen cannot be used. Screenshot size is not a valid reason; bound observer_capture image output instead.",
  ),
}).strict().describe(
  "Exceptional opt-in to a non-native window size. Omit this field for the native fullscreen default.",
);
const RAW_DISPLAY_ARGUMENTS = new Set(["-window", "-screenwidth", "-screenheight"]);

function rawDisplayArgument(argumentsArray: readonly string[]): string | undefined {
  return argumentsArray.find((token) =>
    RAW_DISPLAY_ARGUMENTS.has(token.split("=", 1)[0].toLowerCase()),
  );
}

function assertNativeFullscreenLaunch(input: {
  runtimeKind: string;
  arguments: readonly string[];
  forceNonNativeWindowSize?: unknown;
}): void {
  const conflicting = rawDisplayArgument(input.arguments);
  if (conflicting) {
    throw new ObserverApplicationError(
      "ARGUMENT_CONFLICT",
      `${conflicting} cannot be supplied through arguments. Omit display overrides for native fullscreen, or use forceNonNativeWindowSize with explicit dimensions and a compelling justification.`,
    );
  }
  if (input.runtimeKind === "dedicated" && input.forceNonNativeWindowSize !== undefined) {
    throw new ObserverApplicationError(
      "INVALID_REQUEST",
      "forceNonNativeWindowSize is valid only for a graphical runtime",
    );
  }
}
export interface ObserverToolDefaults {
  sessionTtlMs?: number;
  defaultCaptureTimeoutMs?: number;
  workbenchClient?: WorkbenchClient;
  /** Ordered add-on roots resolved from the active MCP configuration. */
  workbenchAddonDirs?: readonly string[];
  evidenceRoots?: readonly string[];
  ownedRuntimeManager?: OwnedRuntimeManager;
}

/**
 * Put configuration-owned roots ahead of caller roots, then let the private
 * observer agent perform the single canonical `-addonsDir` normalization. Its
 * merger preserves this order and removes duplicates after resolving paths.
 */
export function mergeConfiguredAddonDirectories(
  argumentsArray: readonly string[],
  configuredAddonDirs: readonly string[] | undefined,
): string[] {
  if (!configuredAddonDirs || configuredAddonDirs.length === 0) {
    return [...argumentsArray];
  }
  return ["-addonsDir", configuredAddonDirs.join(","), ...argumentsArray];
}

function jsonText(heading: string, value: unknown): string {
  return `${heading}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function extractObserverApplicationError(error: unknown): PublicObserverErrorCandidate | undefined {
  if (!(error instanceof ObserverApplicationError)) return undefined;
  return {
    code: error.code,
    readDiagnosticMessage: () => error.message,
    readDetails: () => error.details,
  };
}

function toolError(error: unknown, context: ObserverRefusalContext) {
  return {
    content: [{
      type: "text" as const,
      text: projectPublicObserverToolError(error, {
        subject: "Observer error",
        extract: extractObserverApplicationError,
        remedyContext: context,
        resolveRemedy: resolveObserverRefusalRemedy,
        readRemedyContext: () => error instanceof ObserverApplicationError
          ? error.details
          : undefined,
      }),
    }],
    isError: true,
  };
}

/**
 * The MCP schema rejects a missing field; this boundary also validates the
 * opaque token payload. Keep direct handler calls aligned with the application
 * boundary and preserve the projected Observer error shape.
 */
function assertCaptureWorldBinding(input: {
  expectedWorldRevision: string;
}): void {
  try {
    resolveExpectedWorldRevision(input);
  } catch (error) {
    if (error instanceof CaptureError) {
      throw new ObserverApplicationError(error.code, error.message, error.details);
    }
    throw error;
  }
}

function capturePresentation(result: Extract<ObserverCaptureResult, { asynchronous: false }>): Record<string, unknown> {
  const artifact = result.job.artifact && typeof result.job.artifact === "object"
    ? result.job.artifact as Record<string, unknown>
    : {};
  const metadata = result.metadata;
  return {
    jobId: result.job.jobId,
    runId: result.job.runId ?? null,
    captureLabel: result.job.captureLabel ?? null,
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
    format: metadata.format ?? null,
    mimeType: metadata.mimeType ?? null,
    bytes: metadata.bytes ?? result.image.length,
    requestedImage: metadata.requestedImage ?? null,
    quality: metadata.imageQuality ?? null,
    sha256: metadata.contentSha256 ?? null,
    warnings: metadata.warnings ?? artifact.warnings ?? [],
    contaminated: metadata.contaminated ?? artifact.contaminated ?? false,
    cleanup: result.cleanup ?? null,
    cleanupRequired: result.cleanupRequired === true,
    cleanupWarning: result.cleanupWarning ?? null,
  };
}

function validatedImageMimeType(image: Buffer, metadata: Record<string, unknown>): "image/png" | "image/jpeg" | "image/webp" {
  const mimeType = metadata.mimeType;
  const png = image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = image.length >= 4 && image[0] === 0xff && image[1] === 0xd8 &&
    image[image.length - 2] === 0xff && image[image.length - 1] === 0xd9;
  const webp = image.length >= 12 && image.toString("ascii", 0, 4) === "RIFF" &&
    image.toString("ascii", 8, 12) === "WEBP";
  if (mimeType === undefined) {
    if (png) return "image/png";
    if (jpeg) return "image/jpeg";
    if (webp) return "image/webp";
  }
  if ((mimeType === "image/png" && png) || (mimeType === "image/jpeg" && jpeg) ||
      (mimeType === "image/webp" && webp)) return mimeType;
  throw new ObserverApplicationError("ARTIFACT_INVALID", "Observer agent returned an image that does not match its MIME type");
}

export function registerObserverTools(
  server: McpServer,
  application: ObserverApplication,
  defaults: ObserverToolDefaults = {}
): void {
  const sessionTtlMs = defaults.sessionTtlMs ?? 20 * 60 * 1_000;
  const activeRun = new ActiveRunContext();
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1_000 || sessionTtlMs > 24 * 60 * 60 * 1_000) {
    throw new ObserverApplicationError("INVALID_REQUEST", "Observer session TTL must be from 1000 through 86400000 milliseconds");
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
                  ? { client: defaults.workbenchClient }
                  : undefined
              )
            ),
          }],
        };
      } catch (error) {
        return toolError(error, { tool: "observer_setup", action });
      }
    }
  );

  server.registerTool(
    "observer_prepare_launch",
    {
      description:
        "Prepare an Arma Reforger launch for the staged observer addon and an exclusive profile session; no process is started. Graphical launches use the engine's native borderless-fullscreen window by default. Raw -window, -screenWidth, and -screenHeight arguments are refused. Use forceNonNativeWindowSize only when native fullscreen cannot be used for a compelling reason; screenshot size is handled by observer_capture image bounds and is not a reason to shrink the launch. Defaults -noFocus and -forceUpdate keep the fullscreen runtime from stealing startup focus.",
      inputSchema: {
        runtimeKind: z.enum(["client", "listenServer", "dedicated", "testRunner"]),
        arguments: z.array(z.string().max(32_768)).max(512).default([]).describe(
          "Additional engine argument tokens. Do not include -window, -screenWidth, or -screenHeight; native fullscreen is the default.",
        ),
        profilePath: z.string().min(1).max(32_768),
        sessionTtlMs: z.number().int().min(1_000).max(24 * 60 * 60 * 1_000)
          .default(sessionTtlMs),
        transportPreference: z.array(z.enum(["rest", "mailbox"])).min(1).max(2).default(["rest", "mailbox"]),
        forceUpdate: z.boolean().default(true),
        noFocus: z.boolean().default(true),
        forceNonNativeWindowSize: forceNonNativeWindowSizeSchema.optional(),
        idempotencyKey: z.string().min(1).max(128).optional(),
      },
    },
    async (input) => {
      const remedyReason = rawDisplayArgument(input.arguments) === undefined
        ? undefined
        : "display_arguments" as const;
      try {
        assertNativeFullscreenLaunch(input);
        const prepared = await prepareObserverLaunch(
          application,
          {
            ...input,
            arguments: mergeConfiguredAddonDirectories(
              input.arguments,
              defaults.workbenchAddonDirs,
            ),
          },
          defaults.ownedRuntimeManager
        );
        return { content: [{ type: "text" as const, text: jsonText("Observer launch arguments prepared; no process was started.", prepared) }] };
      } catch (error) {
        return toolError(error, {
          tool: "observer_prepare_launch",
          action: "prepare",
          ...(remedyReason === undefined ? {} : { reason: remedyReason }),
        });
      }
    }
  );

  server.registerTool(
    "observer_instances",
    {
      description:
        "List live and stale observer runtime instances with capabilities, transport, required opaque world revision, diagnostic world ID/epoch projections, active job, and health. Optionally wait for compatible live instances. Headless runtimes are excluded whenever renderersOnly is true.",
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
        return toolError(error, {
          tool: "observer_instances",
          action: "list",
          ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        });
      }
    }
  );

  server.registerTool(
    "observer_capture",
    {
      description:
        "Capture the current view by default. With one compatible renderer, an empty request delegates selection; otherwise pass one opaque target from observer_instances. A process-local active run is used when runId is omitted, capture labels are allocated durably when omitted, and captures with no run are automatically released after delivery. Legacy sessionId/instanceId/expectedWorldRevision selection remains mutually exclusive with target.",
      inputSchema: {
        runId: z.string().regex(/^\d{8}T\d{6}Z-[a-f0-9]{8}$/).optional(),
        captureLabel: z.string().min(1).max(128).optional(),
        purpose: z.string().min(1).max(512).optional(),
        target: z.string().min(5).max(8_192).optional(),
        sessionId: z.string().min(1).max(96).optional(),
        view: viewSchema.default({ kind: "current" }),
        instanceId: z.string().min(1).max(96).optional(),
        idempotencyKey: z.string().min(1).max(128).optional(),
        asynchronous: z.boolean().default(false),
        timeoutMs: z.number().int().min(1_000).max(5 * 60 * 1_000)
          .default(defaults.defaultCaptureTimeoutMs ?? application.defaultCaptureTimeoutMs),
        settleFrames: z.number().int().min(0).max(30).default(0),
        expectedWorldRevision: z.string().regex(/^wr1\.(?:runtime|workbench)\.[A-Za-z0-9_-]+$/).optional().describe(
          "Legacy compatibility binding from observer_instances. Prefer target."
        ),
        performancePolicy: z.enum(["evidence", "instrumented"]).default("evidence"),
        image: imageOutputSchema.optional(),
      },
    },
    async (input, extra) => {
      let remedySessionId = input.sessionId;
      try {
        const legacySupplied = input.sessionId !== undefined || input.instanceId !== undefined || input.expectedWorldRevision !== undefined;
        if (input.target && legacySupplied) {
          throw new ObserverApplicationError("INVALID_REQUEST", "target cannot be combined with legacy sessionId, instanceId, or expectedWorldRevision fields");
        }
        let target: ReturnType<typeof decodeCaptureTarget> | undefined;
        try { target = input.target ? decodeCaptureTarget(input.target) : undefined; }
        catch (error) {
          if (error instanceof CaptureError) throw new ObserverApplicationError(error.code, error.message, error.details);
          throw error;
        }
        remedySessionId = target?.sessionId ?? remedySessionId;
        if (!target && legacySupplied) assertCaptureWorldBinding(input as { expectedWorldRevision: string });
        const runId = activeRun.resolve(input.runId);
        if (input.captureLabel && !runId) {
          throw new ObserverApplicationError("INVALID_REQUEST", "captureLabel requires an explicit or active run");
        }
        const { target: _target, ...captureInput } = input;
        const result = await application.capture({
          ...captureInput,
          ...(target ? {
            ...(target.sessionId ? { sessionId: target.sessionId } : {}),
            instanceId: target.instanceId,
            expectedWorldRevision: target.expectedWorldRevision,
            selectionMode: "explicit" as const,
          } : { selectionMode: legacySupplied ? "explicit" as const : "delegated" as const }),
          ...(runId ? { runId } : {}),
          idempotencyKey: input.idempotencyKey ?? `mcp-${randomUUID()}`,
          signal: extra.signal,
        });
        if (result.asynchronous) {
          return { content: [{ type: "text" as const, text: jsonText("Observer capture queued.", result.job) }] };
        }
        if (result.image.length > application.maxInlineImageBytes) {
          throw new ObserverApplicationError(
            "ARTIFACT_TOO_LARGE",
            "Validated image exceeds the configured MCP inline limit",
            { job: result.job }
          );
        }
        const mimeType = validatedImageMimeType(result.image, result.metadata);
        return {
          content: [
            { type: "image" as const, data: result.image.toString("base64"), mimeType },
            { type: "text" as const, text: jsonText("Observer capture completed.", capturePresentation(result)) },
          ],
        };
      } catch (error) {
        return toolError(error, {
          tool: "observer_capture",
          action: "capture",
          ...(remedySessionId === undefined ? {} : { sessionId: remedySessionId }),
        });
      }
    }
  );

  server.registerTool(
    "observer_job",
    {
      description:
        "Inspect, read, cancel, or release an observer capture job by its process-local job handle. Successful reads and safe cancellation automatically release runless transactions; artifacts retained by an open run cannot be released independently.",
      inputSchema: {
        action: z.enum(["status", "read", "cancel", "release"]),
        jobId: z.string().min(1).max(96),
      },
    },
    async ({ action, jobId }) => {
      try {
        if (action === "read") {
          const result = await application.readJob(jobId);
          const mimeType = validatedImageMimeType(result.image, result.metadata);
          return {
            content: [
              { type: "image" as const, data: result.image.toString("base64"), mimeType },
              { type: "text" as const, text: jsonText("Observer completed artifact.", capturePresentation({ asynchronous: false, ...result })) },
            ],
          };
        }
        const result = action === "status"
          ? await application.jobStatus(jobId)
          : action === "cancel"
            ? await application.cancelJob(jobId)
            : await application.releaseJob(jobId);
        return { content: [{ type: "text" as const, text: jsonText(`Observer job ${action} completed.`, result) }] };
      } catch (error) {
        return toolError(error, { tool: "observer_job", action });
      }
    }
  );

  if (defaults.ownedRuntimeManager) {
    registerObserverRuntime(server, defaults.ownedRuntimeManager);
  }

  server.registerTool(
    "observer_run_begin",
    {
      description: "Begin a durable evidence run and make it the active run in this MCP process. Captures can then omit runId and captureLabel; review remains mandatory at finalization.",
      inputSchema: {
        title: z.string().min(1).max(256),
        caseIds: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/)).max(64).optional(),
        sourceRevision: z.string().min(1).max(256).optional(),
        procedureRevision: z.string().min(1).max(256).optional(),
        idempotencyKey: z.string().min(1).max(128).optional(),
      },
    },
    async (input) => {
      try {
        const result = await application.beginRun(input);
        if (typeof result.runId !== "string") throw new ObserverApplicationError("TRANSPORT_UNAVAILABLE", "Run begin did not return a run ID");
        activeRun.activate(result.runId);
        return { content: [{ type: "text" as const, text: jsonText("Observer run begun and activated.", result) }] };
      } catch (error) {
        return toolError(error, { tool: "observer_run_begin", action: "begin" });
      }
    },
  );

  server.registerTool(
    "observer_run_status",
    {
      description: "Report the explicit run or this MCP process's active run, including allocated capture labels and artifact availability.",
      inputSchema: { runId: runIdSchema.optional() },
    },
    async ({ runId }) => {
      try {
        const resolved = activeRun.resolve(runId);
        if (!resolved) throw new ObserverApplicationError("INVALID_REQUEST", "runId is required when this MCP process has no active run");
        const result = await application.runStatus(resolved);
        return { content: [{ type: "text" as const, text: jsonText("Observer run status.", result) }] };
      } catch (error) {
        return toolError(error, { tool: "observer_run_status", action: "status" });
      }
    },
  );

  server.registerTool(
    "observer_run_finalize",
    {
      description: "Finalize the explicit or active run into an allowlisted evidence root. A non-empty set of reviewed capture labels and an explicit review are always required.",
      inputSchema: {
        runId: runIdSchema.optional(),
        evidenceRoot: z.string().min(1).max(32_768).optional(),
        includeCaptureLabels: z.array(z.string().min(1).max(128)).min(1).max(64),
        review: reviewSchema,
        runtimeConfig: runtimeConfigSchema.optional(),
        supportingFiles: supportingFilesSchema.optional(),
        releaseManagedArtifacts: z.boolean().default(true),
      },
    },
    async (input) => {
      try {
        const runId = activeRun.resolve(input.runId);
        if (!runId) throw new ObserverApplicationError("INVALID_REQUEST", "runId is required when this MCP process has no active run");
        const evidenceRoots = uniqueEvidenceRoots(defaults.evidenceRoots);
        if (evidenceRoots.length === 0) {
          throw new ObserverApplicationError("CAPABILITY_UNAVAILABLE", "observer_run_finalize requires an evidence destination; supply --observer-evidence-root or observer.evidenceRoots in an optional --config file");
        }
        const evidenceRoot = input.evidenceRoot ?? (evidenceRoots.length === 1 ? evidenceRoots[0] : undefined);
        if (!evidenceRoot) {
          throw new ObserverApplicationError("INVALID_REQUEST", "observer_run_finalize is ambiguous because multiple evidence roots are configured; provide evidenceRoot explicitly");
        }
        const result = await application.finalizeRun({
          runId,
          evidenceRoot,
          includeCaptureLabels: input.includeCaptureLabels,
          review: input.review,
          ...(input.runtimeConfig ? { runtimeConfig: input.runtimeConfig } : {}),
          ...(input.supportingFiles ? { supportingFiles: input.supportingFiles } : {}),
          releaseManagedArtifacts: input.releaseManagedArtifacts,
        });
        activeRun.clearIf(runId);
        return { content: [{ type: "text" as const, text: jsonText("Observer run finalized.", result) }] };
      } catch (error) {
        return toolError(error, { tool: "observer_run_finalize", action: "finalize" });
      }
    },
  );

  server.registerTool(
    "observer_run_discard",
    {
      description: "Discard the explicit or active unfinalized run, release its retained artifacts, and clear it only if it is this process's active run.",
      inputSchema: { runId: runIdSchema.optional() },
    },
    async ({ runId: explicitRunId }) => {
      try {
        const runId = activeRun.resolve(explicitRunId);
        if (!runId) throw new ObserverApplicationError("INVALID_REQUEST", "runId is required when this MCP process has no active run");
        const result = await application.discardRun(runId);
        activeRun.clearIf(runId);
        return { content: [{ type: "text" as const, text: jsonText("Observer run discarded.", result) }] };
      } catch (error) {
        return toolError(error, { tool: "observer_run_discard", action: "discard" });
      }
    },
  );
}
