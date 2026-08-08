import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("default test command contract", () => {
  it("runs the claimed complete acceptance suite without file parallelism", () => {
    const packageDocument = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8")
    ) as { readonly scripts?: Record<string, string> };

    expect(packageDocument.scripts?.test).toBe("vitest run --no-file-parallelism");
  });
});
