import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { registerWbRestart } from "../../src/tools/wb-restart.js";
import { registerWbShutdown } from "../../src/tools/wb-shutdown.js";
import { registerWbState } from "../../src/tools/wb-state.js";
import {
  WorkbenchError,
  type WorkbenchClient,
} from "../../src/workbench/client.js";

interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly isError?: boolean;
}

type ToolHandler = (input: Record<string, never>) => Promise<ToolResult>;

function capture(
  registrar: (server: McpServer) => void
): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    registerTool(
      _name: string,
      _definition: unknown,
      candidate: ToolHandler
    ): void {
      handler = candidate;
    },
  } as unknown as McpServer;
  registrar(server);
  expect(handler).toBeDefined();
  return handler!;
}

function text(result: ToolResult): string {
  return result.content.map((entry) => entry.text ?? "").join("\n");
}

function client(overrides: Partial<WorkbenchClient>): WorkbenchClient {
  return {
    state: { connected: false, mode: "unknown", lastUpdated: 0 },
    ...overrides,
  } as unknown as WorkbenchClient;
}

describe("Workbench refusal tool boundaries", () => {
  it("formats shutdown and restart codes with a real em dash and one typed action", async () => {
    const raw = "raw path C:\\mods\\One\nsecond line";
    const shutdown = capture((server) => registerWbShutdown(server, client({
      shutdownOwnedWorkbench: vi.fn(async () => {
        throw new WorkbenchError(raw, "CONNECTION_REFUSED");
      }),
    })));
    const restart = capture((server) => registerWbRestart(server, client({
      restartOwnedWorkbench: vi.fn(async () => {
        throw new WorkbenchError(raw, "OWNED_BY_OTHER_MCP");
      }),
    })));

    for (const result of [await shutdown({}), await restart({})]) {
      const rendered = text(result);
      expect(result.isError).toBe(true);
      expect(rendered).toContain(raw);
      expect(rendered).toMatch(/`[A-Z_]+` — /);
      expect(rendered).not.toContain("â€”");
      expect(rendered.match(/Next action:/g)).toHaveLength(1);
    }
  });

  it("keeps wb_state's existing wrapper instead of adding a code envelope", async () => {
    const state = capture((server) => registerWbState(server, client({
      call: vi.fn(async () => {
        throw new WorkbenchError("endpoint unavailable", "CONNECTION_REFUSED");
      }),
    })));

    const result = await state({});
    const rendered = text(result);

    expect(rendered).toContain("Error getting Workbench state: endpoint unavailable");
    expect(rendered).not.toContain("`CONNECTION_REFUSED`");
    expect(rendered.match(/Next action:/g)).toHaveLength(1);
  });

  it("retains generic error handling at all three boundaries", async () => {
    const shutdown = capture((server) => registerWbShutdown(server, client({
      shutdownOwnedWorkbench: vi.fn(async () => {
        throw new Error("generic shutdown");
      }),
    })));
    const restart = capture((server) => registerWbRestart(server, client({
      restartOwnedWorkbench: vi.fn(async () => {
        throw new Error("generic restart");
      }),
    })));
    const state = capture((server) => registerWbState(server, client({
      call: vi.fn(async () => {
        throw new Error("generic state");
      }),
    })));

    expect(text(await shutdown({}))).toContain("generic shutdown");
    expect(text(await restart({}))).toContain("generic restart");
    expect(text(await state({}))).toContain("Error getting Workbench state: generic state");
  });
});
