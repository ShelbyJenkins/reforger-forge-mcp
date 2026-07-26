import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import {
  invalidateAssetCache,
  registerAssetSearch,
} from "../../src/tools/asset-search.js";
import { PakVirtualFS } from "../../src/pak/vfs.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
}

type ToolHandler = (input: {
  query: string;
  type: string;
  limit: number;
  refresh: boolean;
}) => Promise<ToolResult>;

function oneEntryResourceDatabase(path: string, guid: string): Buffer {
  const bodyHeader = Buffer.alloc(16);
  bodyHeader.writeUInt32LE(7, 0);
  bodyHeader.writeUInt32LE(1, 12);

  const platform = Buffer.alloc(15);
  platform.writeUInt32LE(7, 0);
  platform.write("spruce\0", 4, "utf8");

  const encodedPath = Buffer.from(`${path}\0`, "utf8");
  const record = Buffer.alloc(4 + encodedPath.length + 14 + 8);
  record.writeUInt32LE(encodedPath.length, 0);
  encodedPath.copy(record, 4);
  const metadataOffset = 4 + encodedPath.length;
  record[metadataOffset] = 6;
  Buffer.from(guid, "hex").reverse().copy(record, metadataOffset + 6);

  const form = Buffer.alloc(12);
  form.write("FORM", 0, "ascii");
  form.write("RDBC", 8, "ascii");
  const database = Buffer.concat([form, bodyHeader, platform, record]);
  database.writeUInt32BE(database.length - 8, 4);
  database.writeBigUInt64LE(BigInt(database.length), 16);
  return database;
}

function register(config: Config): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    registerTool(
      _name: string,
      _definition: unknown,
      callback: ToolHandler
    ): void {
      handler = callback;
    },
  } as unknown as McpServer;
  registerAssetSearch(server, config);
  return handler!;
}

afterEach(() => {
  invalidateAssetCache();
  PakVirtualFS.invalidate();
});

describe("asset_search resource GUIDs", () => {
  it("returns GameMode_Plain with its GUID from resourceDatabase.rdb", async () => {
    await withTemporaryDirectory(async (root) => {
      const gamePath = join(root, "game");
      const dataPath = join(gamePath, "addons", "data");
      const prefabPath = "Prefabs/MP/Modes/Plain/GameMode_Plain.et";
      mkdirSync(join(dataPath, "Prefabs", "MP", "Modes", "Plain"), {
        recursive: true,
      });
      writeFileSync(join(dataPath, ...prefabPath.split("/")), "SCR_BaseGameMode {}");
      writeFileSync(
        join(dataPath, "resourceDatabase.rdb"),
        oneEntryResourceDatabase(prefabPath, "1B76F75A3175E85C")
      );

      const handler = register({
        workbenchPath: join(root, "tools"),
        gamePath,
        dataDir: join(root, "index"),
        patternsDir: join(root, "patterns"),
        workbenchHost: "127.0.0.1",
        workbenchPort: 5775,
      });
      const result = await handler({
        query: "GameMode_Plain",
        type: "prefab",
        limit: 5,
        refresh: false,
      });
      const text = result.content.map((item) => item.text ?? "").join("\n");

      expect(text).toContain(
        "{1B76F75A3175E85C}Prefabs/MP/Modes/Plain/GameMode_Plain.et"
      );
    }, { prefix: "rfo-asset-guid-" });
  });
});
