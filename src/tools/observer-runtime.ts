import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  OwnedRuntimeError,
  type OwnedRuntimeManager,
} from "../observer/owned-runtime-manager.js";
import {
  projectPublicObserverToolError,
} from "../observer/public-contract.js";
import { resolveObserverRefusalRemedy } from "../observer/refusal-remedy.js";
import {
  deriveObserverRuntimeIdempotencyKey,
  executeOwnedRuntimeOperation,
  extractOwnedRuntimeError,
  ownedRuntimeIdSchema,
  ownedRuntimeSuccessHeading,
  preparedLaunchIdSchema,
  type ObserverRuntimeLifecycleOperation,
  type OwnedRuntimeOperation,
} from "./owned-runtime-operations.js";

export {
  deriveObserverRuntimeIdempotencyKey,
  executeOwnedRuntimeOperation,
  extractOwnedRuntimeError,
  ownedRuntimeIdSchema,
  ownedRuntimeSuccessHeading,
  preparedLaunchIdSchema,
};
export type { ObserverRuntimeLifecycleOperation, OwnedRuntimeOperation };

function jsonText(heading: string, value: unknown): string {
  return `${heading}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function toolError(
  error: unknown,
  action: "start" | "status" | "stop" | "history" | "recover"
) {
  return {
    content: [{
      type: "text" as const,
      text: projectPublicObserverToolError(error, {
        subject: "Observer runtime error",
        extract: extractOwnedRuntimeError,
        remedyContext: {
          tool: "observer_runtime",
          action,
          ...(error instanceof OwnedRuntimeError && error.remedyReason !== undefined
            ? { reason: error.remedyReason }
            : {}),
        },
        resolveRemedy: resolveObserverRefusalRemedy,
        readRemedyContext: () => error instanceof OwnedRuntimeError
          ? error.details
          : undefined,
      }),
    }],
    isError: true,
  };
}

export function registerObserverRuntime(
  server: McpServer,
  manager: OwnedRuntimeManager
): void {
  server.registerTool(
    "observer_runtime",
    {
      description:
        "Explicitly start, inspect, or stop one exact-owned graphical Arma Reforger runtime from an observer_prepare_launch descriptor, or classify and reconcile bounded retained runtime history. Start preserves that descriptor's native-fullscreen default or its exceptional forceNonNativeWindowSize choice; this tool has no independent display-size override. Start uses a visible structured spawn without a shell; status and stop require PID, canonical executable, Windows creation time, and an exact owner argument. Stop seals the observer session and refuses until camera restoration is proven. History is read-only. Recover selects only exact child-exit or already-stopped cleanup evidence, never deletes history, and never terminates a runtime.",
      inputSchema: {
        action: z.enum(["start", "status", "stop", "history", "recover"]),
        preparedLaunchId: preparedLaunchIdSchema.optional(),
        runtimeId: ownedRuntimeIdSchema.optional(),
        waitForRestorationMs: z.number().int().min(0).max(5 * 60 * 1_000).optional(),
        maxRuntimes: z.number().int().min(1).max(128).optional(),
        deadlineMs: z.number().int().min(100).max(5 * 60 * 1_000).optional(),
      },
    },
    async (input, extra) => {
      try {
        if (input.action === "history" || input.action === "recover") {
          if (input.preparedLaunchId || input.runtimeId || input.waitForRestorationMs !== undefined) {
            throw new OwnedRuntimeError(
              "INVALID_REQUEST",
              `observer_runtime ${input.action} accepts only maxRuntimes and deadlineMs`,
            );
          }
          const options = {
            ...(input.maxRuntimes === undefined ? {} : { maxRuntimes: input.maxRuntimes }),
            ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
            signal: extra.signal,
          };
          const result = input.action === "history"
            ? await manager.inspectRuntimeHistory(options)
            : await manager.recoverRuntimeHistory(options);
          const heading = input.action === "history"
            ? "Bounded owned-runtime history classification."
            : "Bounded owned-runtime history recovery.";
          return { content: [{ type: "text" as const, text: jsonText(heading, result) }] };
        }
        if (input.maxRuntimes !== undefined || input.deadlineMs !== undefined) {
          throw new OwnedRuntimeError(
            "INVALID_REQUEST",
            `observer_runtime ${input.action} does not accept history batch options`,
          );
        }
        let operation: OwnedRuntimeOperation;
        if (input.action === "start") {
          if (!input.preparedLaunchId || input.runtimeId || input.waitForRestorationMs !== undefined) {
            throw new OwnedRuntimeError(
              "INVALID_REQUEST",
              "observer_runtime start requires only preparedLaunchId"
            );
          }
          operation = { action: "start", preparedLaunchId: input.preparedLaunchId };
        } else {
          if (!input.runtimeId || input.preparedLaunchId ||
              (input.action === "status" && input.waitForRestorationMs !== undefined)) {
            throw new OwnedRuntimeError(
              "INVALID_REQUEST",
              `observer_runtime ${input.action} requires only its exact runtimeId${input.action === "stop" ? " and optional waitForRestorationMs" : ""}`,
            );
          }
          operation = input.action === "status"
            ? { action: "status", runtimeId: input.runtimeId }
            : {
                action: "stop",
                runtimeId: input.runtimeId,
                waitForRestorationMs: input.waitForRestorationMs ?? 20_000,
              };
        }
        const result = await executeOwnedRuntimeOperation(manager, operation, extra.signal);
        return { content: [{ type: "text" as const, text: jsonText(ownedRuntimeSuccessHeading(operation.action), result) }] };
      } catch (error) {
        return toolError(error, input.action);
      }
    }
  );
}
