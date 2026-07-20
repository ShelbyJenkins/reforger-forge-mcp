import { createHash } from "node:crypto";
import {
  existsSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const defaultConfigPath = join(repositoryRoot, "reforger-forge.config.json");
const defaultArtifactPath = join(repositoryRoot, ".artifacts", "observer-enforce-compile.json");
const addonProjectPath = join(repositoryRoot, "observer", "addon", "addon.gproj");
const addonRoot = dirname(addonProjectPath);
const addonManifestPath = join(repositoryRoot, "observer", "addon", ".reforger-forge-observer-source.json");
const mailboxSourcePath = join(
  repositoryRoot,
  "observer",
  "addon",
  "Scripts",
  "Game",
  "ReforgerForgeObserver",
  "RFO_ObserverMailboxTransport.c"
);
const workbenchExecutableName = "ArmaReforgerWorkbenchSteamDiag.exe";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function parseArguments(argv) {
  const result = {
    artifactPath: defaultArtifactPath,
    configPath: defaultConfigPath,
    configuration: "PC",
    timeoutMs: 180_000,
    workbenchPath: null,
    addonDirectories: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (["--artifact", "--config", "--configuration", "--timeout-ms", "--workbench", "--addons-dir"].includes(argument)) {
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      index += 1;
    }
    if (argument === "--artifact") result.artifactPath = resolve(value);
    else if (argument === "--config") result.configPath = resolve(value);
    else if (argument === "--configuration") result.configuration = value;
    else if (argument === "--timeout-ms") result.timeoutMs = Number(value);
    else if (argument === "--workbench") result.workbenchPath = resolve(value);
    else if (argument === "--addons-dir") result.addonDirectories.push(resolve(value));
    else if (argument === "--help") result.help = true;
    else if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    else if (!["--artifact", "--config", "--configuration", "--timeout-ms", "--workbench", "--addons-dir"].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!/^[A-Za-z0-9_]{1,32}$/.test(result.configuration)) {
    throw new Error("--configuration must be a bounded Workbench configuration identifier");
  }
  if (!Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 30_000 || result.timeoutMs > 900_000) {
    throw new Error("--timeout-ms must be an integer from 30000 through 900000");
  }
  return result;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileSha256(path) {
  return sha256(readFileSync(path));
}

function requiredFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} is missing: ${path}`);
  return path;
}

function resolveWorkbenchExecutable(workbenchPath) {
  const candidates = [
    workbenchPath,
    join(workbenchPath, workbenchExecutableName),
    join(workbenchPath, "Workbench", workbenchExecutableName),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile() && basename(candidate).toLowerCase() === workbenchExecutableName.toLowerCase()) {
      return candidate;
    }
  }
  throw new Error(`Could not find ${workbenchExecutableName} beneath the configured Workbench path`);
}

function readConfiguration(path) {
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workbench config must be a JSON object");
  return value;
}

function workbenchIsRunning() {
  const result = spawnSync("tasklist.exe", ["/FI", `IMAGENAME eq ${workbenchExecutableName}`, "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) throw new Error("Could not prove Workbench process vacancy");
  return result.stdout.toLowerCase().includes(workbenchExecutableName.toLowerCase());
}

function executableVersion(path) {
  const escaped = path.replaceAll("'", "''");
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `(Get-Item -LiteralPath '${escaped}').VersionInfo.FileVersion`],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 }
  );
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function boundedTail(value, maximum = 16_384) {
  const text = typeof value === "string" ? value : "";
  return text.length <= maximum ? text : text.slice(-maximum);
}

function sanitizeText(value, replacements) {
  let result = value;
  for (const [path, label] of replacements) {
    result = result.replaceAll(path, label);
    result = result.replaceAll(path.replaceAll("\\", "/"), label);
  }
  return result.replace(/\b7656119\d{10}\b/g, "<steam-id>");
}

function collectProfileDiagnostics(root, replacements) {
  const diagnostics = [];
  const pending = [root];
  let inspected = 0;
  while (pending.length > 0 && inspected < 512 && diagnostics.length < 32) {
    const directory = pending.shift();
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      inspected += 1;
      if (inspected > 512) break;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile() || !/\.(?:log|txt)$/i.test(entry.name)) continue;
      try {
        const bytes = readFileSync(path);
        diagnostics.push({
          path: relative(root, path).replaceAll("\\", "/"),
          bytes: bytes.length,
          sha256: sha256(bytes),
          tail: boundedTail(sanitizeText(bytes.toString("utf8"), replacements)),
        });
      } catch {
        // Diagnostics are supplementary; the process result remains authority.
      }
    }
  }
  return diagnostics;
}

function portableArguments(configuration, addonDirectoryCount) {
  return [
    "-gproj", "observer/addon/addon.gproj",
    "-addonsDir", `<${addonDirectoryCount} configured addon director${addonDirectoryCount === 1 ? "y" : "ies"}>`,
    "-profile", "<temporary isolated profile>",
    "-noThrow",
    "-wbsilent",
    "-wbModule=ScriptEditor",
    "-validate", configuration,
  ];
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (!options) {
  // parseArguments already reported the failure.
} else if (options.help) {
  process.stdout.write(
    "Usage: node scripts/validate-observer-enforce.mjs [--config path] [--workbench path] " +
    "[--addons-dir path ...] [--configuration PC] [--timeout-ms 180000] [--artifact path]\n"
  );
} else {
  let temporaryProfileRoot = null;
  try {
    requiredFile(addonProjectPath, "Observer addon project");
    requiredFile(addonManifestPath, "Observer addon source manifest");
    requiredFile(mailboxSourcePath, "Observer mailbox source");
    const config = readConfiguration(options.configPath);
    const configuredWorkbenchPath = options.workbenchPath ??
      (typeof config.workbenchPath === "string" && config.workbenchPath.length > 0 ? resolve(config.workbenchPath) : null);
    if (!configuredWorkbenchPath) throw new Error("Configure workbenchPath or pass --workbench");
    const executable = resolveWorkbenchExecutable(configuredWorkbenchPath);
    const configuredAddonDirectories = options.addonDirectories.length > 0
      ? options.addonDirectories
      : Array.isArray(config.workbenchAddonDirs)
        ? config.workbenchAddonDirs.filter((value) => typeof value === "string" && value.length > 0).map((value) => resolve(value))
        : [];
    if (configuredAddonDirectories.length === 0) {
      throw new Error("Configure workbenchAddonDirs or pass at least one --addons-dir for project dependency resolution");
    }
    for (const directory of configuredAddonDirectories) {
      if (!isAbsolute(directory) || !existsSync(directory) || !statSync(directory).isDirectory()) {
        throw new Error(`Configured Workbench addon directory is missing: ${directory}`);
      }
    }
    if (workbenchIsRunning()) {
      throw new Error("Enforce validation refuses to run while an existing Workbench process is active");
    }

    temporaryProfileRoot = mkdtempSync(join(tmpdir(), "reforger-forge-enforce-"));
    const stagedAddonRoot = join(temporaryProfileRoot, "addon", "ReforgerForgeObserver");
    cpSync(addonRoot, stagedAddonRoot, { recursive: true, errorOnExist: true });
    const stagedProjectPath = join(stagedAddonRoot, "addon.gproj");
    const actualArguments = [
      "-gproj", stagedProjectPath,
      "-addonsDir", configuredAddonDirectories.join(","),
      "-profile", temporaryProfileRoot,
      "-noThrow",
      "-wbsilent",
      "-wbModule=ScriptEditor",
      "-validate", options.configuration,
    ];
    const startedAt = new Date();
    const result = spawnSync(executable, actualArguments, {
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    const finishedAt = new Date();
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    const pathReplacements = [
      [repositoryRoot, "<repository>"],
      [temporaryProfileRoot, "<isolated-profile>"],
      [dirname(executable), "<workbench>"],
      ...configuredAddonDirectories.map((directory, index) => [directory, `<addon-directory-${index + 1}>`]),
    ];
    const diagnostics = collectProfileDiagnostics(temporaryProfileRoot, pathReplacements);
    const diagnosticText = diagnostics.map((item) => item.tail).join("\n");
    const compilerText = `${stdout}\n${stderr}\n${diagnosticText}`;
    const scriptErrorLines = compilerText.split(/\r?\n/)
      .filter((line) => /SCRIPT\s+\(E\)|Can't compile .* script module/i.test(line))
      .slice(0, 64);
    const validationSuccessMarker = /Script validation successful\./i.test(compilerText);
    const gameModuleLoaded = validationSuccessMarker || /SCRIPT\s+: Module: Game; loaded \d+x files;/i.test(diagnosticText);
    const compilationFinished = validationSuccessMarker || /PROFILING\s+: Compiling Game scripts took:/i.test(diagnosticText);
    const platformInitializationFailed = /SteamAPI_Init failed|Could not initialize platform services/i.test(compilerText);
    const compilerStageCompletedWithoutErrors = gameModuleLoaded && compilationFinished && scriptErrorLines.length === 0;
    const passed = !result.error && result.status === 0 && compilerStageCompletedWithoutErrors;
    const manifest = JSON.parse(readFileSync(addonManifestPath, "utf8"));
    const artifact = {
      schemaVersion: 1,
      kind: "reforger_forge_observer_enforce_compile",
      result: passed
        ? "passed"
        : result.error?.code === "ETIMEDOUT"
          ? "timed_out"
          : compilerStageCompletedWithoutErrors && platformInitializationFailed
            ? "environment_failed"
            : "failed",
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      workbench: {
        executable: workbenchExecutableName,
        version: executableVersion(executable),
        configuration: options.configuration,
      },
      invocation: portableArguments(options.configuration, configuredAddonDirectories.length),
      source: {
        project: relative(repositoryRoot, addonProjectPath).replaceAll("\\", "/"),
        projectSha256: fileSha256(addonProjectPath),
        manifestSha256: fileSha256(addonManifestPath),
        declaredBundleDigest: typeof manifest.bundleDigest === "string" ? manifest.bundleDigest : null,
        mailboxSourceSha256: fileSha256(mailboxSourcePath),
      },
      enforceCompilation: {
        stage: compilerStageCompletedWithoutErrors ? "completed_without_script_errors" : "failed_or_unproven",
        authoritativeExitPass: passed,
        validationSuccessMarker,
        gameModuleLoaded,
        compilationFinished,
        scriptErrorLines,
      },
      environmentBlocker: platformInitializationFailed ? "steam_platform_initialization_failed" : null,
      process: {
        exitCode: result.status,
        signal: result.signal,
        errorCode: result.error?.code ?? null,
        stdoutSha256: sha256(stdout),
        stderrSha256: sha256(stderr),
        stdoutTail: boundedTail(sanitizeText(stdout, pathReplacements), 2_048),
        stderrTail: boundedTail(sanitizeText(stderr, pathReplacements), 2_048),
      },
      isolatedProfileDiagnostics: diagnostics.map(({ tail: _tail, ...metadata }) => metadata),
      behavioralMailboxAcceptance: {
        result: "not_run",
        note: "ScriptEditor validation compiles Enforce source but does not execute V3/V4 mailbox runtime behavior.",
      },
    };
    mkdirSync(dirname(options.artifactPath), { recursive: true });
    writeFileSync(options.artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    process.stdout.write(`Enforce compile artifact: ${options.artifactPath}\n`);
    if (!passed) {
      fail(`Workbench Enforce validation failed${result.status === null ? "" : ` with exit code ${result.status}`}`);
    } else {
      process.stdout.write(`Workbench Enforce validation passed (${artifact.workbench.version ?? "unknown version"}).\n`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    if (temporaryProfileRoot) rmSync(temporaryProfileRoot, { recursive: true, force: true });
  }
}
