import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { registerAnimationGraph } from "../../src/tools/animation-graph.js";
import { registerBuildingSetup } from "../../src/tools/building-setup.js";
import { registerGameDuplicate } from "../../src/tools/game-duplicate.js";
import { registerMod } from "../../src/tools/mod.js";
import { registerProject } from "../../src/tools/project.js";
import { registerWbEntityDuplicate } from "../../src/tools/wb-entity-duplicate.js";
import { registerWorkshopInfo } from "../../src/tools/workshop-info.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

function projectNeutralConfig(): Config {
  return {
    workbenchPath: "C:\\Arma Reforger Tools",
    gamePath: "C:\\Arma Reforger",
    dataDir: "C:\\ReforgerForge\\data",
    patternsDir: "C:\\ReforgerForge\\data\\patterns",
    workbenchHost: "127.0.0.1",
    workbenchPort: 5775,
    mcpIdleShutdownMs: 1_800_000,
  };
}

function registry(
  register: (server: McpServer, config: Config) => void
): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool(
      name: string,
      _definition: unknown,
      handler: ToolHandler
    ): void {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  register(server, projectNeutralConfig());
  return handlers;
}

function text(result: ToolResult): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

describe("project-neutral server tool behavior", () => {
  it("returns ADDON_TARGET_REQUIRED when an operation needs a project target", async () => {
    const cases: Array<{
      name: string;
      handlers: Map<string, ToolHandler>;
      input: Record<string, unknown>;
    }> = [
      {
        name: "building_setup",
        handlers: registry(registerBuildingSetup),
        input: { manifestPath: "C:\\missing.json", modPrefix: "", dryRun: false },
      },
      {
        name: "game_duplicate",
        handlers: registry((server, config) =>
          registerGameDuplicate(server, config, { activeProjectGprojPath: async () => null } as never)
        ),
        input: {
          sourcePath: "Prefabs/Test.et",
          destPath: "Prefabs/Test.et",
          flatten: false,
          register: false,
        },
      },
      {
        name: "wb_entity_duplicate",
        handlers: registry((server, config) =>
          registerWbEntityDuplicate(server, config, {
            state: { connected: true, mode: "edit" },
            call: async () => ({ mode: "edit" }),
            activeProjectGprojPath: async () => null,
          } as never)
        ),
        input: {
          entityName: "Entity",
          destPath: "Prefabs/Entity.et",
          replaceInScene: true,
        },
      },
      {
        name: "project",
        handlers: registry((server) => registerProject(server)),
        input: { action: "browse", path: ".", createDirectories: true },
      },
      {
        name: "workshop_info",
        handlers: registry((server) => registerWorkshopInfo(server)),
        input: {},
      },
      {
        name: "mod",
        handlers: registry((server, config) =>
          registerMod(server, config, {} as never, {} as never)
        ),
        input: { action: "validate", checks: ["structure"] },
      },
      {
        name: "animation_graph",
        handlers: registry(registerAnimationGraph),
        input: {
          action: "setup",
          setupSubAction: "suggest",
          source: "mod",
          agfPath: "Animations/Missing.agf",
        },
      },
      {
        name: "animation_graph",
        handlers: registry(registerAnimationGraph),
        input: {
          action: "setup",
          setupSubAction: "setup",
          vehicleName: "Vehicle",
          step: "agr",
        },
      },
    ];

    for (const testCase of cases) {
      const result = await testCase.handlers.get(testCase.name)!(testCase.input);
      expect(result.isError, testCase.name).toBe(true);
      expect(text(result), testCase.name).toContain("ADDON_TARGET_REQUIRED");
    }
  });

  it("allows mod validation with an exact gprojPath and no running Workbench", async () => {
    await withTemporaryDirectory(async (root) => {
      writeFileSync(join(root, "Target.gproj"), "GameProject {}\n", "utf-8");
      const handlers = registry((server, config) =>
        registerMod(server, config, {} as never, {} as never)
      );

      const result = await handlers.get("mod")!({
        action: "validate",
        gprojPath: join(root, "Target.gproj"),
        checks: ["structure"],
      });

      expect(text(result)).not.toContain("ADDON_TARGET_REQUIRED");
      expect(text(result)).toContain("Validation");
    }, { prefix: "rfo-optional-project-" });
  });

  it("accepts an explicit building output without a project target", async () => {
    const handlers = registry(registerBuildingSetup);

    const result = await handlers.get("building_setup")!({
      manifestPath: "C:\\missing-building-manifest.json",
      outputDir: "C:\\explicit-output",
      modPrefix: "",
      dryRun: true,
    });

    expect(text(result)).not.toContain("ADDON_TARGET_REQUIRED");
    expect(text(result)).toContain("Error reading manifest");
  });
});
