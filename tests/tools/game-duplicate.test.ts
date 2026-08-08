import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import { PakVirtualFS } from "../../src/pak/vfs.js";
import { registerGameDuplicate } from "../../src/tools/game-duplicate.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";
import { buildTestPak } from "../support/pak-fixture.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

function registeredTool(config: Config, client: WorkbenchClient): {
  definition: { description?: string };
  handler: ToolHandler;
} {
  let registered: { definition: { description?: string }; handler: ToolHandler } | undefined;
  const server = {
    registerTool(name: string, definition: { description?: string }, handler: ToolHandler): void {
      if (name === "game_duplicate") registered = { definition, handler };
    },
  } as unknown as McpServer;
  registerGameDuplicate(server, config, client);
  if (!registered) throw new Error("game_duplicate was not registered");
  return registered;
}

function createConfig(extractedPath: string): Config {
  return {
    workbenchPath: "C:\\Arma Reforger Tools",
    gamePath: "C:\\Arma Reforger",
    extractedPath,
    dataDir: "C:\\ReforgerForge\\data",
    patternsDir: "C:\\ReforgerForge\\data\\patterns",
    workbenchHost: "127.0.0.1",
    workbenchPort: 5775,
    mcpIdleShutdownMs: 1_800_000,
  };
}

function createPrefabFixture(root: string): {
  config: Config;
  destination: string;
  gprojPath: string;
} {
  const addons = join(root, "addons");
  const addon = join(addons, "ExampleMod");
  const extracted = join(root, "extracted");
  mkdirSync(addon, { recursive: true });
  mkdirSync(join(extracted, "Prefabs"), { recursive: true });
  writeFileSync(join(addon, "ExampleMod.gproj"), "GameProject {}\n", "utf8");
  writeFileSync(
    join(extracted, "Prefabs", "Base.et"),
    'Entity {\n ID "1111111111111111"\n}\n',
    "utf8"
  );
  return {
    config: createConfig(extracted),
    destination: join(addon, "Prefabs", "Copied.et"),
    gprojPath: join(addon, "ExampleMod.gproj"),
  };
}

describe("game_duplicate contract", () => {
  it("supports only .et prefabs and advertises the no-auto-launch registration rule", async () => {
    await withTemporaryDirectory((root) => {
      const { config, gprojPath } = createPrefabFixture(root);
      const call = vi.fn();
      const { definition, handler } = registeredTool(config, { call } as unknown as WorkbenchClient);

      expect(definition.description).toContain(".et");
      expect(definition.description).not.toContain(".conf");
      expect(definition.description).toContain("PAK");
      expect(definition.description).toContain("never launches Workbench");

      return expect(handler({
        sourcePath: "Configs/Example.conf",
        destPath: "Configs/Example.conf",
        gprojPath,
        flatten: false,
        register: false,
      })).resolves.toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining("only .et") }],
      });
    });
  });

  it("rejects a traversing source before it can read outside extracted data", async () => {
    await withTemporaryDirectory(async (root) => {
      const { config, destination, gprojPath } = createPrefabFixture(root);
      writeFileSync(
        join(root, "outside.et"),
        'Entity {\n ID "2222222222222222"\n}\n',
        "utf8"
      );
      const call = vi.fn();
      const { handler } = registeredTool(config, { call } as unknown as WorkbenchClient);

      const result = await handler({
        sourcePath: "../outside.et",
        destPath: "Prefabs/Copied.et",
        gprojPath,
        flatten: false,
        register: false,
      });

      expect(result).toMatchObject({
        isError: true,
        content: [{ text: expect.stringMatching(/invalid source path.*\.\./i) }],
      });
      expect(existsSync(destination)).toBe(false);
      expect(call).not.toHaveBeenCalled();
    });
  });

  it("duplicates a leaf prefab that exists only in base-game PAK data", async () => {
    await withTemporaryDirectory(async (root) => {
      const addon = join(root, "addons", "ExampleMod");
      const gprojPath = join(addon, "ExampleMod.gproj");
      const destination = join(addon, "Prefabs", "Copied.et");
      const gamePath = join(root, "game");
      const pakDirectory = join(gamePath, "addons", "data");
      mkdirSync(addon, { recursive: true });
      mkdirSync(pakDirectory, { recursive: true });
      writeFileSync(gprojPath, "GameProject {}\n", "utf8");
      writeFileSync(join(pakDirectory, "data.pak"), buildTestPak([{
        path: "Prefabs/PakOnly.et",
        content: 'GenericEntity {\n ID "1111111111111111"\n PAK_MARKER 42\n}\n',
      }]));
      const config: Config = {
        ...createConfig(join(root, "missing-extracted")),
        gamePath,
      };
      const call = vi.fn();
      PakVirtualFS.invalidate();
      try {
        const { handler } = registeredTool(config, { call } as unknown as WorkbenchClient);
        const result = await handler({
          sourcePath: "{657590C1EC9E27D3}Prefabs/PakOnly.et",
          destPath: "Prefabs/Copied.et",
          gprojPath,
          flatten: false,
          register: false,
        });

        expect(result.isError).not.toBe(true);
        expect(result.content[0]?.text).toContain("Prefab copied (not registered)");
        expect(readFileSync(destination, "utf8")).toContain("PAK_MARKER 42");
        expect(readFileSync(destination, "utf8")).not.toContain('ID "1111111111111111"');
        expect(call).not.toHaveBeenCalled();
      } finally {
        PakVirtualFS.invalidate();
      }
    });
  });

  it("uses an already-running Workbench without auto-launching it for registration", async () => {
    await withTemporaryDirectory(async (root) => {
      const { config, destination, gprojPath } = createPrefabFixture(root);
      const call = vi.fn(async () => ({ status: "ok" }));
      const activeProjectGprojPath = vi.fn(async () => gprojPath);
      const { handler } = registeredTool(
        config,
        { call, activeProjectGprojPath } as unknown as WorkbenchClient
      );

      const result = await handler({
        sourcePath: "Prefabs/Base.et",
        destPath: "Prefabs/Copied.et",
        gprojPath,
        flatten: false,
        register: true,
      });

      expect(result.isError).not.toBe(true);
      expect(existsSync(destination)).toBe(true);
      expect(activeProjectGprojPath).toHaveBeenCalledOnce();
      expect(call).toHaveBeenCalledWith(
        "EMCP_WB_Resources",
        { action: "register", path: destination, buildRuntime: false },
        { timeout: 120_000, skipAutoLaunch: true }
      );
    });
  });

  it("reports a non-ok Workbench registration receipt as an error while preserving the copied prefab", async () => {
    await withTemporaryDirectory(async (root) => {
      const { config, destination, gprojPath } = createPrefabFixture(root);
      const call = vi.fn(async () => ({ status: "error", message: "RegisterResourceFile returned false" }));
      const { handler } = registeredTool(config, {
        call,
        activeProjectGprojPath: async () => gprojPath,
      } as unknown as WorkbenchClient);

      const result = await handler({
        sourcePath: "Prefabs/Base.et",
        destPath: "Prefabs/Copied.et",
        gprojPath,
        flatten: false,
        register: true,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("Prefab copied but Workbench registration failed");
      expect(result.content[0]?.text).toContain("did not launch one");
      expect(existsSync(destination)).toBe(true);
    });
  });

  it("refuses registration before writing when Workbench targets another project", async () => {
    await withTemporaryDirectory(async (root) => {
      const { config, destination, gprojPath } = createPrefabFixture(root);
      const otherAddon = join(root, "addons", "OtherMod");
      const otherGprojPath = join(otherAddon, "OtherMod.gproj");
      mkdirSync(otherAddon, { recursive: true });
      writeFileSync(otherGprojPath, "GameProject {}\n", "utf8");
      const call = vi.fn();
      const { handler } = registeredTool(config, {
        call,
        activeProjectGprojPath: async () => otherGprojPath,
      } as unknown as WorkbenchClient);

      const result = await handler({
        sourcePath: "Prefabs/Base.et",
        destPath: "Prefabs/Copied.et",
        gprojPath,
        flatten: false,
        register: true,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("exact project");
      expect(result.content[0]?.text).toContain("No file was written");
      expect(existsSync(destination)).toBe(false);
      expect(call).not.toHaveBeenCalled();
    });
  });

  it("directs a copied-but-unregistered prefab to wb_resources instead of an impossible retry", async () => {
    await withTemporaryDirectory(async (root) => {
      const { config, destination, gprojPath } = createPrefabFixture(root);
      const call = vi.fn();
      const { handler } = registeredTool(config, { call } as unknown as WorkbenchClient);

      const result = await handler({
        sourcePath: "Prefabs/Base.et",
        destPath: "Prefabs/Copied.et",
        gprojPath,
        flatten: false,
        register: false,
      });

      expect(result.isError).not.toBe(true);
      expect(result.content[0]?.text).toContain("wb_resources");
      expect(result.content[0]?.text).toContain(destination);
      expect(result.content[0]?.text).toContain("exact destination project");
      expect(result.content[0]?.text).toContain("belongs to the active project");
      expect(result.content[0]?.text).not.toContain("call again with register=true");
      expect(existsSync(destination)).toBe(true);
      expect(call).not.toHaveBeenCalled();
    });
  });
});
