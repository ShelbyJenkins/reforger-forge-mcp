import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const addonRoot = join(repositoryRoot, "observer", "addon");
const manifestName = ".reforger-forge-observer-source.json";
const manifestPath = join(addonRoot, manifestName);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function visit(directory, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Observer addon payload must not contain symbolic links: ${absolutePath}`);
    }
    if (entry.isDirectory()) {
      visit(absolutePath, files);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Observer addon payload contains an unsupported filesystem entry: ${absolutePath}`);
    }
    const relativePath = relative(addonRoot, absolutePath).split(sep).join("/");
    if (relativePath !== manifestName) files.push(relativePath);
  }
}

const previous = JSON.parse(readFileSync(manifestPath, "utf8"));
const paths = [];
visit(addonRoot, paths);
paths.sort((left, right) => left.localeCompare(right));

const files = paths.map((path) => ({
  path,
  sha256: sha256(readFileSync(join(addonRoot, ...path.split("/")))),
}));

const aggregate = createHash("sha256");
for (const file of files) {
  aggregate.update(file.path, "utf8");
  aggregate.update("\0", "utf8");
  aggregate.update(file.sha256, "ascii");
  aggregate.update("\n", "utf8");
}

const manifest = {
  manifestVersion: previous.manifestVersion,
  addonVersion: previous.addonVersion,
  protocolVersion: previous.protocolVersion,
  addonId: previous.addonId,
  addonGuid: previous.addonGuid,
  buildIdentity: previous.buildIdentity,
  bundleDigest: aggregate.digest("hex"),
  files,
};

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

process.stdout.write(`Updated ${relative(repositoryRoot, manifestPath)} (${files.length} files, ${manifest.bundleDigest})\n`);
