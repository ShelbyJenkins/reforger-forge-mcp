import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { registerAnimationGraph } from "../../src/tools/animation-graph.js";
import {
  resolveAddonRoot,
  resolveOptionalAddonRoot,
  type ActiveProjectProvider,
} from "../../src/utils/game-paths.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

function config(): Config {
  return {
    workbenchPath: "C:\\Arma Reforger Tools",
    gamePath: "C:\\Arma Reforger",
    dataDir: "C:\\ReforgerForge\\data",
    patternsDir: "C:\\ReforgerForge\\data\\patterns",
    workbenchHost: "127.0.0.1",
    workbenchPort: 5775,
  };
}

function createAddon(container: string, name: string): { root: string; gprojPath: string } {
  const root = join(container, name);
  const gprojPath = join(root, `${name}.gproj`);
  mkdirSync(root, { recursive: true });
  writeFileSync(gprojPath, "GameProject {}\n", "utf-8");
  return { root, gprojPath };
}

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}>;

function animationGraphHandler(provider?: ActiveProjectProvider): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    registerTool(_name: string, _definition: unknown, callback: ToolHandler): void {
      handler = callback;
    },
  } as unknown as McpServer;
  registerAnimationGraph(server, config(), provider);
  return handler!;
}

describe("addon target resolution", () => {
  it("resolves only an exact gproj or the verified active project", async () => {
    await withTemporaryDirectory(async (container) => {
      const alpha = createAddon(container, "Alpha");
      const beta = createAddon(container, "Beta");
      const provider: ActiveProjectProvider = {
        activeProjectGprojPath: async () => beta.gprojPath,
      };

      await expect(resolveAddonRoot(undefined, {
        operation: "project write",
        gprojPath: alpha.gprojPath,
      })).resolves.toBe(alpha.root);
      await expect(resolveAddonRoot(provider, {
        operation: "script_create",
      })).resolves.toBe(beta.root);
      await expect(resolveAddonRoot(undefined, {
        operation: "game_duplicate",
      })).rejects.toThrow(/ADDON_TARGET_REQUIRED/);
      await expect(resolveOptionalAddonRoot(undefined, {
        operation: "prefab create",
      })).resolves.toBeNull();
      await expect(resolveAddonRoot(undefined, {
        operation: "project write",
        gprojPath: container,
      })).rejects.toThrow(/INVALID_ADDON_TARGET/);
    }, { prefix: "rfo-addon-target-" });
  });

  it("routes animation graph authoring through gprojPath", async () => {
    await withTemporaryDirectory(async (container) => {
      createAddon(container, "Alpha");
      const beta = createAddon(container, "Beta");
      const handler = animationGraphHandler();

      const result = await handler({
        action: "author",
        vehicleName: "TargetTruck",
        vehicleType: "wheeled",
        wheelCount: 4,
        hasTurret: false,
        hasSuspensionIK: true,
        hasShockAbsorbers: false,
        hasSteeringLinkage: false,
        seatTypes: ["driver"],
        dialList: [],
        outputPath: "Assets/Vehicles",
        gprojPath: beta.gprojPath,
      });

      expect(result.isError).not.toBe(true);
      expect(existsSync(join(beta.root, "Assets", "Vehicles", "TargetTruck.agr"))).toBe(true);
      expect(existsSync(join(container, "Assets", "Vehicles", "TargetTruck.agr"))).toBe(false);
    }, { prefix: "rfo-animation-target-" });
  });
});
