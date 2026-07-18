import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  OwnedRuntimeError,
  type OwnedRuntimeManager,
} from "../observer/owned-runtime-manager.js";

function jsonText(heading: string, value: unknown): string {
  return `${heading}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function toolError(error: unknown) {
  const code = error instanceof OwnedRuntimeError ? error.code : "INTERNAL_ERROR";
  const message = error instanceof Error ? error.message : "Owned runtime operation failed";
  const details = error instanceof OwnedRuntimeError ? error.details : undefined;
  return {
    content: [{
      type: "text" as const,
      text: `Observer runtime error (${code}): ${message.slice(0, 512)}` +
        (details ? `\n\n\`\`\`json\n${JSON.stringify(details, null, 2)}\n\`\`\`` : ""),
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
        "Explicitly start, inspect, or stop one exact-owned graphical Arma Reforger runtime from an observer_prepare_launch descriptor. Start uses a visible structured spawn without a shell; status and stop require PID, canonical executable, Windows creation time, and an exact owner argument. Stop seals the observer session and refuses until camera restoration is proven.",
      inputSchema: {
        action: z.enum(["start", "status", "stop"]),
        preparedLaunchId: z.string().regex(/^pl-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/).optional(),
        runtimeId: z.string().regex(/^rt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/).optional(),
        waitForRestorationMs: z.number().int().min(0).max(5 * 60 * 1_000).default(20_000),
        idempotencyKey: z.string().min(1).max(128).optional(),
      },
    },
    async (input, extra) => {
      try {
        if (input.action === "start") {
          if (!input.preparedLaunchId || !input.idempotencyKey) {
            throw new OwnedRuntimeError(
              "INVALID_REQUEST",
              "preparedLaunchId and idempotencyKey are required for observer_runtime start"
            );
          }
          const result = await manager.start({
            preparedLaunchId: input.preparedLaunchId,
            idempotencyKey: input.idempotencyKey,
          });
          return { content: [{ type: "text" as const, text: jsonText("Exact-owned observer runtime started.", result) }] };
        }
        if (!input.runtimeId) {
          throw new OwnedRuntimeError("INVALID_REQUEST", "runtimeId is required for observer_runtime status and stop");
        }
        if (input.action === "status") {
          const result = await manager.status(input.runtimeId);
          return { content: [{ type: "text" as const, text: jsonText("Exact-owned observer runtime status.", result) }] };
        }
        if (!input.idempotencyKey) {
          throw new OwnedRuntimeError("INVALID_REQUEST", "idempotencyKey is required for observer_runtime stop");
        }
        const result = await manager.stop({
          runtimeId: input.runtimeId,
          waitForRestorationMs: input.waitForRestorationMs,
          idempotencyKey: input.idempotencyKey,
          signal: extra.signal,
        });
        return { content: [{ type: "text" as const, text: jsonText("Exact-owned observer runtime stopped.", result) }] };
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
