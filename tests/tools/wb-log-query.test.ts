import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import { registerTools } from "../../src/server.js";
import {
  registerWbLogQuery,
  type WbLogQueryResult,
} from "../../src/tools/wb-log-query.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

vi.mock("../../src/observer/application.js", () => ({
  createObserverApplication: () => ({
    ownedRuntimeManager: {},
    closeRuntimeLifecycle: async () => ({}),
  }),
}));

vi.mock("../../src/observer/tools.js", () => ({
  registerObserverTools: vi.fn(),
}));

interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly isError?: boolean;
}

interface QueryInput {
  readonly logDirectory: string;
  readonly addonIds?: readonly string[];
  readonly levels?: readonly ("I" | "W" | "E")[];
  readonly channels?: readonly string[];
  readonly pattern?: string;
  readonly maxLines?: number;
}

interface RegisteredTool {
  readonly definition: {
    readonly description?: string;
    readonly inputSchema?: Record<string, {
      readonly description?: string;
      safeParse(value: unknown): { readonly success: boolean; readonly data?: unknown };
    }>;
  };
  readonly handler: (input: QueryInput) => Promise<ToolResult>;
}

function config(managedRoot?: string): Config {
  return {
    workbenchPath: "C:\\Arma Reforger Tools",
    gamePath: "C:\\Arma Reforger",
    dataDir: "C:\\ReforgerForge\\data",
    patternsDir: "C:\\ReforgerForge\\data\\patterns",
    workbenchHost: "127.0.0.1",
    workbenchPort: 5775,
    mcpIdleShutdownMs: 1_800_000,
    ...(managedRoot
      ? { observer: { managedRoot } as Config["observer"] }
      : {}),
  };
}

function register(managedRoot: string): RegisteredTool {
  let registered: RegisteredTool | undefined;
  const server = {
    registerTool(
      name: string,
      definition: RegisteredTool["definition"],
      handler: RegisteredTool["handler"]
    ): void {
      expect(name).toBe("wb_log_query");
      registered = { definition, handler };
    },
  } as unknown as McpServer;
  registerWbLogQuery(server, config(managedRoot));
  expect(registered).toBeDefined();
  return registered!;
}

function resultText(result: ToolResult): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

function resultJson(result: ToolResult): WbLogQueryResult {
  return JSON.parse(resultText(result)) as WbLogQueryResult;
}

function errorJson(result: ToolResult): { readonly ok: false; readonly code: string; readonly message: string } {
  return JSON.parse(resultText(result)) as { readonly ok: false; readonly code: string; readonly message: string };
}

function buildLogDirectory(root: string, name = "build-001"): string {
  const directory = join(root, "workbench-build", "profile", "logs", name);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function editorLogDirectory(root: string, name = "editor-001"): string {
  const directory = join(root, "workbench-helper", "profile", "logs", name);
  mkdirSync(directory, { recursive: true });
  return directory;
}

const FIXTURE_LINES = [
  "SCRIPT       (I): RoadblockRunners outfit: applied playerId=7 team=RED",
  "SCRIPT       (W): RoadblockRunners outfit: no backpack slot playerId=17 team=FAI",
  "ENGINE       (E): Assertion failed: owner != null entity=RR_GameMode playerId=17",
  "RESOURCES    (E): Resources are leaking! count=3 owner=RR_GameMode",
  'RESOURCES    (W): resource not registered: @"$RoadblockRunners:Configs/Runtime/RR_RuntimeConfig.json". Setting null GUID',
  "ENGINE       (E): failed to load addons/addons-scenarios/RoadblockRunners/Configs/Runtime.conf",
  "RoadblockRunners startup banner",
];

function writeFixture(directory: string, name = "workbench.log", lines = FIXTURE_LINES): string {
  const path = join(directory, name);
  writeFileSync(path, lines.join("\r\n"), "utf8");
  return path;
}

describe("wb_log_query MCP tool", () => {
  it("is registered in the complete MCP server surface", async () => {
    const names: string[] = [];
    const server = {
      registerTool(name: string): void {
        names.push(name);
      },
      registerPrompt(): void {},
      registerResource(): void {},
    } as unknown as McpServer;
    const dispose = registerTools(server, config());

    try {
      expect(names.filter((name) => name === "wb_log_query")).toEqual(["wb_log_query"]);
    } finally {
      await dispose();
    }
  });

  it("defines bounded, typed filters", () => {
    const tool = register("C:\\managed");
    const schema = tool.definition.inputSchema!;

    expect(tool.definition.description).toMatch(/timestamped.*editor records/i);
    expect(schema.logDirectory.safeParse("").success).toBe(false);
    expect(schema.logDirectory.safeParse("C:\\managed\\logs\\build-001").success).toBe(true);
    expect(schema.addonIds.safeParse(Array.from({ length: 17 }, () => "Addon")).success).toBe(false);
    expect(schema.levels.safeParse(["F"]).success).toBe(false);
    expect(schema.levels.description).toMatch(/normalized Workbench severity/i);
    expect(schema.pattern.safeParse(" ").success).toBe(false);
    expect(schema.maxLines.safeParse(undefined)).toMatchObject({ success: true, data: 500 });
    expect(schema.maxLines.safeParse(0).success).toBe(false);
    expect(schema.maxLines.safeParse(2_001).success).toBe(false);
  });

  it("filters attributed log lines by every filter independently and returns parsed fields", async () => {
    await withTemporaryDirectory(async (root) => {
      const directory = buildLogDirectory(root);
      writeFixture(directory);
      const handler = register(root).handler;

      const byAddon = resultJson(await handler({
        logDirectory: directory,
        addonIds: ["RoadblockRunners"],
      }));
      expect(byAddon.matchCount).toBe(5);
      expect(byAddon.matches.map((match) => match.matchedAddonIds)).toEqual([
        ["RoadblockRunners"],
        ["RoadblockRunners"],
        ["RoadblockRunners"],
        ["RoadblockRunners"],
        ["RoadblockRunners"],
      ]);
      expect(byAddon.matches.at(-1)).toMatchObject({
        channel: null,
        level: null,
        lineNumber: 7,
        sourceFile: "workbench.log",
      });

      const byLevel = resultJson(await handler({
        logDirectory: directory,
        levels: ["E"],
      }));
      expect(byLevel.matches.map((match) => match.text)).toEqual([
        FIXTURE_LINES[2],
        FIXTURE_LINES[3],
        FIXTURE_LINES[5],
      ]);

      const byChannel = resultJson(await handler({
        logDirectory: directory,
        channels: ["script"],
      }));
      expect(byChannel.matches.map((match) => match.level)).toEqual(["I", "W"]);

      const byPattern = resultJson(await handler({
        logDirectory: directory,
        pattern: "$ROADBLOCKRUNNERS:",
      }));
      expect(byPattern.matches.map((match) => match.channel)).toEqual(["RESOURCES"]);
    }, { prefix: "rfo-wb-log-query-filters-" });
  });

  it("combines supplied filters with AND semantics", async () => {
    await withTemporaryDirectory(async (root) => {
      const directory = buildLogDirectory(root);
      writeFixture(directory);
      const result = resultJson(await register(root).handler({
        logDirectory: directory,
        addonIds: ["RoadblockRunners"],
        levels: ["E"],
      }));

      expect(result).toMatchObject({ fileCount: 1, matchCount: 1, truncated: false });
      expect(result.matches).toEqual([expect.objectContaining({
        sourceFile: "workbench.log",
        lineNumber: 6,
        channel: "ENGINE",
        level: "E",
        matchedAddonIds: ["RoadblockRunners"],
      })]);
    }, { prefix: "rfo-wb-log-query-and-" });
  });

  it("normalizes timestamped editor severity records across every attributed log file", async () => {
    await withTemporaryDirectory(async (root) => {
      const directory = editorLogDirectory(root);
      writeFixture(directory, "console.log", [
        "00:24:31.205     SCRIPT    (E): console compile failure",
        "00:24:31.206     SCRIPT    (W): RoadblockRunners target warning",
      ]);
      writeFixture(directory, "error.log", [
        "00:26:44.802 PATHFINDING(E): error-log navmesh failure",
      ]);
      writeFixture(directory, "script.log", [
        "00:34:04.995 RESOURCES (E): script-log resource failure",
      ]);

      const result = resultJson(await register(root).handler({
        logDirectory: directory,
        levels: ["E"],
      }));

      expect(result).toMatchObject({ fileCount: 3, matchCount: 3, truncated: false });
      expect(result.matches.map((match) => ({
        sourceFile: match.sourceFile,
        channel: match.channel,
        level: match.level,
      }))).toEqual([
        { sourceFile: "console.log", channel: "SCRIPT", level: "E" },
        { sourceFile: "error.log", channel: "PATHFINDING", level: "E" },
        { sourceFile: "script.log", channel: "RESOURCES", level: "E" },
      ]);

      const targetWarning = resultJson(await register(root).handler({
        logDirectory: directory,
        addonIds: ["RoadblockRunners"],
        levels: ["W"],
      }));
      expect(targetWarning.matches).toEqual([expect.objectContaining({
        sourceFile: "console.log",
        lineNumber: 2,
        channel: "SCRIPT",
        level: "W",
        matchedAddonIds: ["RoadblockRunners"],
      })]);
    }, { prefix: "rfo-wb-log-query-editor-severity-" });
  });

  it("scans direct log files in deterministic order and reports truncation at the shared cap", async () => {
    await withTemporaryDirectory(async (root) => {
      const directory = buildLogDirectory(root);
      writeFixture(directory, "z-last.log", [
        "SCRIPT (E): RoadblockRunners second file one",
        "SCRIPT (E): RoadblockRunners second file two",
      ]);
      writeFixture(directory, "a-first.log", [
        "SCRIPT (E): RoadblockRunners first file one",
        "SCRIPT (E): RoadblockRunners first file two",
      ]);
      writeFileSync(join(directory, "ignored.txt"), "SCRIPT (E): RoadblockRunners ignored", "utf8");

      const result = resultJson(await register(root).handler({
        logDirectory: directory,
        pattern: "RoadblockRunners",
        maxLines: 2,
      }));

      expect(result).toMatchObject({ fileCount: 2, matchCount: 2, truncated: true });
      expect(result.matches.map((match) => [match.sourceFile, match.lineNumber])).toEqual([
        ["a-first.log", 1],
        ["a-first.log", 2],
      ]);

      const exactCap = resultJson(await register(root).handler({
        logDirectory: directory,
        pattern: "first file one",
        maxLines: 1,
      }));
      expect(exactCap).toMatchObject({ matchCount: 1, truncated: false });
    }, { prefix: "rfo-wb-log-query-cap-" });
  });

  it("refuses an unfiltered request", async () => {
    await withTemporaryDirectory(async (root) => {
      const directory = buildLogDirectory(root);
      writeFixture(directory);

      const result = await register(root).handler({ logDirectory: directory });

      expect(result.isError).toBe(true);
      expect(errorJson(result)).toMatchObject({ ok: false, code: "INVALID_CONFIG" });
      expect(errorJson(result).message).toMatch(/at least one/i);
    }, { prefix: "rfo-wb-log-query-unfiltered-" });
  });

  it("refuses directories outside the managed receipt roots, missing paths, and reparse points", async () => {
    await withTemporaryDirectory(async (root) => {
      const directory = buildLogDirectory(root);
      writeFixture(directory);
      const outside = join(root, "outside");
      mkdirSync(outside);
      writeFixture(outside, "outside.log");
      const linked = join(root, "workbench-build", "profile", "logs", "linked-session");
      symlinkSync(outside, linked, "junction");
      const handler = register(root).handler;

      for (const logDirectory of [outside, join(root, "missing"), linked]) {
        const result = await handler({ logDirectory, pattern: "RoadblockRunners" });
        expect(result.isError).toBe(true);
        expect(errorJson(result)).toMatchObject({ ok: false, code: "INVALID_CONFIG" });
      }
    }, { prefix: "rfo-wb-log-query-paths-" });
  });

  it("supports the editor receipt layout and redacts returned log text after matching raw content", async () => {
    await withTemporaryDirectory(async (root) => {
      const directory = editorLogDirectory(root);
      const secret = "wb-log-query-secret";
      writeFixture(directory, "editor.log", [
        `SCRIPT (E): RoadblockRunners token=${secret} C:\\Users\\Example\\private.log${"x".repeat(5_000)}`,
      ]);

      const result = resultJson(await register(root).handler({
        logDirectory: directory,
        pattern: secret,
      }));

      expect(result.matchCount).toBe(1);
      expect(result.matches[0].text).not.toContain(secret);
      expect(result.matches[0].text).toContain("token=[redacted]");
      expect(result.matches[0].text).not.toContain("C:\\Users\\Example");
      expect(result.matches[0].text.length).toBeLessThanOrEqual(4_096);
    }, { prefix: "rfo-wb-log-query-redact-" });
  });
});
