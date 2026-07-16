import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HANDLER_MANIFEST_NAME,
  HandlerBundleError,
  HandlerBundleManager,
  type HandlerManifest,
} from "../../src/workbench/handler-bundle.js";
import { canonicalizeGproj } from "../../src/workbench/project-identity.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): {
  root: string;
  stateDir: string;
  bundleDir: string;
  modDir: string;
  projectPath: string;
  handlerDir: string;
  manager: HandlerBundleManager;
} {
  const root = mkdtempSync(join(tmpdir(), "reforger-forge-handler-"));
  roots.push(root);
  const stateDir = join(root, "state");
  const bundleDir = join(root, "bundle");
  const modDir = join(root, "ExampleMod");
  const projectPath = join(modDir, "Example.gproj");
  const handlerDir = join(modDir, "Scripts", "WorkbenchGame", "EnfusionMCP");
  mkdirSync(bundleDir, { recursive: true });
  mkdirSync(modDir, { recursive: true });
  writeFileSync(projectPath, "Project {}", "utf8");
  writeFileSync(join(bundleDir, "EMCP_A.c"), "class A {}\n", "utf8");
  writeFileSync(join(bundleDir, "EMCP_B.c"), "class B {}\n", "utf8");
  return {
    root,
    stateDir,
    bundleDir,
    modDir,
    projectPath,
    handlerDir,
    manager: new HandlerBundleManager({
      stateDir,
      bundleDir,
      requiredFiles: ["EMCP_A.c", "EMCP_B.c"],
    }),
  };
}

function install(fx: ReturnType<typeof fixture>): HandlerManifest {
  const transaction = fx.manager.prepare(canonicalizeGproj(fx.projectPath));
  const applied = fx.manager.apply(transaction);
  const manifest = JSON.parse(
    readFileSync(join(fx.handlerDir, HANDLER_MANIFEST_NAME), "utf8")
  ) as HandlerManifest;
  fx.manager.commit(applied);
  return manifest;
}

describe("transactional Workbench handler bundle", () => {
  it("installs only bundled files and writes a hashed version-3 manifest", () => {
    const fx = fixture();
    const manifest = install(fx);

    expect(manifest.version).toBe(3);
    expect(manifest.canonicalProject).toBe(canonicalizeGproj(fx.projectPath).displayPath);
    expect(manifest.files.map((entry) => entry.path)).toEqual(["EMCP_A.c", "EMCP_B.c"]);
    expect(manifest.files.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
    expect(readdirSync(fx.handlerDir).sort()).toEqual([
      HANDLER_MANIFEST_NAME,
      "EMCP_A.c",
      "EMCP_B.c",
    ]);
  });

  it("refuses an existing handler directory without a valid manifest", () => {
    const fx = fixture();
    mkdirSync(fx.handlerDir, { recursive: true });
    const unowned = join(fx.handlerDir, "EMCP_A.c");
    writeFileSync(unowned, "user content", "utf8");

    expect(() => fx.manager.prepare(canonicalizeGproj(fx.projectPath)))
      .toThrowError(expect.objectContaining<Partial<HandlerBundleError>>({ code: "HANDLER_CONFLICT" }));
    expect(readFileSync(unowned, "utf8")).toBe("user content");
    expect(existsSync(join(fx.handlerDir, HANDLER_MANIFEST_NAME))).toBe(false);
  });

  it("rolls an applied refresh back byte-for-byte and preserves unrelated files", () => {
    const fx = fixture();
    install(fx);
    const manifestPath = join(fx.handlerDir, HANDLER_MANIFEST_NAME);
    const originalManifest = readFileSync(manifestPath);
    const managedPath = join(fx.handlerDir, "EMCP_A.c");
    const extraPath = join(fx.handlerDir, "Notes.txt");
    writeFileSync(managedPath, "locally modified\n", "utf8");
    writeFileSync(extraPath, "keep me\n", "utf8");
    writeFileSync(join(fx.bundleDir, "EMCP_A.c"), "replacement\n", "utf8");

    const transaction = fx.manager.prepare(canonicalizeGproj(fx.projectPath));
    const applied = fx.manager.apply(transaction);
    expect(readFileSync(managedPath, "utf8")).toBe("replacement\n");

    fx.manager.rollback(applied);
    expect(readFileSync(managedPath, "utf8")).toBe("locally modified\n");
    expect(readFileSync(extraPath, "utf8")).toBe("keep me\n");
    expect(readFileSync(manifestPath)).toEqual(originalManifest);
    expect(existsSync(applied.backupPath)).toBe(false);
  });

  it("cleanup removes hash-matching managed files but preserves unrelated files", () => {
    const fx = fixture();
    install(fx);
    writeFileSync(join(fx.handlerDir, "Notes.txt"), "keep me", "utf8");

    const result = fx.manager.cleanup(fx.modDir);

    expect(result.kind).toBe("removed");
    expect(result.removed).toEqual(["EMCP_A.c", "EMCP_B.c"]);
    expect(result.unrelated).toEqual(["Notes.txt"]);
    expect(readFileSync(join(fx.handlerDir, "Notes.txt"), "utf8")).toBe("keep me");
    expect(existsSync(join(fx.handlerDir, HANDLER_MANIFEST_NAME))).toBe(false);
  });

  it("cleanup preserves modified managed files and retains ownership evidence", () => {
    const fx = fixture();
    install(fx);
    writeFileSync(join(fx.handlerDir, "EMCP_A.c"), "user changed this", "utf8");

    const result = fx.manager.cleanup(fx.modDir);

    expect(result.kind).toBe("modified_files");
    expect(result.modified).toEqual(["EMCP_A.c"]);
    expect(result.removed).toEqual(["EMCP_B.c"]);
    expect(readFileSync(join(fx.handlerDir, "EMCP_A.c"), "utf8")).toBe("user changed this");
    expect(existsSync(join(fx.handlerDir, HANDLER_MANIFEST_NAME))).toBe(true);
  });
});
