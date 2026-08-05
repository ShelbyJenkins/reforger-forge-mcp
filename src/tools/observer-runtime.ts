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
  action: "start" | "status" | "stop"
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
        "Explicitly start, inspect, or stop one exact-owned graphical Arma Reforger runtime from an observer_prepare_launch descriptor. Start preserves that descriptor's native-fullscreen default or its exceptional forceNonNativeWindowSize choice; this tool has no independent display-size override. Start uses a visible structured spawn without a shell; status and stop require PID, canonical executable, Windows creation time, and an exact owner argument. Stop seals the observer session and refuses until camera restoration is proven.",
      inputSchema: {
        action: z.enum(["start", "status", "stop"]),
        preparedLaunchId: preparedLaunchIdSchema.optional(),
        runtimeId: ownedRuntimeIdSchema.optional(),
        waitForRestorationMs: z.number().int().min(0).max(5 * 60 * 1_000).default(20_000),
      },
    },
    async (input, extra) => {
      try {
        let operation: OwnedRuntimeOperation;
        if (input.action === "start") {
          if (!input.preparedLaunchId) {
            throw new OwnedRuntimeError(
              "INVALID_REQUEST",
              "preparedLaunchId is required for observer_runtime start"
            );
          }
          operation = { action: "start", preparedLaunchId: input.preparedLaunchId };
        } else {
          if (!input.runtimeId) {
          throw new OwnedRuntimeError("INVALID_REQUEST", "runtimeId is required for observer_runtime status and stop");
          }
          operation = input.action === "status"
            ? { action: "status", runtimeId: input.runtimeId }
            : {
                action: "stop",
                runtimeId: input.runtimeId,
                waitForRestorationMs: input.waitForRestorationMs,
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
