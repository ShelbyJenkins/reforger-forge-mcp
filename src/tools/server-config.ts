import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "../config.js";
import { generateServerConfig } from "../templates/server-config.js";
import {
  resolveOptionalAddonRoot,
  type ActiveProjectProvider,
} from "../utils/game-paths.js";

export function registerServerConfig(
  server: McpServer,
  _config: Config,
  projectProvider?: ActiveProjectProvider
): void {
  server.registerTool(
    "server_config",
    {
      description:
        "Generate a dedicated server config (server.json) for testing an Arma Reforger mod locally. Configures ports, mod list, scenario, and game properties.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe("Server display name (e.g., 'My Mod Test Server')"),
        modName: z
          .string()
          .optional()
          .describe("Addon ID from .gproj (e.g., 'MyCustomMod')"),
        modId: z
          .string()
          .optional()
          .describe("Addon GUID from .gproj"),
        scenarioId: z
          .string()
          .optional()
          .describe(
            "Scenario resource path (e.g., '{GUID}Missions/MissionHeader.conf')"
          ),
        maxPlayers: z
          .number()
          .min(1)
          .max(128)
          .optional()
          .describe("Maximum players (default 32)"),
        port: z
          .number()
          .int()
          .min(1)
          .max(65_535)
          .optional()
          .describe("Local UDP bind port (default 2001)"),
        bindAddress: z
          .string()
          .optional()
          .describe("Local address to bind. Empty uses all interfaces."),
        publicAddress: z
          .string()
          .optional()
          .describe("Public address advertised to the backend. Empty enables automatic detection."),
        publicPort: z
          .number()
          .int()
          .min(1)
          .max(65_535)
          .optional()
          .describe("Public UDP port advertised to the backend (defaults to port)"),
        a2sPort: z
          .number()
          .int()
          .min(1)
          .max(65_535)
          .optional()
          .describe("A2S query port (default 17777)"),
        visible: z
          .boolean()
          .optional()
          .describe("Show in server browser (default false for local testing)"),
        password: z
          .string()
          .optional()
          .describe("Server password (empty = no password)"),
        gprojPath: z
          .string()
          .optional()
          .describe("Exact .gproj to write server.json beside. Uses the running Workbench project if omitted."),
      },
    },
    async ({
      name,
      modName,
      modId,
      scenarioId,
      maxPlayers,
      port,
      bindAddress,
      publicAddress,
      publicPort,
      a2sPort,
      visible,
      password,
      gprojPath,
    }) => {
      try {
        const basePath = await resolveOptionalAddonRoot(projectProvider, {
          operation: "server_config",
          gprojPath,
        });
        const content = generateServerConfig({
          name,
          modName,
          modId,
          scenarioId,
          maxPlayers,
          port,
          bindAddress,
          publicAddress,
          publicPort,
          a2sPort,
          visible,
          password,
        });

        if (basePath) {
          const targetPath = resolve(basePath, "server.json");

          if (existsSync(targetPath)) {
            return {
              content: [
                {
                  type: "text",
                  text: `File already exists: server.json\n\nGenerated content (not written):\n\n\`\`\`json\n${content}\n\`\`\``,
                },
              ],
            };
          }

          writeFileSync(targetPath, content, "utf-8");

          return {
            content: [
              {
                type: "text",
                text: `Server config created: server.json\n\n\`\`\`json\n${content}\n\`\`\`\n\nLaunch with: ArmaReforgerServer.exe -config server.json`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Generated server config (no project target selected — not written to disk):\n\n\`\`\`json\n${content}\n\`\`\`\n\nPass the exact gprojPath or launch the project with wb_launch to write it.`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [
            { type: "text", text: `Error creating server config: ${msg}` },
          ],
          isError: true,
        };
      }
    }
  );
}
