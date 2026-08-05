import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MCP_CLIENT_LABEL_FLAG,
  buildManagedMcpServerArguments,
  createMcpHostIdentity,
  formatMcpNodeTitleArgument,
  formatMcpProcessTitle,
  parseMcpClientLabel,
  partitionMcpHostArguments,
  validateMcpHostIdentity,
} from "../src/mcp-host-identity.js";

describe("MCP host identity", () => {
  it.each([
    "manual",
    "codex",
    "claude-code",
    "client.v2",
    `a${"b".repeat(47)}`,
  ])("accepts the bounded client label %s", (value) => {
    expect(parseMcpClientLabel(value)).toBe(value);
  });

  it.each([
    "",
    "Codex",
    "-codex",
    "codex/client",
    "codex\\client",
    "codex client",
    "codex\nclient",
    `a${"b".repeat(48)}`,
  ])("rejects the hostile client label %j", (value) => {
    expect(() => parseMcpClientLabel(value)).toThrow(/client label/i);
  });

  it("partitions one server-only host flag and defaults direct launches to manual", () => {
    expect(partitionMcpHostArguments(["--config", "config.json"])).toEqual({
      clientLabel: "manual",
      hostArguments: [MCP_CLIENT_LABEL_FLAG, "manual"],
      remainingArguments: ["--config", "config.json"],
      explicitlySupplied: false,
    });
    expect(partitionMcpHostArguments([
      "--config",
      "config.json",
      MCP_CLIENT_LABEL_FLAG,
      "codex",
    ])).toEqual({
      clientLabel: "codex",
      hostArguments: [MCP_CLIENT_LABEL_FLAG, "codex"],
      remainingArguments: ["--config", "config.json"],
      explicitlySupplied: true,
    });
  });

  it("rejects duplicate, missing, and option-shaped host labels", () => {
    expect(() => partitionMcpHostArguments([
      MCP_CLIENT_LABEL_FLAG,
      "codex",
      MCP_CLIENT_LABEL_FLAG,
      "cursor",
    ])).toThrow(/only once/i);
    expect(() => partitionMcpHostArguments([MCP_CLIENT_LABEL_FLAG])).toThrow(/requires/i);
    expect(() => partitionMcpHostArguments([
      MCP_CLIENT_LABEL_FLAG,
      "--config",
    ])).toThrow(/requires/i);
  });

  it("creates one frozen current-process identity and rejects foreign or extended values", () => {
    const identity = createMcpHostIdentity({
      clientLabel: "codex",
      instanceId: "00112233-4455-4677-8899-aabbccddeeff",
      startedAt: "2026-08-05T12:34:56.789Z",
    });
    expect(identity).toEqual({
      schemaVersion: 1,
      product: "reforger-forge-mcp",
      clientLabel: "codex",
      instanceId: "00112233-4455-4677-8899-aabbccddeeff",
      pid: process.pid,
      startedAt: "2026-08-05T12:34:56.789Z",
    });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(() => validateMcpHostIdentity({ ...identity, pid: process.pid + 1 }))
      .toThrow(/current PID/i);
    expect(() => validateMcpHostIdentity({ ...identity, extra: true }))
      .toThrow(/host identity/i);
    expect(() => validateMcpHostIdentity({
      ...identity,
      startedAt: "2026-08-05T12:34:56Z",
    })).toThrow(/start time/i);
  });

  it("formats stable Node and process titles without claiming to rename the image", () => {
    const identity = createMcpHostIdentity({
      clientLabel: "claude-code",
      instanceId: "00112233-4455-4677-8899-aabbccddeeff",
    });
    expect(formatMcpNodeTitleArgument("claude-code"))
      .toBe("--title=ReforgerForge-MCP-claude-code");
    expect(formatMcpProcessTitle(identity))
      .toBe("ReforgerForge-MCP-claude-code-00112233");

    const longest = createMcpHostIdentity({
      clientLabel: `a${"b".repeat(47)}`,
      instanceId: randomUUID(),
    });
    expect(formatMcpProcessTitle(longest).length).toBeLessThanOrEqual(80);
  });

  it("builds the exact managed Node argument order", () => {
    const serverPath = resolve("dist", "index.js");
    expect(buildManagedMcpServerArguments({
      clientLabel: "vscode",
      serverPath,
      configurationArguments: ["--config", "config.json"],
    })).toEqual([
      "--title=ReforgerForge-MCP-vscode",
      serverPath,
      "--mcp-client-label",
      "vscode",
      "--config",
      "config.json",
    ]);
    expect(() => buildManagedMcpServerArguments({
      clientLabel: "vscode",
      serverPath: "dist/index.js",
    })).toThrow(/absolute/i);
  });
});
