import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ObserverCoordinatorError,
  type ObserverCaptureResult,
  type ObserverCoordinator,
} from "./coordinator.js";
import { prepareObserverLaunch } from "./launch.js";
import { runObserverSetup } from "./setup.js";

const finite = () => z.number().finite();

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
const capabilities = [
  "render.capture",
  "camera.runtime",
  "camera.editor",
  "world.query",
  "entity.resolve",
  "authority.server",
  "server.coordinate",
  "transport.rest",
  "transport.mailbox",
] as const;

export interface ObserverToolDefaults {
  sessionTtlMs?: number;
  defaultCaptureTimeoutMs?: number;
}

function jsonText(heading: string, value: unknown): string {
  return `${heading}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function toolError(error: unknown) {
  const code = error instanceof ObserverCoordinatorError ? error.code : "INTERNAL_ERROR";
  const message = error instanceof Error ? error.message : "Observer operation failed";
  const details = error instanceof ObserverCoordinatorError ? error.details : undefined;
  return {
    content: [{
      type: "text" as const,
      text: `Observer error (${code}): ${message.slice(0, 512)}` +
        (details ? `\n\n\`\`\`json\n${JSON.stringify(details, null, 2)}\n\`\`\`` : ""),
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
  coordinator: ObserverCoordinator,
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
        "Manage the private ReforgerForge observer platform. ensure verifies and immutably stages the packaged companion addon; status and doctor report facts; uninstall requests cancellation and refuses until terminal camera restoration, then revokes sessions and removes only unchanged managed files on retry. Never launches or signals Arma Reforger or Workbench.",
      inputSchema: {
        action: z.enum(["ensure", "status", "doctor", "uninstall"]).default("status"),
      },
    },
    async ({ action }) => {
      try {
        return { content: [{ type: "text" as const, text: jsonText(`Observer ${action} completed.`, await runObserverSetup(coordinator, action)) }] };
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
        const prepared = await prepareObserverLaunch(coordinator, input);
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
        requiredCapabilities: z.array(z.enum(capabilities)).max(capabilities.length).default([]),
        renderersOnly: z.boolean().default(false),
        waitMs: z.number().int().min(0).max(5 * 60 * 1_000).default(0),
      },
    },
    async (input, extra) => {
      try {
        const result = await coordinator.instances({ ...input, signal: extra.signal });
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
        "Submit a current-view, explicit-pose, or look-at capture to one compatible observer renderer. sessionId is required for a runtime renderer and optional for an explicitly selected already-running Workbench renderer. Synchronous mode waits for a host-validated PNG and returns exactly one image plus concise metadata; asynchronous mode returns a job ID. Ambiguous renderers are refused, and timeouts request cancellation.",
      inputSchema: {
        sessionId: z.string().min(1).max(96).optional(),
        view: viewSchema,
        instanceId: z.string().min(1).max(96).optional(),
        idempotencyKey: z.string().min(1).max(128).optional(),
        asynchronous: z.boolean().default(false),
        timeoutMs: z.number().int().min(1_000).max(5 * 60 * 1_000)
          .default(defaults.defaultCaptureTimeoutMs ?? coordinator.defaultCaptureTimeoutMs),
        settleFrames: z.number().int().min(0).max(30).default(0),
        performancePolicy: z.enum(["evidence", "instrumented", "performance"]).default("evidence"),
      },
    },
    async (input, extra) => {
      try {
        const result = await coordinator.capture({
          ...input,
          idempotencyKey: input.idempotencyKey ?? `mcp-${randomUUID()}`,
          signal: extra.signal,
        });
        if (result.asynchronous) {
          return { content: [{ type: "text" as const, text: jsonText("Observer capture queued.", result.job) }] };
        }
        if (result.image.length > coordinator.maxInlineImageBytes) {
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
        "Inspect, cancel, or release an observer capture job. sessionId is required for runtime jobs and optional for Workbench jobs returned by this server process. release removes only its retained managed artifact reference and never takes control of an active camera.",
      inputSchema: {
        action: z.enum(["status", "cancel", "release"]),
        sessionId: z.string().min(1).max(96).optional(),
        jobId: z.string().min(1).max(96),
      },
    },
    async ({ action, sessionId, jobId }) => {
      try {
        const result = action === "status"
          ? await coordinator.jobStatus(sessionId, jobId)
          : action === "cancel"
            ? await coordinator.cancelJob(sessionId, jobId)
            : await coordinator.releaseJob(sessionId, jobId);
        return { content: [{ type: "text" as const, text: jsonText(`Observer job ${action} completed.`, result) }] };
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
