import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("runner safety/source closure", () => {
  it("includes the fixture-only support and decoy without a direct process kill path", () => {
    const source = readFileSync(
      join(process.cwd(), "scripts", "run-workbench-observer-acceptance.ts"),
      "utf8"
    );
    const liveCaseSource = readFileSync(
      join(process.cwd(), "scripts", "workbench-observer-live-matrix-case.ts"),
      "utf8"
    );
    const sharedSource = readFileSync(
      join(process.cwd(), "scripts", "observer-live-acceptance-support.ts"),
      "utf8"
    );
    const ownedSource = `${source}\n${liveCaseSource}\n${sharedSource}`;
    expect(source).toContain('"scripts/observer-workbench-failure-support.ts"');
    expect(source).toContain('"scripts/workbench-observer-acceptance-adapter.ts"');
    expect(source).toContain('"scripts/workbench-observer-acceptance-runtime.ts"');
    expect(source).toContain('"scripts/workbench-observer-live-matrix-case.ts"');
    expect(source).toContain('"scripts/workbench-observer-matrix-case.ts"');
    expect(ownedSource).toContain('"tests/fixtures/workbench-observer-failure-matrix-decoy.mjs"');
    expect(ownedSource.match(/safe\.directory=/g)).toHaveLength(2);
    expect(ownedSource).not.toMatch(/\.kill\s*\(/);
    expect(ownedSource).not.toMatch(/\b(?:taskkill|Stop-Process|KillProcess)\b/);
    expect(ownedSource).not.toContain("vertical slice");
  });
});
