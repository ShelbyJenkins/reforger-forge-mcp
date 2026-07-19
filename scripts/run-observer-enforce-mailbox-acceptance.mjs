import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const defaultConfigPath = join(repositoryRoot, "reforger-forge.config.json");
const defaultArtifactPath = join(
  repositoryRoot,
  ".artifacts",
  "observer-enforce-mailbox-acceptance.json"
);
const productionAddonRoot = join(repositoryRoot, "observer", "addon");
const productionProjectPath = join(productionAddonRoot, "addon.gproj");
const productionManifestPath = join(productionAddonRoot, ".reforger-forge-observer-source.json");
const productionMailboxPath = join(
  productionAddonRoot,
  "Scripts",
  "Game",
  "ReforgerForgeObserver",
  "RFO_ObserverMailboxTransport.c"
);
const acceptanceAddonRoot = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "enforce-mailbox-acceptance-addon"
);
const acceptanceProjectPath = join(acceptanceAddonRoot, "addon.gproj");
const workbenchExecutableName = "ArmaReforgerWorkbenchSteamDiag.exe";
const requiredCases = Object.freeze([
  "fairness",
  "deletion_failure",
  "egress_reclamation",
  "writer_pause",
  "bounded_quarantine",
]);
const maxSentinelBytes = 1024 * 1024;
const maxDiagnosticScanBytes = 8 * 1024 * 1024;

function parseArguments(argv) {
  const options = {
    artifactPath: defaultArtifactPath,
    configPath: defaultConfigPath,
    workbenchPath: null,
    addonDirectories: [],
    timeoutMs: 240_000,
    keepProfile: false,
    help: false,
  };
  const valued = new Set(["--artifact", "--config", "--workbench", "--addons-dir", "--timeout-ms"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (valued.has(argument)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (argument === "--artifact") options.artifactPath = resolve(value);
      else if (argument === "--config") options.configPath = resolve(value);
      else if (argument === "--workbench") options.workbenchPath = resolve(value);
      else if (argument === "--addons-dir") options.addonDirectories.push(resolve(value));
      else options.timeoutMs = Number(value);
    } else if (argument === "--keep-profile") {
      options.keepProfile = true;
    } else if (argument === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 30_000 || options.timeoutMs > 900_000) {
    throw new Error("--timeout-ms must be an integer from 30000 through 900000");
  }
  return options;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha256(path) {
  return sha256(readFileSync(path));
}

function requiredFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} is missing: ${path}`);
  return path;
}

function requiredDirectory(path, label) {
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`${label} is missing: ${path}`);
  return path;
}

function readConfiguration(path) {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Workbench config must contain a JSON object");
  }
  return parsed;
}

function resolveWorkbenchExecutable(workbenchPath) {
  const candidates = [
    workbenchPath,
    join(workbenchPath, workbenchExecutableName),
    join(workbenchPath, "Workbench", workbenchExecutableName),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile() &&
        basename(candidate).toLowerCase() === workbenchExecutableName.toLowerCase()) {
      return candidate;
    }
  }
  throw new Error(`Could not find ${workbenchExecutableName} beneath the configured Workbench path`);
}

function listWorkbenchPids() {
  const result = spawnSync(
    "tasklist.exe",
    ["/FI", `IMAGENAME eq ${workbenchExecutableName}`, "/FO", "CSV", "/NH"],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 }
  );
  if (result.error || result.status !== 0) throw new Error("Could not prove Workbench process vacancy");
  const pids = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^"[^"]+","(\d+)"/.exec(line.trim());
    if (match) pids.push(Number(match[1]));
  }
  return pids;
}

function executableVersion(path) {
  const escaped = path.replaceAll("'", "''");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Item -LiteralPath '${escaped}').VersionInfo.FileVersion`,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 }
  );
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function boundedTail(value, maximum = 16_384) {
  return value.length <= maximum ? value : value.slice(-maximum);
}

function sanitizeText(value, replacements) {
  let result = typeof value === "string" ? value : String(value ?? "");
  for (const [path, label] of replacements) {
    result = result.replaceAll(path, label);
    result = result.replaceAll(path.replaceAll("\\", "/"), label);
  }
  return result
    .replace(/\b7656119\d{10}\b/g, "<steam-id>")
    .replace(/(sessionToken|launchNonce|ownerToken)["'=:\s]+[A-Za-z0-9._~-]+/gi, "$1=<redacted>");
}

function sanitizeValue(value, replacements, depth = 0) {
  if (depth > 8) return "<depth-limit>";
  if (typeof value === "string") return boundedTail(sanitizeText(value, replacements), 4_096);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 256).map((item) => sanitizeValue(item, replacements, depth + 1));
  if (!value || typeof value !== "object") return null;
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 256)) {
    if (/token|nonce|secret|credential/i.test(key)) result[key] = "<redacted>";
    else result[key] = sanitizeValue(item, replacements, depth + 1);
  }
  return result;
}

function readBoundedJson(path, label, maximum = maxSentinelBytes) {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size < 2 || info.size > maximum) {
    throw new Error(`${label} is not a bounded regular file`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parsed;
}

function atomicWriteJson(root, path, value) {
  if (!containsPath(root, path)) throw new Error("Acceptance control write escaped its isolated root");
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function containsPath(root, path) {
  const normalize = (value) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  const rel = relative(normalize(root), normalize(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function samePath(left, right) {
  const normalize = (value) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

function enforceBool(value) {
  // Enforce JsonApiStruct serializes bool fields as 0/1 in current Workbench
  // builds. Accept exactly those values in addition to JSON booleans; do not
  // treat arbitrary truthy values as evidence.
  return value === true || value === 1;
}

function directoryDigest(root) {
  const members = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        // Workbench creates this derived binary cache whenever it opens an
        // addon. It is intentionally outside source and evidence identity.
        if (entry.name === "resourceDatabase.rdb") continue;
        members.push({
          path: relative(root, path).replaceAll("\\", "/"),
          bytes: statSync(path).size,
          sha256: fileSha256(path),
        });
      }
      else throw new Error(`Addon source contains a non-regular member: ${path}`);
      if (members.length + pending.length > 20_000) throw new Error("Addon source exceeds the acceptance staging bound");
    }
  }
  members.sort((left, right) => left.path.localeCompare(right.path));
  return {
    files: members.length,
    bytes: members.reduce((total, member) => total + member.bytes, 0),
    digest: sha256(JSON.stringify(members)),
  };
}

function aggregateManifestDigest(files) {
  const aggregate = createHash("sha256");
  for (const file of files) {
    aggregate.update(file.path, "utf8");
    aggregate.update("\0", "utf8");
    aggregate.update(file.sha256, "ascii");
    aggregate.update("\n", "utf8");
  }
  return aggregate.digest("hex");
}

function verifyProductionManifest() {
  const manifest = readBoundedJson(productionManifestPath, "Production observer source manifest");
  if (manifest.manifestVersion !== 1 || !Array.isArray(manifest.files) ||
      !/^[a-f0-9]{64}$/.test(manifest.bundleDigest ?? "") ||
      !/^[a-f0-9]{64}$/.test(manifest.buildIdentity ?? "") ||
      !/^[A-F0-9]{16}$/.test(manifest.addonGuid ?? "")) {
    throw new Error("Production observer source manifest has an invalid contract");
  }
  const declared = [];
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "") ||
        entry.path.includes("\\") || entry.path.startsWith("/") ||
        entry.path.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
        seen.has(entry.path)) {
      throw new Error("Production observer source manifest contains an invalid or duplicate member");
    }
    seen.add(entry.path);
    declared.push({ path: entry.path, sha256: entry.sha256 });
  }
  const actual = [];
  const pending = [productionAddonRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error("Production observer addon contains a symbolic link");
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        const member = relative(productionAddonRoot, path).replaceAll("\\", "/");
        if (member !== basename(productionManifestPath) && entry.name !== "resourceDatabase.rdb") {
          actual.push({ path: member, sha256: fileSha256(path) });
        }
      } else throw new Error("Production observer addon contains a non-regular member");
    }
  }
  declared.sort((left, right) => left.path.localeCompare(right.path));
  actual.sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(actual) !== JSON.stringify(declared)) {
    throw new Error("Production observer source manifest is stale");
  }
  const computedBundleDigest = aggregateManifestDigest(declared);
  if (computedBundleDigest !== manifest.bundleDigest) {
    throw new Error("Production observer source manifest bundle digest is stale");
  }
  const buildSource = readFileSync(join(
    productionAddonRoot,
    "Scripts", "Game", "ReforgerForgeObserver", "RFO_ObserverBuild.c"
  ), "utf8");
  const embeddedBuildIdentity = /static const string IDENTITY = "([a-f0-9]{64})";/.exec(buildSource)?.[1];
  const projectSource = readFileSync(productionProjectPath, "utf8");
  const projectGuid = /GUID\s+"([A-F0-9]{16})"/.exec(projectSource)?.[1];
  if (embeddedBuildIdentity !== manifest.buildIdentity || projectGuid !== manifest.addonGuid) {
    throw new Error("Production observer manifest identity does not match the addon source");
  }
  return {
    verified: true,
    manifestVersion: manifest.manifestVersion,
    addonGuid: manifest.addonGuid,
    buildIdentity: manifest.buildIdentity,
    declaredBundleDigest: manifest.bundleDigest,
    computedBundleDigest,
    files: declared.length,
  };
}

function verifyCompiledHostModules() {
  const modules = ["sessions", "registry", "jobs", "artifacts", "mailbox-coordinator"];
  const evidence = modules.map((name) => {
    const sourcePath = join(repositoryRoot, "observer", "agent", `${name}.ts`);
    const distPath = requiredFile(join(repositoryRoot, "dist", "observer", "agent", `${name}.js`), `Built observer host module ${name}`);
    const mapPath = `${distPath}.map`;
    const sourcePresent = existsSync(sourcePath) && statSync(sourcePath).isFile();
    const mapPresent = existsSync(mapPath) && statSync(mapPath).isFile();
    let sourceMapped = null;
    let fresh = null;
    if (sourcePresent) {
      if (!mapPresent) throw new Error(`Built observer host module ${name} has no source map`);
      const sourceMap = JSON.parse(readFileSync(mapPath, "utf8"));
      sourceMapped = Array.isArray(sourceMap.sources) && sourceMap.sources.some((mapped) =>
        typeof mapped === "string" && samePath(resolve(dirname(mapPath), mapped), sourcePath)
      );
      fresh = statSync(distPath).mtimeMs >= statSync(sourcePath).mtimeMs &&
        statSync(mapPath).mtimeMs >= statSync(sourcePath).mtimeMs;
      if (!sourceMapped || !fresh) throw new Error(`Built observer host module ${name} is stale or not source-bound`);
    }
    return {
      module: name,
      verificationMode: sourcePresent ? "repository-source-bound" : "packaged-dist",
      sourceSha256: sourcePresent ? fileSha256(sourcePath) : null,
      distSha256: fileSha256(distPath),
      sourceMapSha256: mapPresent ? fileSha256(mapPath) : null,
      sourceMapped,
      fresh,
    };
  });
  return {
    verified: true,
    digest: sha256(JSON.stringify(evidence)),
    modules: evidence,
  };
}

function collectDiagnostics(root, replacements) {
  const result = [];
  const pending = [root];
  let inspected = 0;
  while (pending.length > 0 && inspected < 1_024 && result.length < 48) {
    const directory = pending.shift();
    let entries = [];
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++inspected > 1_024) break;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && /\.(?:log|txt)$/i.test(entry.name)) {
        try {
          const info = lstatSync(path);
          if (info.isSymbolicLink() || !info.isFile() || info.size > maxDiagnosticScanBytes) {
            result.push({
              path: relative(root, path).replaceAll("\\", "/"),
              bytes: info.size,
              sha256: null,
              tail: "",
              scanText: "",
              scanComplete: false,
            });
            continue;
          }
          const bytes = readFileSync(path);
          const text = sanitizeText(bytes.toString("utf8"), replacements);
          result.push({
            path: relative(root, path).replaceAll("\\", "/"),
            bytes: bytes.length,
            sha256: sha256(bytes),
            tail: boundedTail(text, 4_096),
            scanText: text,
            scanComplete: true,
          });
        } catch {
          // Supplementary diagnostics do not replace process/sentinel authority.
        }
      }
    }
  }
  return result;
}

function analyzeEnforceDiagnostics(stdout, stderr, diagnostics) {
  const text = [stdout.tail, stderr.tail, ...diagnostics.map((item) => item.scanText)].join("\n");
  const scriptErrorLines = text.split(/\r?\n/)
    .filter((line) => /SCRIPT\s+\((?:E|F)\)|Can't compile .* script module/i.test(line))
    .slice(0, 64)
    .map((line) => boundedTail(line, 1_024));
  const gameModuleLoaded = /SCRIPT\s+: Module: Game; loaded \d+x files;/i.test(text);
  const workbenchGameModuleLoaded = /SCRIPT\s+: Module: WorkbenchGame; loaded \d+x files;/i.test(text);
  const scanComplete = diagnostics.length > 0 && diagnostics.every((item) => item.scanComplete === true);
  return {
    proven: scanComplete && gameModuleLoaded && workbenchGameModuleLoaded && scriptErrorLines.length === 0,
    scanComplete,
    gameModuleLoaded,
    workbenchGameModuleLoaded,
    scriptErrorLines,
  };
}

function streamCapture(stream) {
  const hash = createHash("sha256");
  let bytes = 0;
  let tail = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk) => {
    const text = String(chunk);
    bytes += Buffer.byteLength(text);
    hash.update(text);
    tail = boundedTail(`${tail}${text}`, 32_768);
  });
  return { finish: () => ({ bytes, sha256: hash.digest("hex"), tail }) };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processExit(child) {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ exitCode: null, signal: null, error }));
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal, error: null }));
  });
}

function lockHelperScript() {
  return `
$ErrorActionPreference = 'Stop'
$target = $env:RFO_LOCK_TARGET
$held = $env:RFO_LOCK_HELD
$unlock = $env:RFO_LOCK_UNLOCK
$requestId = $env:RFO_LOCK_REQUEST_ID
$stream = [IO.File]::Open($target, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  $payload = [ordered]@{ schemaVersion = 1; requestId = $requestId; shareMode = 'FileShare.None'; heldAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
  $temporary = "$held.tmp-$PID"
  [IO.File]::WriteAllText($temporary, $payload + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $held -Force
  while (-not [IO.File]::Exists($unlock)) { Start-Sleep -Milliseconds 20 }
}
finally {
  $stream.Dispose()
}
`;
}

function startFileShareNoneLock(paths, request) {
  const targetInput = String(request.targetProfilePath ?? "");
  const target = isAbsolute(targetInput) ? resolve(targetInput) : resolve(paths.profileDataRoot, targetInput);
  if (!containsPath(paths.profileDataRoot, target)) {
    throw new Error("Host lock request target escaped the isolated profile");
  }
  const info = lstatSync(target);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Host lock target is not a regular file");
  for (const stale of [paths.lockHeldPath, paths.lockObservedPath, paths.lockReleasePath, paths.unlockPath]) {
    if (existsSync(stale)) unlinkSync(stale);
  }
  const encoded = Buffer.from(lockHelperScript(), "utf16le").toString("base64");
  const child = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        RFO_LOCK_TARGET: target,
        RFO_LOCK_HELD: paths.lockHeldPath,
        RFO_LOCK_UNLOCK: paths.unlockPath,
        RFO_LOCK_REQUEST_ID: request.requestId,
      },
    }
  );
  const stderr = streamCapture(child.stderr);
  return {
    child,
    exit: processExit(child),
    stderr,
    requestId: request.requestId,
    caseId: request.caseId,
    target,
    acquired: false,
    acquiredAt: null,
  };
}

function deriveLockRequestId(runId, request) {
  const caseId = String(request.caseId ?? "invalid");
  const target = String(request.targetProfilePath ?? "").replaceAll("\\", "/").toLowerCase();
  return `${caseId}-${sha256(`${runId}\0${caseId}\0${target}`).slice(0, 24)}`;
}

function normalizeCaseResults(result) {
  const normalized = new Map();
  const duplicates = [];
  const entries = Array.isArray(result?.cases)
    ? result.cases.map((item) => [item?.caseId ?? item?.id, item])
    : result?.cases && typeof result.cases === "object"
      ? Object.entries(result.cases)
      : [];
  for (const [caseId, value] of entries) {
    if (typeof caseId !== "string") continue;
    if (normalized.has(caseId)) duplicates.push(caseId);
    const passed = enforceBool(value) || enforceBool(value?.passed) || value?.result === "passed";
    normalized.set(caseId, { passed, value });
  }
  return { normalized, duplicates, entryCount: entries.length };
}

function validateCaseMetrics(cases) {
  const integer = (value, expected) => Number.isSafeInteger(value) && value === expected;
  const boundedPositive = (value, maximum) => Number.isSafeInteger(value) && value > 0 && value <= maximum;
  const evaluate = (caseId, checks) => {
    const record = cases.get(caseId);
    const failures = Object.entries(checks(record?.value ?? {}))
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    if (!record) failures.unshift("case_present");
    if (record && !record.passed) failures.unshift("reported_passed");
    return { passed: failures.length === 0, failures };
  };

  return {
    fairness: evaluate("fairness", (value) => ({
      commands_created_258: integer(value.commandsCreated, 258),
      accepted_after_first_poll_0: integer(value.acceptedAfterFirstPoll, 0),
      accepted_after_later_poll_1: integer(value.acceptedAfterLaterPoll, 1),
      commands_accepted_exactly_1: integer(value.commandsAccepted, 1),
      locked_ingress_retained: enforceBool(value.ingressRetainedWhileLocked),
      egress_usable_while_locked: enforceBool(value.egressUsableWhileIngressLocked),
      recovered_after_unlock: enforceBool(value.recoveredAfterUnlock),
      quarantine_exactly_128: integer(value.quarantineFiles, 128),
      quarantine_bytes_bounded: boundedPositive(value.quarantineBytes, 4 * 1024 * 1024),
      evidence_valid: enforceBool(value.evidenceValid),
    })),
    deletion_failure: evaluate("deletion_failure", (value) => ({
      locked_ingress_retained: enforceBool(value.ingressRetainedWhileLocked),
      egress_usable_while_locked: enforceBool(value.egressUsableWhileIngressLocked),
      recovered_after_unlock: enforceBool(value.recoveredAfterUnlock),
      one_evidence_record: integer(value.quarantineFiles, 1),
      evidence_bytes_positive: boundedPositive(value.quarantineBytes, 4 * 1024 * 1024),
      evidence_valid: enforceBool(value.evidenceValid),
    })),
    egress_reclamation: evaluate("egress_reclamation", (value) => ({
      one_status_data: integer(value.statusDataFiles, 1),
      one_status_marker: integer(value.statusMarkerFiles, 1),
      no_status_temporaries: integer(value.statusTemporaryFiles, 0),
      payload_intact: enforceBool(value.payloadIntact),
      exactly_once_publication: enforceBool(value.exactlyOnce),
      exact_cap_blocked: enforceBool(value.egressCapBlocked),
      exact_cap_recovered: enforceBool(value.egressCapRecovered),
    })),
    writer_pause: evaluate("writer_pause", (value) => ({
      data_copied_before_marker: enforceBool(value.dataCopiedBeforeMarker),
      host_cleaner_observed: enforceBool(value.hostCleanerObserved),
      host_cleaner_preserved: enforceBool(value.hostCleanerPreserved),
      marker_after_release: enforceBool(value.markerPublishedAfterRelease),
      payload_intact: enforceBool(value.payloadIntact),
      one_status_data: integer(value.statusDataFiles, 1),
      one_status_marker: integer(value.statusMarkerFiles, 1),
      exactly_once_publication: enforceBool(value.exactlyOnce),
    })),
    bounded_quarantine: evaluate("bounded_quarantine", (value) => ({
      commands_created_160: integer(value.commandsCreated, 160),
      quarantine_exactly_128: integer(value.quarantineFiles, 128),
      quarantine_bytes_bounded: boundedPositive(value.quarantineBytes, 4 * 1024 * 1024),
      record_bound_exercised: enforceBool(value.recordBoundExercised),
      byte_bound_exercised: enforceBool(value.byteBoundExercised),
      evidence_valid: enforceBool(value.evidenceValid),
    })),
  };
}

/**
 * Integration seam for the production host cleaner. A plugin-authored claim
 * is deliberately insufficient: this function must call the real host
 * MailboxCoordinator while the writer-pause sentinel is present, then return
 * performed=true only after it verifies the data survived without a marker.
 */
async function createWriterHostContext(paths, stagedProductionRoot, timeoutMs) {
  const compiledAgentRoot = join(repositoryRoot, "dist", "observer", "agent");
  for (const name of ["sessions", "registry", "jobs", "artifacts", "mailbox-coordinator"]) {
    requiredFile(join(compiledAgentRoot, `${name}.js`), `Built observer host module ${name}`);
  }
  const [sessionsModule, registryModule, jobsModule, artifactsModule, coordinatorModule] = await Promise.all(
    ["sessions", "registry", "jobs", "artifacts", "mailbox-coordinator"].map((name) =>
      import(pathToFileURL(join(compiledAgentRoot, `${name}.js`)).href)
    )
  );
  const manifest = JSON.parse(readFileSync(productionManifestPath, "utf8"));
  if (!/^[a-f0-9]{64}$/.test(manifest.bundleDigest) || !/^[a-f0-9]{64}$/.test(manifest.buildIdentity)) {
    throw new Error("Production observer manifest does not contain bounded host acceptance identities");
  }
  const sessions = new sessionsModule.SessionStore();
  const created = sessions.create({
    bundleDigest: manifest.bundleDigest,
    stagedAddonPath: stagedProductionRoot,
    profilePath: paths.profileRoot,
    agent: { host: "127.0.0.1", port: 47831, instanceId: "agent-v10-acceptance" },
    buildIdentity: manifest.buildIdentity,
    expectedRuntimeKind: "testRunner",
    ttlMs: Math.min(24 * 60 * 60_000, timeoutMs + 120_000),
    transportPreference: ["mailbox"],
    sessionId: "v10-acceptance-session",
  });
  const registry = new registryModule.InstanceRegistry(sessions);
  const jobs = new jobsModule.JobStore(sessions, registry);
  const artifacts = new artifactsModule.ArtifactStore(join(paths.profileRoot, "HostArtifacts"), sessions, jobs);
  const coordinator = new coordinatorModule.MailboxCoordinator(sessions, registry, jobs, artifacts, {
    orphanIngressMaxAgeMs: 0,
  });
  await coordinator.pollOnce();
  const statusDirectory = requiredDirectory(
    join(paths.profileDataRoot, "ReforgerForgeObserver", "mailbox", "status"),
    "Production observer status directory"
  );
  return { coordinator, registry, sessionId: created.contract.sessionId, statusDirectory };
}

async function performWriterPauseHostAction(paths, request, context) {
  if (request.schemaVersion !== 1 || request.caseId !== "writer_pause") {
    throw new Error("Writer-pause request has an invalid contract");
  }
  const dataInput = String(request.dataProfilePath ?? "");
  const markerInput = String(request.markerProfilePath ?? "");
  if (!dataInput || !markerInput || isAbsolute(dataInput) || isAbsolute(markerInput)) {
    throw new Error("Writer-pause paths must be profile-relative");
  }
  const dataPath = resolve(paths.profileDataRoot, dataInput);
  const markerPath = resolve(paths.profileDataRoot, markerInput);
  if (!containsPath(context.statusDirectory, dataPath) ||
      !samePath(dirname(dataPath), context.statusDirectory) ||
      !samePath(dirname(markerPath), context.statusDirectory) ||
      !samePath(markerPath, `${dataPath}.complete`) ||
      !/^\d{12}-registration-[A-Za-z0-9_.-]+\.json$/.test(basename(dataPath))) {
    throw new Error("Writer-pause paths are not the exact production registration data/marker pair");
  }
  const beforeInfo = lstatSync(dataPath);
  if (beforeInfo.isSymbolicLink() || !beforeInfo.isFile() || beforeInfo.size < 2 || beforeInfo.size > maxSentinelBytes) {
    throw new Error("Paused writer data is not a bounded regular file");
  }
  if (existsSync(markerPath)) throw new Error("Writer-pause marker already exists before host cleanup");
  const beforeSha256 = fileSha256(dataPath);
  await context.coordinator.pollOnce();
  const sweep = context.coordinator.sweep(Date.now());
  const afterInfo = lstatSync(dataPath);
  const preserved = afterInfo.isFile() && !afterInfo.isSymbolicLink() &&
    afterInfo.size === beforeInfo.size && fileSha256(dataPath) === beforeSha256 && !existsSync(markerPath);
  return {
    performed: true,
    hostCleanerObserved: true,
    preserved,
    message: preserved ? "production_host_cleaner_preserved_active_writer" : "production_host_cleaner_changed_active_writer",
    sessionId: context.sessionId,
    dataBytes: beforeInfo.size,
    dataSha256: beforeSha256,
    removedOrphanIngressFiles: sweep.removedOrphanIngressFiles,
    retainedCleanupFailures: sweep.retainedCleanupFailures,
    coordinatorOrphanIngressRemoved: context.coordinator.stats().orphanIngressRemoved,
    dataPath,
    markerPath,
  };
}

async function proveWriterDeliveryExactlyOnce(context, writerAction) {
  if (!writerAction?.performed || !writerAction?.preserved) {
    return { proven: false, reason: "writer_pause_not_preserved" };
  }
  const { dataPath, markerPath } = writerAction;
  if (!samePath(dirname(dataPath), context.statusDirectory) ||
      !samePath(markerPath, `${dataPath}.complete`) ||
      !existsSync(dataPath) || !existsSync(markerPath)) {
    return { proven: false, reason: "published_pair_missing_or_outside_status_directory" };
  }
  const dataInfo = lstatSync(dataPath);
  const markerInfo = lstatSync(markerPath);
  const beforePayloadMatches = dataInfo.isFile() && !dataInfo.isSymbolicLink() &&
    dataInfo.size === writerAction.dataBytes && fileSha256(dataPath) === writerAction.dataSha256;
  const markerValid = markerInfo.isFile() && !markerInfo.isSymbolicLink() && markerInfo.size <= 64;
  const beforeRecords = context.registry.forSession(context.sessionId);
  const beforeAccepted = context.coordinator.stats().accepted;
  await context.coordinator.pollOnce();
  const firstRecords = context.registry.forSession(context.sessionId);
  const afterFirstAccepted = context.coordinator.stats().accepted;
  const firstConsumed = !existsSync(dataPath) && !existsSync(markerPath);
  await context.coordinator.pollOnce();
  const secondRecords = context.registry.forSession(context.sessionId);
  const afterSecondAccepted = context.coordinator.stats().accepted;
  const expectedInstance = firstRecords.filter((record) =>
    record.registration.sessionId === context.sessionId &&
    record.registration.instanceId === "acceptance-instance"
  );
  const proven = beforePayloadMatches && markerValid && beforeRecords.length === 0 &&
    firstRecords.length === 1 && expectedInstance.length === 1 && firstConsumed &&
    afterFirstAccepted - beforeAccepted === 1 && secondRecords.length === 1 &&
    secondRecords[0].registration.instanceId === firstRecords[0].registration.instanceId &&
    afterSecondAccepted === afterFirstAccepted && !existsSync(dataPath) && !existsSync(markerPath);
  return {
    proven,
    beforePayloadMatches,
    markerValid,
    recordsBefore: beforeRecords.length,
    recordsAfterFirstPoll: firstRecords.length,
    recordsAfterSecondPoll: secondRecords.length,
    acceptedBefore: beforeAccepted,
    acceptedAfterFirstPoll: afterFirstAccepted,
    acceptedAfterSecondPoll: afterSecondAccepted,
    firstPollAcceptedDelta: afterFirstAccepted - beforeAccepted,
    secondPollAcceptedDelta: afterSecondAccepted - afterFirstAccepted,
    noRedeliveryOnSecondPoll: afterSecondAccepted === afterFirstAccepted,
    pairRemovedAfterFirstPoll: firstConsumed,
    expectedInstanceRegistered: expectedInstance.length === 1,
  };
}

function portableArguments(addonDirectoryCount) {
  return [
    "-gproj", "<staged-acceptance-addon>/addon.gproj",
    "-addonsDir", `<staged addons plus ${addonDirectoryCount} configured addon director${addonDirectoryCount === 1 ? "y" : "ies"}>`,
    "-profile", "<temporary isolated profile>",
    "-noThrow",
    "-VMErrorMode=fatal",
    "-wbModule=ScriptEditor",
    "-plugin=RFO_MailboxAcceptancePlugin",
    "-run",
    "-rfoCase=all",
    "-rfoRunId=<run-id>",
    "-rfoResult=$profile:RFOAcceptance/result.json",
  ];
}

async function terminateWorkbench(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGTERM"); } catch { /* postcondition vacancy remains authoritative */ }
  await Promise.race([processExit(child), delay(1_000)]);
  if (child.exitCode === null && child.signalCode === null && Number.isSafeInteger(child.pid)) {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 5_000,
    });
  }
}

async function runAcceptance(options) {
  if (process.platform !== "win32") throw new Error("Mailbox acceptance requires Windows Workbench");
  requiredFile(productionProjectPath, "Production observer addon project");
  requiredFile(productionManifestPath, "Production observer source manifest");
  requiredFile(productionMailboxPath, "Production observer mailbox source");
  requiredDirectory(acceptanceAddonRoot, "Enforce mailbox acceptance addon");
  requiredFile(acceptanceProjectPath, "Enforce mailbox acceptance project");

  const config = readConfiguration(options.configPath);
  const configuredWorkbenchPath = options.workbenchPath ??
    (typeof config.workbenchPath === "string" && config.workbenchPath.length > 0
      ? resolve(config.workbenchPath)
      : null);
  if (!configuredWorkbenchPath) throw new Error("Configure workbenchPath or pass --workbench");
  const executable = resolveWorkbenchExecutable(configuredWorkbenchPath);
  const configuredAddonDirectories = options.addonDirectories.length > 0
    ? options.addonDirectories
    : Array.isArray(config.workbenchAddonDirs)
      ? config.workbenchAddonDirs
        .filter((value) => typeof value === "string" && value.length > 0)
        .map((value) => resolve(value))
      : [];
  for (const directory of configuredAddonDirectories) requiredDirectory(directory, "Configured Workbench addon directory");

  const preflightPids = listWorkbenchPids();
  if (preflightPids.length > 0) {
    throw new Error(`Acceptance refuses to run while ${preflightPids.length} Workbench process(es) are active`);
  }

  // One absolute budget covers isolated staging, Workbench startup/plugin
  // execution, sentinel handshakes, and timeout-triggered process shutdown.
  const startedAt = new Date();
  const runId = `v10-${randomUUID()}`;
  const deadline = startedAt.getTime() + options.timeoutMs;
  const manifestEvidence = verifyProductionManifest();
  const compiledHostEvidence = verifyCompiledHostModules();
  const sourceSnapshot = {
    productionAddon: {
      projectSha256: fileSha256(productionProjectPath),
      manifestSha256: fileSha256(productionManifestPath),
      mailboxSha256: fileSha256(productionMailboxPath),
      ...directoryDigest(productionAddonRoot),
    },
    acceptanceAddon: {
      projectSha256: fileSha256(acceptanceProjectPath),
      ...directoryDigest(acceptanceAddonRoot),
    },
  };
  const profileRoot = mkdtempSync(join(tmpdir(), "reforger-forge-mailbox-acceptance-"));
  try {
  const stagedAddonsRoot = join(profileRoot, "StagedAddons");
  const stagedProductionRoot = join(stagedAddonsRoot, "ReforgerForgeObserver");
  const stagedAcceptanceRoot = join(stagedAddonsRoot, "RFO_MailboxAcceptance");
  // Enfusion maps `$profile:` beneath the launch profile's physical `profile`
  // directory, not directly beneath the directory supplied to `-profile`.
  const profileDataRoot = join(profileRoot, "profile");
  const acceptanceRoot = join(profileDataRoot, "RFOAcceptance");
  const controlRoot = join(acceptanceRoot, "control");
  const resultPath = join(acceptanceRoot, "result.json");
  const paths = {
    profileRoot,
    profileDataRoot,
    acceptanceRoot,
    controlRoot,
    resultPath,
    lockRequestPath: join(controlRoot, "lock-request.json"),
    lockHeldPath: join(controlRoot, "lock-held"),
    lockObservedPath: join(controlRoot, "lock-observed"),
    lockReleasePath: join(controlRoot, "lock-release"),
    phasePath: join(controlRoot, "writer-pause.json"),
    writerCleanerResultPath: join(controlRoot, "writer-cleaner-result.json"),
    writerReleasePath: join(controlRoot, "writer-release"),
    unlockPath: join(controlRoot, ".host-unlock"),
  };
  mkdirSync(stagedAddonsRoot, { recursive: true });
  mkdirSync(controlRoot, { recursive: true });
  cpSync(productionAddonRoot, stagedProductionRoot, { recursive: true, errorOnExist: true });
  cpSync(acceptanceAddonRoot, stagedAcceptanceRoot, { recursive: true, errorOnExist: true });
  const stagedSourceSnapshot = {
    productionAddon: directoryDigest(stagedProductionRoot),
    acceptanceAddon: directoryDigest(stagedAcceptanceRoot),
  };
  if (stagedSourceSnapshot.productionAddon.digest !== sourceSnapshot.productionAddon.digest ||
      stagedSourceSnapshot.acceptanceAddon.digest !== sourceSnapshot.acceptanceAddon.digest) {
    throw new Error("Staged acceptance source does not match the pre-launch source snapshot");
  }
  const writerHostContext = await createWriterHostContext(paths, stagedProductionRoot, options.timeoutMs);

  const stagedProjectPath = join(stagedAcceptanceRoot, "addon.gproj");
  const addonDirectories = [stagedAddonsRoot, ...configuredAddonDirectories];
  const actualArguments = [
    "-gproj", stagedProjectPath,
    "-addonsDir", addonDirectories.join(","),
    "-profile", profileRoot,
    "-noThrow",
    "-VMErrorMode=fatal",
    "-wbModule=ScriptEditor",
    "-plugin=RFO_MailboxAcceptancePlugin",
    "-run",
    "-rfoCase=all",
    `-rfoRunId=${runId}`,
    "-rfoResult=$profile:RFOAcceptance/result.json",
  ];
  const pathReplacements = [
    [repositoryRoot, "<repository>"],
    [profileRoot, "<isolated-profile>"],
    [dirname(executable), "<workbench>"],
    ...configuredAddonDirectories.map((directory, index) => [directory, `<addon-directory-${index + 1}>`]),
  ];
  atomicWriteJson(controlRoot, join(controlRoot, "host.json"), {
    schemaVersion: 1,
    protocol: "rfo-mailbox-acceptance-host-v1",
    runId,
    resultPath,
    phasePath: paths.phasePath,
    lockRequestPath: paths.lockRequestPath,
    lockHeldPath: paths.lockHeldPath,
    lockObservedPath: paths.lockObservedPath,
    lockReleasePath: paths.lockReleasePath,
    writerPausePath: paths.phasePath,
    writerCleanerResultPath: paths.writerCleanerResultPath,
    writerReleasePath: paths.writerReleasePath,
    timeoutMs: options.timeoutMs,
  });

  let child;
  let exitResult = null;
  let timedOut = false;
  let pluginResult = null;
  let pluginResultError = null;
  let phaseDigest = null;
  const phaseEvents = [];
  let writerHostAction = null;
  const lockEvents = [];
  const handledLockRequests = new Set();
  let lastLockRequestError = null;
  let activeLock = null;
  let stdoutCapture;
  let stderrCapture;

  if (Date.now() >= deadline) {
    throw new Error("Mailbox acceptance total deadline expired before Workbench launch");
  }
  try {
    child = spawn(executable, actualArguments, {
      cwd: dirname(executable),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        RFO_MAILBOX_ACCEPTANCE_RESULT: resultPath,
        RFO_MAILBOX_ACCEPTANCE_CONTROL: controlRoot,
      },
    });
    stdoutCapture = streamCapture(child.stdout);
    stderrCapture = streamCapture(child.stderr);
    const exitPromise = processExit(child).then((result) => { exitResult = result; return result; });

    while (!exitResult && Date.now() < deadline) {
      if (existsSync(paths.phasePath)) {
        try {
          const bytes = readFileSync(paths.phasePath);
          const digest = sha256(bytes);
          if (digest !== phaseDigest) {
            phaseDigest = digest;
            const phase = readBoundedJson(paths.phasePath, "Acceptance phase sentinel", 64 * 1024);
            phaseEvents.push({ at: new Date().toISOString(), phase });
            if (phaseEvents.length > 64) phaseEvents.shift();
            if (phase.caseId === "writer_pause" && writerHostAction === null) {
              writerHostAction = await performWriterPauseHostAction(paths, phase, writerHostContext);
              if (writerHostAction.performed === true) {
                atomicWriteJson(controlRoot, paths.writerCleanerResultPath, {
                  schemaVersion: 1,
                  caseId: "writer_pause",
                  hostCleanerObserved: writerHostAction.hostCleanerObserved === true,
                  preserved: writerHostAction.preserved === true,
                  message: String(writerHostAction.message ?? "host_cleaner_completed").slice(0, 512),
                });
                writeFileSync(paths.writerReleasePath, "release\n", "utf8");
              }
            }
          }
        } catch {
          // A plugin may be between data and atomic publication; retry it.
        }
      }

      if (activeLock) {
        if (!activeLock.acquired && existsSync(paths.lockHeldPath)) {
          try {
            const held = readBoundedJson(paths.lockHeldPath, "Host lock-held sentinel", 64 * 1024);
            if (held.requestId === activeLock.requestId && held.shareMode === "FileShare.None") {
              activeLock.acquired = true;
              activeLock.acquiredAt = new Date().toISOString();
              const event = {
                requestId: activeLock.requestId,
                caseId: activeLock.caseId,
                acquiredAt: activeLock.acquiredAt,
                shareMode: "FileShare.None",
              };
              lockEvents.push(event);
              atomicWriteJson(controlRoot, paths.lockObservedPath, {
                schemaVersion: 1,
                runId,
                requestId: activeLock.requestId,
                caseId: activeLock.caseId,
                shareMode: "FileShare.None",
                observedAt: activeLock.acquiredAt,
              });
              event.observedAckAt = new Date().toISOString();
            }
          } catch {
            // Retry a partially published sentinel.
          }
        }
        let requestStillActive = false;
        if (existsSync(paths.lockRequestPath)) {
          try {
            const currentRequest = readBoundedJson(paths.lockRequestPath, "Host lock request", 64 * 1024);
            requestStillActive = deriveLockRequestId(runId, currentRequest) === activeLock.requestId;
          } catch {
            requestStillActive = true;
          }
        }
        if (!requestStillActive) {
          writeFileSync(paths.unlockPath, `${activeLock.requestId}\n`, "utf8");
          const helperExit = await Promise.race([activeLock.exit, delay(2_000).then(() => null)]);
          if (!helperExit) activeLock.child.kill();
          const helperEvidence = activeLock.stderr.finish();
          const released = activeLock.acquired && helperExit?.exitCode === 0;
          const event = lockEvents.find((item) => item.requestId === activeLock.requestId);
          if (event) {
            event.releasedAt = new Date().toISOString();
            event.released = released;
            event.helperExitCode = helperExit?.exitCode ?? null;
            event.helperStderrSha256 = helperEvidence.sha256;
          }
          atomicWriteJson(controlRoot, paths.lockReleasePath, {
            schemaVersion: 1,
            requestId: activeLock.requestId,
            released,
            releasedAt: new Date().toISOString(),
          });
          activeLock = null;
        }
      } else if (existsSync(paths.lockRequestPath)) {
        try {
          const request = readBoundedJson(paths.lockRequestPath, "Host lock request", 64 * 1024);
          if (request.schemaVersion !== 1 || typeof request.caseId !== "string" ||
              typeof request.targetProfilePath !== "string") {
            throw new Error("Host lock request has an invalid shape");
          }
          const derivedRequestId = deriveLockRequestId(runId, request);
          if (request.requestId !== undefined && request.requestId !== derivedRequestId) {
            throw new Error("Host lock request supplied a non-canonical request ID");
          }
          request.requestId = derivedRequestId;
          if (!/^[A-Za-z0-9._-]{1,96}$/.test(request.requestId)) {
            throw new Error("Host lock request ID is invalid");
          }
          if (!handledLockRequests.has(request.requestId)) {
            handledLockRequests.add(request.requestId);
            activeLock = startFileShareNoneLock(paths, request);
          }
          lastLockRequestError = null;
        } catch (error) {
          // Enforce writers do not have a portable atomic-rename primitive.
          // Retry a partially published request and record each distinct
          // failure once; never delete a request the plugin may still finish.
          const message = error instanceof Error ? error.message : String(error);
          if (message !== lastLockRequestError) {
            lastLockRequestError = message;
            lockEvents.push({
              requestId: null,
              caseId: null,
              acquiredAt: null,
              released: false,
              error: message,
            });
          }
        }
      }

      if (existsSync(resultPath)) {
        try {
          pluginResult = readBoundedJson(resultPath, "Mailbox acceptance result");
          pluginResultError = null;
        } catch (error) {
          pluginResultError = error instanceof Error ? error.message : String(error);
        }
      }
      await Promise.race([exitPromise, delay(25)]);
    }

    if (!exitResult) {
      timedOut = true;
      await terminateWorkbench(child);
      exitResult = await Promise.race([exitPromise, delay(6_000).then(() => ({
        exitCode: null,
        signal: null,
        error: new Error("Workbench did not report exit after termination"),
      }))]);
    }
    if (activeLock) {
      writeFileSync(paths.unlockPath, `${activeLock.requestId}\n`, "utf8");
      await Promise.race([activeLock.exit, delay(2_000)]);
      if (activeLock.child.exitCode === null) activeLock.child.kill();
      activeLock = null;
    }
    if (!pluginResult && existsSync(resultPath)) {
      try { pluginResult = readBoundedJson(resultPath, "Mailbox acceptance result"); }
      catch (error) { pluginResultError = error instanceof Error ? error.message : String(error); }
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) await terminateWorkbench(child);
  }

  const vacancyDeadline = Date.now() + 5_000;
  let remainingPids = listWorkbenchPids();
  while (remainingPids.length > 0 && Date.now() < vacancyDeadline) {
    await delay(50);
    remainingPids = listWorkbenchPids();
  }
  let writerDeliveryProof = { proven: false, reason: "writer_pause_not_observed" };
  if (exitResult !== null && remainingPids.length === 0) {
    try {
      writerDeliveryProof = await proveWriterDeliveryExactlyOnce(writerHostContext, writerHostAction);
    } catch (error) {
      writerDeliveryProof = {
        proven: false,
        reason: "post_exit_delivery_proof_failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } else {
    writerDeliveryProof = { proven: false, reason: "workbench_exit_and_vacancy_not_proven" };
  }
  const finishedAt = new Date();
  const stdout = stdoutCapture.finish();
  const stderr = stderrCapture.finish();
  const diagnostics = collectDiagnostics(profileRoot, pathReplacements);
  const enforceCompilation = analyzeEnforceDiagnostics(stdout, stderr, diagnostics);
  const postRunSourceSnapshot = {
    productionAddon: directoryDigest(productionAddonRoot),
    acceptanceAddon: directoryDigest(acceptanceAddonRoot),
  };
  const compiledHostPostRun = verifyCompiledHostModules();
  const sourceUnchanged = postRunSourceSnapshot.productionAddon.digest === sourceSnapshot.productionAddon.digest &&
    postRunSourceSnapshot.acceptanceAddon.digest === sourceSnapshot.acceptanceAddon.digest &&
    compiledHostPostRun.digest === compiledHostEvidence.digest;
  const combinedDiagnostics = `${stdout.tail}\n${stderr.tail}\n${diagnostics.map((item) => item.tail).join("\n")}`;
  const platformInitializationFailed = /SteamAPI_Init failed|Could not initialize platform services/i
    .test(combinedDiagnostics);
  const caseContract = normalizeCaseResults(pluginResult);
  const cases = caseContract.normalized;
  const unexpectedCases = [...cases.keys()].filter((caseId) => !requiredCases.includes(caseId));
  const caseMetrics = validateCaseMetrics(cases);
  const caseMetricsValid = requiredCases.every((caseId) => caseMetrics[caseId]?.passed === true);
  const pluginContractValid = pluginResult?.schemaVersion === 1 &&
    pluginResult?.suite === "reforger_forge_observer_mailbox_enforce" &&
    pluginResult?.selectedCase === "all" && pluginResult?.runId === runId &&
    enforceBool(pluginResult?.passed) && Array.isArray(pluginResult?.cases) &&
    caseContract.entryCount === requiredCases.length && caseContract.duplicates.length === 0 &&
    unexpectedCases.length === 0 &&
    Number.isSafeInteger(pluginResult?.startedAtUnix) &&
    Number.isSafeInteger(pluginResult?.finishedAtUnix) &&
    pluginResult.finishedAtUnix >= pluginResult.startedAtUnix &&
    pluginResult.startedAtUnix >= Math.floor(startedAt.getTime() / 1000) - 60 &&
    pluginResult.finishedAtUnix <= Math.floor(finishedAt.getTime() / 1000) + 60;
  const missingOrFailedCases = requiredCases.filter((caseId) => !caseMetrics[caseId]?.passed);
  const nonWriterCasesPassed = requiredCases
    .filter((caseId) => caseId !== "writer_pause")
    .every((caseId) => caseMetrics[caseId]?.passed === true);
  const lockProofByCase = Object.fromEntries(["fairness", "deletion_failure"].map((caseId) => [
    caseId,
    lockEvents.some((event) => event.caseId === caseId && event.shareMode === "FileShare.None" &&
      typeof event.observedAckAt === "string" && event.released === true),
  ]));
  const fileShareNoneProof = Object.values(lockProofByCase).every(Boolean);
  const writerPauseObserved = phaseEvents.some((event) =>
    event.phase?.caseId === "writer_pause" &&
      typeof event.phase?.dataProfilePath === "string" &&
      typeof event.phase?.markerProfilePath === "string"
  );
  // Fail closed: only the host integration seam above can establish this;
  // plugin-authored fields are never accepted as host-cleaner authority.
  const hostCleanerProof = writerHostAction?.performed === true &&
    writerHostAction.hostCleanerObserved === true && writerHostAction.preserved === true;
  const processPassed = exitResult?.error === null && exitResult?.exitCode === 0;
  const passed = processPassed && remainingPids.length === 0 && pluginContractValid &&
    caseMetricsValid && fileShareNoneProof && hostCleanerProof && writerDeliveryProof.proven === true &&
    enforceCompilation.proven && sourceUnchanged;
  const result = timedOut
    ? "timed_out"
    : platformInitializationFailed
      ? "environment_failed"
      : (!hostCleanerProof || !writerDeliveryProof.proven) && writerPauseObserved && nonWriterCasesPassed
        ? "incomplete_host_proof"
        : passed
          ? "passed"
          : "failed";

  const artifact = {
    schemaVersion: 1,
    kind: "reforger_forge_observer_enforce_mailbox_acceptance",
    runId,
    result,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    timeoutMs: options.timeoutMs,
    workbench: {
      executable: workbenchExecutableName,
      version: executableVersion(executable),
    },
    invocation: portableArguments(configuredAddonDirectories.length),
    source: {
      productionAddon: {
        project: "observer/addon/addon.gproj",
        ...sourceSnapshot.productionAddon,
        manifest: manifestEvidence,
        stagedDigest: stagedSourceSnapshot.productionAddon.digest,
        postRunDigest: postRunSourceSnapshot.productionAddon.digest,
      },
      acceptanceAddon: {
        project: "tests/fixtures/enforce-mailbox-acceptance-addon/addon.gproj",
        ...sourceSnapshot.acceptanceAddon,
        stagedDigest: stagedSourceSnapshot.acceptanceAddon.digest,
        postRunDigest: postRunSourceSnapshot.acceptanceAddon.digest,
      },
      unchangedDuringRun: sourceUnchanged,
      compiledHost: {
        ...compiledHostEvidence,
        postRunDigest: compiledHostPostRun.digest,
        unchangedDuringRun: compiledHostPostRun.digest === compiledHostEvidence.digest,
      },
    },
    vacancy: {
      preflightWorkbenchCount: preflightPids.length,
      postconditionWorkbenchCount: remainingPids.length,
      proven: remainingPids.length === 0,
    },
    process: {
      pidRecorded: Number.isSafeInteger(child?.pid),
      exitCode: exitResult?.exitCode ?? null,
      signal: exitResult?.signal ?? null,
      errorCode: exitResult?.error?.code ?? null,
      timedOut,
      stdoutBytes: stdout.bytes,
      stdoutSha256: stdout.sha256,
      stdoutTail: boundedTail(sanitizeText(stdout.tail, pathReplacements), 4_096),
      stderrBytes: stderr.bytes,
      stderrSha256: stderr.sha256,
      stderrTail: boundedTail(sanitizeText(stderr.tail, pathReplacements), 4_096),
    },
    enforceCompilation,
    plugin: {
      resultSentinel: "<isolated-profile>/RFOAcceptance/result.json",
      available: pluginResult !== null,
      contractValid: pluginContractValid,
      parseError: pluginResultError,
      reported: sanitizeValue(pluginResult, pathReplacements),
      requiredCases,
      missingOrFailedCases,
      duplicates: caseContract.duplicates,
      unexpectedCases,
      caseMetrics,
    },
    hostOrchestration: {
      protocol: "rfo-mailbox-acceptance-host-v1",
      fileShareNone: {
        proven: fileShareNoneProof,
        byCase: lockProofByCase,
        events: lockEvents.map((event) => sanitizeValue(event, pathReplacements)),
      },
      writerPause: {
        phaseObserved: writerPauseObserved,
        hostCleanerProof,
        exactlyOnceDelivery: sanitizeValue(writerDeliveryProof, pathReplacements),
        hostAction: sanitizeValue(writerHostAction, pathReplacements),
        note: "Host proof requires production MailboxCoordinator preservation during the pause, first-poll delivery/removal, and no second-poll redelivery after Workbench exit and vacancy.",
      },
      phaseEvents: phaseEvents.map((event) => ({
        at: event.at,
        phase: sanitizeValue(event.phase, pathReplacements),
      })),
    },
    environmentBlocker: platformInitializationFailed ? "steam_platform_initialization_failed" : null,
    isolatedProfileDiagnostics: diagnostics.map(({ tail: _tail, scanText: _scanText, ...metadata }) => metadata),
  };
  mkdirSync(dirname(options.artifactPath), { recursive: true });
  writeFileSync(options.artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  return { artifact, artifactPath: options.artifactPath, retainedProfile: options.keepProfile ? profileRoot : null };
  } finally {
    if (!options.keepProfile) rmSync(profileRoot, { recursive: true, force: true });
  }
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/run-observer-enforce-mailbox-acceptance.mjs " +
      "[--config path] [--workbench path] [--addons-dir path ...] " +
      "[--timeout-ms 240000] [--artifact path] [--keep-profile]\n"
    );
  } else {
    const { artifact, artifactPath, retainedProfile } = await runAcceptance(options);
    process.stdout.write(`Mailbox acceptance artifact: ${artifactPath}\n`);
    if (retainedProfile) process.stdout.write(`Isolated profile retained: ${retainedProfile}\n`);
    if (artifact.result !== "passed") {
      process.stderr.write(`Mailbox acceptance did not pass: ${artifact.result}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write("Workbench Enforce mailbox acceptance passed.\n");
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
