import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MCP_TESTED_PROTOCOL_VERSION } from "../../src/mcp-stdio-server.js";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function read(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

describe("MCP protocol-era contract", () => {
  it("declares the tested 2025-era boundary without a universal-client claim", () => {
    const packageDocument = JSON.parse(read("package.json")) as { description: string };
    const readme = read("README.md");

    expect(MCP_TESTED_PROTOCOL_VERSION).toBe("2025-11-25");
    expect(packageDocument.description).toContain("2025-era");
    expect(packageDocument.description).not.toMatch(/universal|any AI agent/i);
    expect(readme).toContain("supports the 2025-era MCP initialization protocol");
    expect(readme).toContain("does not currently serve");
    expect(readme).toContain("modern-only client is not compatible");
  });
});
