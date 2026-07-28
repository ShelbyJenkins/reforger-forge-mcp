import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url))
);
const temporaryRoots: string[] = [];

function read(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

function write(path: string, value: string): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, value, "utf8");
}

function canonicalReceiptJson(
  operation: "setup" | "doctor",
  overallStatus: "passed" | "failed",
  managedChanges: readonly Record<string, unknown>[] = []
): string {
  const level = (status: "passed" | "not_tested" | "not_run") => ({
    status,
    issues: [],
  });
  return JSON.stringify({
    schemaVersion: 1,
    operation,
    overallStatus,
    runtime: {
      serverPath: "fixture-server",
      serverPresent: true,
      nodePath: "node",
      nodeVersion: "v20.99.0",
      serverVersion: "0.0.0-test",
      transport: "stdio",
    },
    settings: {
      configPath: null,
      gamePath: "fixture-game",
      workbenchPath: "fixture-tools",
      workbenchAddonDirs: [],
      startupArguments: [],
      steamCandidates: { game: [], workbench: [] },
    },
    verification: {
      steamDiscovery: level(overallStatus === "passed" ? "passed" : "not_run"),
      effectiveSettings: level(
        overallStatus === "passed" ? "passed" : "not_run"
      ),
      serverHandshake: level(
        overallStatus === "passed" ? "passed" : "not_run"
      ),
      toolRegistration: level(
        overallStatus === "passed" ? "passed" : "not_run"
      ),
      clientRegistration: level(
        overallStatus === "passed" ? "passed" : "not_run"
      ),
      workbenchNetApi: level("not_tested"),
      observerCapture: level("not_tested"),
    },
    clients: [],
    modifiedFiles: [],
    managedChanges,
    backups: [],
    skipped: [],
    ambiguous: [],
    nextActions: [],
    ...(overallStatus === "failed"
      ? {
        failure: {
          layer: "verification",
          message: "Fixture verification failed.",
        },
      }
      : {}),
  });
}

function canonicalReceiptWithoutManagedChanges(): string {
  const receipt = JSON.parse(
    canonicalReceiptJson("setup", "passed")
  ) as Record<string, unknown>;
  delete receipt.managedChanges;
  return JSON.stringify(receipt);
}

function setupHarness(): {
  root: string;
  logPath: string;
  environmentLogPath: string;
  environment: NodeJS.ProcessEnv;
} {
  const root = mkdtempSync(join(tmpdir(), "reforger-forge-issue04-"));
  temporaryRoots.push(root);

  const scripts = join(root, "scripts");
  const shims = join(root, "command-shims");
  const logPath = join(root, "calls.log");
  const environmentLogPath = join(root, "environment.log");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(shims, { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });

  copyFileSync(
    resolve(repositoryRoot, "scripts", "setup.ps1"),
    join(scripts, "setup.ps1")
  );
  write(join(root, "package.json"), "{}\n");
  write(join(root, "package-lock.json"), "{}\n");
  write(join(root, "tsconfig.build.json"), "{}\n");
  write(join(root, "src", "index.ts"), "export {};\n");
  write(join(scripts, "verify-mcp-server.mjs"), "/* harness marker */\n");

  write(
    join(shims, "node.cmd"),
    [
      "@echo off",
      'if "%~1"=="--version" (',
      "  echo v20.99.0",
      "  exit /b 0",
      ")",
      'echo node^|%*>>"%ISSUE04_CALL_LOG%"',
      'for %%F in ("%~1") do if /I "%%~nxF"=="verify-mcp-server.mjs" (',
      '  echo verifier^|report=%REFORGER_FORGE_VERIFY_REPORT_PATH%^|quiet=%REFORGER_FORGE_VERIFY_QUIET%^|json=%REFORGER_FORGE_VERIFY_JSON%>>"%ISSUE05_ENV_LOG%"',
      '  echo {}>"%REFORGER_FORGE_VERIFY_REPORT_PATH%"',
      "  exit /b %ISSUE04_VERIFY_EXIT%",
      ")",
      'for %%F in ("%~1") do if /I "%%~nxF"=="register-clients-cli.js" (',
      '  echo registration^|report=%REFORGER_FORGE_VERIFY_REPORT_PATH%^|quiet=%REFORGER_FORGE_VERIFY_QUIET%^|json=%REFORGER_FORGE_VERIFY_JSON%>>"%ISSUE05_ENV_LOG%"',
      '  if /I "%ISSUE05_REGISTRATION_RECEIPT_MODE%"=="empty" exit /b 0',
      '  if /I "%ISSUE05_REGISTRATION_RECEIPT_MODE%"=="corrupt" (',
      "    echo stale registration output",
      "    exit /b 0",
      "  )",
      '  if /I "%ISSUE05_REGISTRATION_RECEIPT_MODE%"=="missing-managed" (',
      `    echo ${canonicalReceiptWithoutManagedChanges()}`,
      "    exit /b 0",
      "  )",
      '  if /I "%ISSUE05_REGISTRATION_RECEIPT_MODE%"=="managed-change" (',
      `    echo ${canonicalReceiptJson("setup", "passed", [{
        clientId: "codex",
        clientName: "Codex",
        kind: "client_cli",
        command: "codex.exe",
        scope: "user",
        configFile: null,
        configFileVerification: "unverified",
        detail: "Updated user registration through the client CLI.",
      }])}`,
      "    exit /b 0",
      "  )",
      `  echo ${canonicalReceiptJson("setup", "passed")}`,
      "  exit /b 0",
      ")",
      'for %%F in ("%~1") do if /I "%%~nxF"=="setup-receipt-cli.js" (',
      `  echo ${canonicalReceiptJson("setup", "failed")}`,
      "  exit /b 1",
      ")",
      'for %%F in ("%~1") do if /I "%%~nxF"=="doctor-cli.js" (',
      '  if /I "%ISSUE05_DOCTOR_RECEIPT_MODE%"=="empty" exit /b 0',
      '  if /I "%ISSUE05_DOCTOR_RECEIPT_MODE%"=="wrong-operation" (',
      `    echo ${canonicalReceiptJson("setup", "passed")}`,
      "    exit /b 0",
      "  )",
      `  echo ${canonicalReceiptJson("doctor", "passed")}`,
      "  exit /b 0",
      ")",
      "exit /b 0",
      "",
    ].join("\r\n")
  );
  write(
    join(shims, "npm.cmd"),
    [
      "@echo off",
      'echo npm^|%*>>"%ISSUE04_CALL_LOG%"',
      'if /I "%~1"=="ci" exit /b 0',
      'if /I "%~1"=="run" if /I "%~2"=="build" (',
      '  if not exist "%ISSUE04_FIXTURE_ROOT%\\dist\\setup" ' +
        'mkdir "%ISSUE04_FIXTURE_ROOT%\\dist\\setup"',
      '  type nul >"%ISSUE04_FIXTURE_ROOT%\\dist\\index.js"',
      '  type nul >"%ISSUE04_FIXTURE_ROOT%\\dist\\setup\\client-registration.js"',
      '  type nul >"%ISSUE04_FIXTURE_ROOT%\\dist\\setup\\register-clients-cli.js"',
      '  type nul >"%ISSUE04_FIXTURE_ROOT%\\dist\\setup\\server-verification.js"',
      '  type nul >"%ISSUE04_FIXTURE_ROOT%\\dist\\setup\\setup-receipt.js"',
      '  type nul >"%ISSUE04_FIXTURE_ROOT%\\dist\\setup\\setup-receipt-cli.js"',
      "  exit /b 0",
      ")",
      "exit /b 87",
      "",
    ].join("\r\n")
  );

  return {
    root,
    logPath,
    environmentLogPath,
    environment: {
      ...process.env,
      PATH: `${shims}${delimiter}${process.env.PATH ?? ""}`,
      ISSUE04_CALL_LOG: logPath,
      ISSUE04_FIXTURE_ROOT: root,
      ISSUE04_VERIFY_EXIT: "0",
      ISSUE05_ENV_LOG: environmentLogPath,
    },
  };
}

function doctorHarness(): ReturnType<typeof setupHarness> {
  const harness = setupHarness();
  for (const path of [
    join(harness.root, "dist", "index.js"),
    join(harness.root, "dist", "setup", "doctor-cli.js"),
    join(harness.root, "dist", "setup", "doctor.js"),
    join(harness.root, "dist", "setup", "client-registration.js"),
    join(harness.root, "dist", "setup", "server-verification.js"),
    join(harness.root, "dist", "setup", "setup-receipt.js"),
    join(harness.root, "dist", "workbench", "net-api-client.js"),
  ]) {
    write(path, "");
  }
  return harness;
}

function installerHarness(): ReturnType<typeof setupHarness> & {
  configPath: string;
  cursorConfigPath: string;
} {
  const harness = setupHarness();
  const agents = join(harness.root, "agents");
  const lifecycleDirectory = join(harness.root, "scripts", "windows");
  const profile = join(harness.root, "profile");
  const appData = join(profile, "AppData", "Roaming");
  const configPath = join(harness.root, "explicit-overrides.json");
  const cursorConfigPath = join(profile, ".cursor", "mcp.json");

  mkdirSync(agents, { recursive: true });
  mkdirSync(lifecycleDirectory, { recursive: true });
  mkdirSync(join(harness.root, "dist"), { recursive: true });
  copyFileSync(
    resolve(repositoryRoot, "agents", "install-agents.ps1"),
    join(agents, "install-agents.ps1")
  );
  write(join(harness.root, "dist", "index.js"), "");
  write(join(lifecycleDirectory, "workbench-lifecycle.ps1"), "");
  write(configPath, "{}\n");

  return {
    ...harness,
    configPath,
    cursorConfigPath,
    environment: {
      ...harness.environment,
      USERPROFILE: profile,
      APPDATA: appData,
    },
  };
}

function runSetup(
  harness: ReturnType<typeof setupHarness>,
  verificationExitCode = 0,
  setupArguments: readonly string[] = []
) {
  return spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(harness.root, "scripts", "setup.ps1"),
      ...setupArguments,
    ],
    {
      encoding: "utf8",
      env: {
        ...harness.environment,
        ISSUE04_VERIFY_EXIT: String(verificationExitCode),
      },
      timeout: 20_000,
      windowsHide: true,
    }
  );
}

function runInstaller(
  harness: ReturnType<typeof installerHarness>,
  verificationExitCode = 0
) {
  return spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(harness.root, "agents", "install-agents.ps1"),
      "-ConfigPath",
      harness.configPath,
      "-Agent",
      "cursor",
    ],
    {
      encoding: "utf8",
      env: {
        ...harness.environment,
        ISSUE04_VERIFY_EXIT: String(verificationExitCode),
      },
      timeout: 20_000,
      windowsHide: true,
    }
  );
}

function calls(harness: ReturnType<typeof setupHarness>): string[] {
  return readFileSync(harness.logPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

const windowsIt = process.platform === "win32" ? it : it.skip;

describe("Issue 04 build and verification lifecycle", () => {
  windowsIt(
    "executes one dependency install, build, verification, and registration",
    () => {
      const harness = setupHarness();
      const result = runSetup(harness);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(calls(harness).map((call) => call.split("|", 1)[0])).toEqual([
        "npm",
        "npm",
        "node",
        "node",
      ]);
      expect(calls(harness)[0]).toBe("npm|ci");
      expect(calls(harness)[1]).toBe("npm|run build");
      expect(calls(harness)[2]).toMatch(
        /^node\|.*scripts[\\/]verify-mcp-server\.mjs$/
      );
      expect(calls(harness)[3]).toMatch(
        /^node\|.*dist[\\/]setup[\\/]register-clients-cli\.js --server .*dist[\\/]index\.js --verification-report .*reforger-forge-setup-[a-f0-9]+\.json --json$/
      );
    }
  );

  windowsIt(
    "Doctor and CheckWorkbench bypass install, build, verification, and registration",
    () => {
      const harness = doctorHarness();
      const result = runSetup(
        harness,
        0,
        ["-Doctor", "-CheckWorkbench", "-Json"]
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        operation: "doctor",
      });
      expect(calls(harness)).toHaveLength(1);
      expect(calls(harness)[0]).toMatch(
        /^node\|.*doctor-cli\.js --server .*dist[\\/]index\.js --check-workbench --json$/
      );
      expect(calls(harness).join("\n")).not.toMatch(
        /verify-mcp-server|register-clients|npm/i
      );
    }
  );

  windowsIt(
    "rejects a zero-exit Doctor child receipt for the wrong operation in human mode",
    () => {
      const harness = doctorHarness();
      harness.environment.ISSUE05_DOCTOR_RECEIPT_MODE =
        "wrong-operation";
      const result = runSetup(harness, 0, ["-Doctor"]);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("ReforgerForge doctor failed");
      expect(result.stdout).toContain("Receipt schema: 1");
      expect(result.stdout).toContain("Overall status: failed");
      expect(result.stdout).toContain("Failed layer:   doctor");
      for (const label of [
        "Steam discovery:",
        "Effective settings:",
        "Server handshake:",
        "Tool registration:",
        "Client registration:",
        "Workbench NET API:",
        "Observer capture:",
      ]) {
        expect(result.stdout).toContain(label);
      }
      expect(calls(harness)).toHaveLength(1);
      expect(calls(harness)[0]).toMatch(
        /^node\|.*doctor-cli\.js --server .*dist[\\/]index\.js --json$/
      );
    }
  );

  windowsIt(
    "Json setup emits one receipt, isolates verifier output, restores env, and deletes its report",
    () => {
      const harness = setupHarness();
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(harness.root, "scripts", "setup.ps1"),
          "-Json",
        ],
        {
          encoding: "utf8",
          env: {
            ...harness.environment,
            REFORGER_FORGE_VERIFY_REPORT_PATH: "inherited-report",
            REFORGER_FORGE_VERIFY_QUIET: "inherited-quiet",
            REFORGER_FORGE_VERIFY_JSON: "1",
          },
          timeout: 20_000,
          windowsHide: true,
        }
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        operation: "setup",
        overallStatus: "passed",
      });
      const environmentLines = readFileSync(
        harness.environmentLogPath,
        "utf8"
      ).trim().split(/\r?\n/);
      expect(environmentLines[0]).toMatch(
        /^verifier\|report=.*reforger-forge-setup-[a-f0-9]+\.json\|quiet=1\|json=$/
      );
      expect(environmentLines[1]).toBe(
        "registration|report=inherited-report|quiet=inherited-quiet|json="
      );

      const registrationCall = calls(harness).find((call) =>
        call.includes("register-clients-cli.js")
      );
      const reportPath = registrationCall?.match(
        /--verification-report (.*reforger-forge-setup-[a-f0-9]+\.json) --json$/
      )?.[1];
      expect(reportPath).toBeDefined();
      expect(existsSync(reportPath!)).toBe(false);
      expect(result.stderr).toContain("Verifying config-free MCP startup");
    }
  );

  windowsIt(
    "rejects corrupt output from a zero-exit registration child in human mode",
    () => {
      const harness = setupHarness();
      harness.environment.ISSUE05_REGISTRATION_RECEIPT_MODE = "corrupt";
      const result = runSetup(harness);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("ReforgerForge setup failed");
      expect(result.stdout).toContain("Receipt schema: 1");
      expect(result.stdout).toContain("Failed layer:   registration");
      expect(result.stdout).toContain(
        "Client registration exited without a valid receipt."
      );
      expect(calls(harness).at(-1)).toMatch(
        /register-clients-cli\.js .* --json$/
      );
    }
  );

  windowsIt(
    "discloses CLI-managed state changes without claiming no state changed",
    () => {
      const harness = setupHarness();
      harness.environment.ISSUE05_REGISTRATION_RECEIPT_MODE =
        "managed-change";
      const result = runSetup(harness);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "none directly verified; client-CLI changes are listed separately"
      );
      expect(result.stdout).toContain("Client-managed changes:");
      expect(result.stdout).toContain("Codex (codex)");
      expect(result.stdout).toContain("Command: codex.exe");
      expect(result.stdout).toContain(
        "Scope: user; config file: unverified"
      );
    }
  );

  windowsIt(
    "rejects a child receipt missing the required managed-change ledger",
    () => {
      const harness = setupHarness();
      harness.environment.ISSUE05_REGISTRATION_RECEIPT_MODE =
        "missing-managed";
      const result = runSetup(harness);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("ReforgerForge setup failed");
      expect(result.stdout).toContain("Failed layer:   registration");
      expect(result.stdout).toContain(
        "Client registration exited without a valid receipt."
      );
    }
  );

  windowsIt("does not register clients when MCP verification fails", () => {
    const harness = setupHarness();
    const result = runSetup(harness, 19);
    const recordedCalls = calls(harness);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(recordedCalls).toHaveLength(4);
    expect(recordedCalls[0]).toBe("npm|ci");
    expect(recordedCalls[1]).toBe("npm|run build");
    expect(recordedCalls[2]).toMatch(
      /^node\|.*scripts[\\/]verify-mcp-server\.mjs$/
    );
    expect(recordedCalls[3]).toMatch(
      /^node\|.*dist[\\/]setup[\\/]setup-receipt-cli\.js --server .*dist[\\/]index\.js --verification-report .*reforger-forge-setup-[a-f0-9]+\.json --json$/
    );
    expect(recordedCalls.join("\n")).not.toMatch(
      /register-clients-cli|install-agents/i
    );
  });

  windowsIt(
    "standalone explicit-config installation verifies once before mutation",
    () => {
      const harness = installerHarness();
      const result = runInstaller(harness);
      const recordedCalls = calls(harness);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(recordedCalls).toHaveLength(1);
      expect(recordedCalls[0]).toMatch(
        /^node\|.*scripts[\\/]verify-mcp-server\.mjs --config .*[\\/]explicit-overrides\.json$/
      );
      const cursorDocument = JSON.parse(
        readFileSync(harness.cursorConfigPath, "utf8")
      ) as {
        mcpServers?: Record<
          string,
          { command?: string; args?: string[] }
        >;
      };
      expect(cursorDocument.mcpServers?.["reforger-forge"]).toEqual({
        command: "node",
        args: [
          join(harness.root, "dist", "index.js"),
          "--config",
          harness.configPath,
        ],
      });
    }
  );

  windowsIt(
    "standalone verification failure leaves client configuration untouched",
    () => {
      const harness = installerHarness();
      const result = runInstaller(harness, 23);

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(calls(harness)).toHaveLength(1);
      expect(() => readFileSync(harness.cursorConfigPath)).toThrow();
    }
  );

  it("forwards zero or more verifier startup arguments without inventing config", () => {
    const verifier = read("scripts/verify-mcp-server.mjs");
    const verifierCore = read("src/setup/server-verification.ts");

    expect(verifier).toContain("const serverArguments = process.argv.slice(2);");
    expect(verifier).toContain("startupArguments: serverArguments");
    expect(verifierCore).toMatch(
      /args:\s*\[\s*options\.serverPath,\s*\.\.\.options\.startupArguments\s*\]/
    );
    expect(verifier).not.toMatch(
      /serverArguments\.(?:length|at)\b[^]*?(?:throw|process\.exit|--config)/
    );
  });

  it("always closes the verifier client and uses the package version", () => {
    const verifier = read("scripts/verify-mcp-server.mjs");
    const verifierCore = read("src/setup/server-verification.ts");
    const verificationBlock = verifierCore.slice(
      verifierCore.indexOf("export async function verifyMcpServer"),
      verifierCore.indexOf("function statusLine")
    );

    expect(verifier).toContain(
      "packageVersion: packageDocument.version"
    );
    expect(verificationBlock).toMatch(
      /try\s*\{[^]*session\.connect\(\)[^]*session\.listTools\(\)[^]*finally\s*\{[^]*session\.close\(\)/
    );
  });

  it("keeps setup-owned registration separate from the verifying installer", () => {
    const setup = read("scripts/setup.ps1");
    const installer = read("agents/install-agents.ps1");
    const registrationSources = [
      read("src/setup/client-registration.ts"),
      read("src/setup/register-clients-cli.ts"),
    ].join("\n");

    expect(setup).not.toContain("install-agents.ps1");
    expect(registrationSources).not.toMatch(/verify-mcp-server/i);
    expect(
      installer.match(
        /node\s+\(Join-Path \$Root "scripts\\verify-mcp-server\.mjs"\)/gi
      )
    ).toHaveLength(1);
    expect(installer).not.toMatch(
      /SkipVerification|VerificationReceipt|TrustVerification/i
    );
  });

  it("uses a publish-time build and package smoke does not compile twice", () => {
    const packageDocument = JSON.parse(read("package.json")) as {
      files?: string[];
      scripts?: Record<string, string>;
    };
    const packageCheck = read("scripts/check-package.mjs");

    expect(packageDocument.scripts).not.toHaveProperty("prepare");
    expect(packageDocument.scripts?.prepack).toBe("npm run build");
    expect(packageDocument.scripts?.["test:package"]).toBe(
      "npm run build && node scripts/check-package.mjs"
    );
    expect(packageDocument.files).toContain("dist");
    expect(packageCheck).toMatch(
      /"pack",\s*\r?\n\s*"--json",\s*\r?\n\s*"--ignore-scripts"/
    );
    expect(packageCheck).toContain('"dist/index.js"');
    expect(packageCheck).toContain('"dist/setup/client-registration.js"');
    expect(packageCheck).toContain('"dist/setup/register-clients-cli.js"');
    expect(packageCheck).toContain('"dist/setup/server-verification.js"');
    expect(packageCheck).toContain('"dist/setup/setup-receipt.js"');
    expect(packageCheck).toContain('"dist/setup/setup-receipt-cli.js"');
    expect(packageCheck).toContain('"dist/setup/doctor.js"');
    expect(packageCheck).toContain('"dist/setup/doctor-cli.js"');
  });
});
