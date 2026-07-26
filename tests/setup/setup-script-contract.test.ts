import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url))
);

function read(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

function executableLines(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function matchingLines(source: string, pattern: RegExp): string[] {
  return executableLines(source).filter((line) => pattern.test(line));
}

describe("one-command setup orchestration contract", () => {
  it("documents policy-independent setup and Doctor entry points", () => {
    const setupGuide = read("setup.md");
    const policyIndependentPrefix =
      "powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\setup.ps1";

    expect(setupGuide).toContain(policyIndependentPrefix);
    expect(setupGuide).toContain(`${policyIndependentPrefix} -Doctor`);
    expect(setupGuide).toContain(`${policyIndependentPrefix} -Doctor -Json`);
    expect(setupGuide).toContain(
      `${policyIndependentPrefix} -Doctor -CheckWorkbench`
    );
  });

  it("accepts only Doctor, CheckWorkbench, and Json switches", () => {
    const setup = read("scripts/setup.ps1");
    const argumentGuard = setup.search(
      /\$args\.Count\s*(?:-gt|-ne)\s*0|if\s*\(\s*\$args\s*\)/i
    );
    const dependencyInstall = setup.search(/Installing dependencies/i);

    const topLevelParameters =
      setup.match(
        /^param\(([^]*?)^\)/m
      )?.[1] ?? "";
    expect(topLevelParameters).toMatch(/\[switch\]\$Doctor\b/i);
    expect(topLevelParameters).toMatch(/\[switch\]\$CheckWorkbench\b/i);
    expect(topLevelParameters).toMatch(/\[switch\]\$Json\b/i);
    expect(topLevelParameters.match(/\[switch\]\$/gi)).toHaveLength(3);
    expect(setup).not.toMatch(/\[CmdletBinding/i);
    expect(setup).not.toMatch(
      /\$(?:ConfigPath|ProjectPath|WorkspacePath|Agent|All)\b/i
    );
    expect(argumentGuard).toBeGreaterThanOrEqual(0);
    expect(dependencyInstall).toBeGreaterThan(argumentGuard);
    expect(setup.slice(argumentGuard, dependencyInstall)).toMatch(
      /Stop-CoreSetup/i
    );
    expect(setup).toMatch(
      /function\s+Stop-CoreSetup[^]*?\bexit\s+1\b/i
    );
  });

  const rejectsArguments = process.platform === "win32" ? it : it.skip;
  rejectsArguments.each([
    "-DefinitelyNotASetupParameter",
    "-Verbose",
    "unexpected-positional-value",
  ])("rejects %s without beginning setup work", (argument) => {
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          resolve(repositoryRoot, "scripts", "setup.ps1"),
          argument,
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          windowsHide: true,
        }
      );
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(output).not.toMatch(
        /Installing dependencies|Building\.\.\.|Verifying config-free|Registering detected/i
      );
    });

  it("does not create overrides, prompt, or run a separate discovery/lifecycle pass", () => {
    const setup = read("scripts/setup.ps1");

    expect(setup).not.toMatch(
      /Copy-Item|Read-Host|reforger-forge\.config|--config|--project-path/i
    );
    expect(setup).not.toMatch(/discover-steam|workbench-lifecycle/i);
    expect(setup).not.toMatch(
      /\b(?:Start-Process|Stop-Process|Stop-Service)\b|ArmaReforger(?:Workbench)?\.exe/i
    );
    expect(setup).not.toContain("agents\\install-agents.ps1");
  });

  rejectsArguments(
    "rejects CheckWorkbench without Doctor before beginning setup work",
    () => {
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          resolve(repositoryRoot, "scripts", "setup.ps1"),
          "-CheckWorkbench",
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          windowsHide: true,
        }
      );
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

      expect(result.status).toBe(1);
      expect(output).toContain(
        "-CheckWorkbench is valid only with -Doctor"
      );
      expect(result.stdout).toContain("Receipt schema: 1");
      expect(result.stdout).toContain("Overall status: failed");
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
      expect(output).not.toMatch(
        /Installing dependencies|Building\.\.\.|Verifying config-free|Registering detected/i
      );
    }
  );

  rejectsArguments(
    "renders an early failure as one complete canonical JSON receipt",
    () => {
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          resolve(repositoryRoot, "scripts", "setup.ps1"),
          "-CheckWorkbench",
          "-Json",
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          windowsHide: true,
        }
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      const receipt = JSON.parse(result.stdout) as {
        schemaVersion: number;
        operation: string;
        overallStatus: string;
        verification: Record<string, unknown>;
        managedChanges?: unknown[];
      };
      expect(receipt).toMatchObject({
        schemaVersion: 1,
        operation: "setup",
        overallStatus: "failed",
      });
      expect(Object.keys(receipt.verification)).toEqual([
        "steamDiscovery",
        "effectiveSettings",
        "serverHandshake",
        "toolRegistration",
        "clientRegistration",
        "workbenchNetApi",
        "observerCapture",
      ]);
      expect(receipt.managedChanges).toEqual([]);
    }
  );

  it("installs, builds, verifies, then registers exactly once in that order", () => {
    const setup = read("scripts/setup.ps1");
    const dependencyInstalls =
      setup.match(/-Arguments\s+@\(\s*"ci"\s*\)/gi) ?? [];
    const builds =
      setup.match(/-Arguments\s+@\(\s*"run"\s*,\s*"build"\s*\)/gi) ?? [];
    const verifications = matchingLines(
      setup,
      /^&\s+\$nodeCommand\.Source\s+\$verificationScriptPath$/i
    );
    const registrations = matchingLines(
      setup,
      /^-Arguments\s+\$registrationArguments\s+`?$/i
    );

    expect(setup).toMatch(
      /\$registrationCliPath\s*=\s*[^]*?register-clients-cli\.js/i
    );
    expect(setup).toContain('"dist\\setup\\client-registration.js"');
    expect(setup).toContain('"dist\\setup\\server-verification.js"');
    expect(setup).toContain('"dist\\setup\\setup-receipt.js"');
    expect(setup).toContain('"dist\\setup\\setup-receipt-cli.js"');
    expect(setup).toMatch(
      /\$isSourceCheckout[^]*?Using the package's prebuilt server/i
    );
    expect(dependencyInstalls).toHaveLength(1);
    expect(builds).toHaveLength(1);
    expect(verifications).toHaveLength(1);
    expect(registrations).toHaveLength(1);

    const verification = verifications[0];
    const registration = registrations[0];
    expect(setup).toMatch(
      /\$registrationArguments\s*=\s*@\([^]*?"--verification-report"[^]*?\$verificationReportPath/i
    );

    const installIndex = setup.indexOf(dependencyInstalls[0]!);
    const buildIndex = setup.indexOf(builds[0]!);
    const verificationIndex = setup.indexOf(verification);
    const registrationIndex = setup.indexOf(registration);

    expect(installIndex).toBeLessThan(buildIndex);
    expect(buildIndex).toBeLessThan(verificationIndex);
    expect(verificationIndex).toBeLessThan(registrationIndex);
    expect(setup.slice(verificationIndex, registrationIndex)).toMatch(
      /if\s*\(\s*\$verificationExitCode\s*-ne\s*0\s*\)[^]*?setupReceiptCliPath[^]*?exit\s+1/i
    );
    expect(setup.slice(registrationIndex)).toMatch(
      /\bexit\s+\$registrationExitCode\b/i
    );

    const registrationSources = [
      read("src/setup/client-registration.ts"),
      read("src/setup/register-clients-cli.ts"),
    ].join("\n");
    expect(registrationSources).not.toMatch(
      /verify-mcp-server|npm(?:\.cmd)?\s+(?:run\s+build|ci|install)/i
    );
  });

  it("removes install-time compilation and retains an explicit packaging build", () => {
    const packageDocument = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    const lockDocument = JSON.parse(read("package-lock.json")) as {
      packages?: Record<
        string,
        { dependencies?: Record<string, string>; dev?: boolean }
      >;
    };
    const packageCheck = read("scripts/check-package.mjs");

    expect(packageDocument.scripts).not.toHaveProperty("prepare");
    expect(packageDocument.scripts?.prepack).toBe("npm run build");
    expect(packageDocument.dependencies?.yaml).toBe("^2.9.0");
    expect(lockDocument.packages?.[""]?.dependencies?.yaml).toBe("^2.9.0");
    expect(lockDocument.packages?.["node_modules/yaml"]?.dev).not.toBe(true);
    expect(packageCheck).toContain("dist/setup/client-registration.js");
    expect(packageCheck).toContain("dist/setup/register-clients-cli.js");
    expect(packageCheck).toContain("dist/setup/server-verification.js");
    expect(packageCheck).toContain("dist/setup/setup-receipt.js");
    expect(packageCheck).toContain("dist/setup/setup-receipt-cli.js");
    expect(packageCheck).toContain("dist/setup/doctor.js");
    expect(packageCheck).toContain("dist/setup/doctor-cli.js");
  });
});
