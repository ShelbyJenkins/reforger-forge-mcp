import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  ClientRegistrationSummary,
} from "../../src/setup/client-registration.js";
import {
  executeRegistrationCli,
} from "../../src/setup/register-clients-cli.js";
import {
  parseServerVerificationReport,
  type ServerVerificationReport,
} from "../../src/setup/server-verification.js";
import {
  executeSetupReceiptCli,
} from "../../src/setup/setup-receipt-cli.js";
import type { SetupReceipt } from "../../src/setup/setup-receipt.js";

const SERVER_PATH = resolve("C:\\package", "dist", "index.js");
const REPORT_PATH = resolve("C:\\package", "verification.json");

function report(
  overrides: Partial<ServerVerificationReport> = {}
): ServerVerificationReport {
  return {
    schemaVersion: 3,
    generatedAt: "2026-07-24T00:00:00.000Z",
    success: true,
    nodeVersion: "v22.0.0",
    nodePath: process.execPath,
    serverPath: SERVER_PATH,
    packageVersion: "1.1.0",
    compiledServer: {
      status: "passed",
      version: "1.1.0",
      issues: [],
    },
    startupArguments: [],
    steamDiscovery: {
      status: "passed",
      sourceStatus: "success",
      workbenchCandidates: ["D:\\Arma Reforger Tools"],
      gameCandidates: ["D:\\Arma Reforger"],
      steamRoots: ["C:\\Steam"],
      libraryRoots: ["D:\\SteamLibrary"],
      diagnostics: [],
      issues: [],
    },
    effectiveSettings: {
      status: "passed",
      workbenchPath: "D:\\Arma Reforger Tools",
      gamePath: "D:\\Arma Reforger",
      workbenchAddonDirs: ["D:\\Arma Reforger\\addons"],
      workbenchHost: "127.0.0.1",
      workbenchPort: 5775,
      mcpIdleShutdownMs: 1_800_000,
      issues: [],
    },
    serverHandshake: { status: "passed", issues: [] },
    toolRegistration: {
      status: "passed",
      count: 1,
      names: ["api_search"],
      issues: [],
    },
    ...overrides,
  };
}

function registration(
  overrides: Partial<ClientRegistrationSummary> = {}
): ClientRegistrationSummary {
  return {
    serverPath: SERVER_PATH,
    receipts: [{
      id: "cursor",
      name: "Cursor",
      status: "updated",
      target: {
        kind: "config_file",
        scope: "user",
        path: "C:\\Users\\tester\\.cursor\\mcp.json",
      },
      detail: "Registered.",
      manual: "Configure Cursor manually.",
      modifiedFiles: ["C:\\Users\\tester\\.cursor\\mcp.json"],
      backupFiles: ["C:\\Users\\tester\\.cursor\\mcp.json.bak"],
      nextActions: [
        "Restart Cursor and confirm the 'reforger-forge' tools are available.",
      ],
    }],
    hasFailures: false,
    ...overrides,
  };
}

describe("serialized verification report gate", () => {
  it("accepts a complete internally consistent report", () => {
    expect(parseServerVerificationReport(report())).toEqual(report());
  });

  it("rejects schema drift and a forged success bit", () => {
    expect(() => parseServerVerificationReport({
      ...report(),
      schemaVersion: 1,
    })).toThrow("Unsupported verification report schema");

    expect(() => parseServerVerificationReport({
      ...report(),
      success: true,
      serverHandshake: {
        status: "failed",
        issues: ["Handshake failed."],
      },
    })).toThrow("success does not agree");
  });

  it("requires the exact absolute Node executable in verifier evidence", () => {
    const complete = report();
    const { nodePath: _missing, ...withoutNodePath } = complete;
    expect(() => parseServerVerificationReport(withoutNodePath))
      .toThrow("nodePath must be a string");
    expect(() => parseServerVerificationReport({
      ...complete,
      nodePath: "node",
    })).toThrow("nodePath must be absolute");
  });

  it("requires a bounded idle timeout whenever effective settings passed", () => {
    const complete = report();
    const { mcpIdleShutdownMs: _missing, ...withoutIdleTimeout } =
      complete.effectiveSettings;
    expect(() => parseServerVerificationReport({
      ...complete,
      effectiveSettings: withoutIdleTimeout,
    })).toThrow("effectiveSettings.mcpIdleShutdownMs is invalid");

    for (const mcpIdleShutdownMs of [59_999, 60_000.5, 86_400_001]) {
      expect(() => parseServerVerificationReport({
        ...complete,
        effectiveSettings: {
          ...complete.effectiveSettings,
          mcpIdleShutdownMs,
        },
      })).toThrow("effectiveSettings.mcpIdleShutdownMs is invalid");
    }
  });

  it("rejects a successful report that does not prove the package version", () => {
    expect(() => parseServerVerificationReport({
      ...report(),
      compiledServer: {
        status: "passed",
        version: "9.9.9",
        issues: [],
      },
    })).toThrow("expected compiled server version");
  });

  it("rejects inconsistent or duplicate registered-tool evidence", () => {
    expect(() => parseServerVerificationReport({
      ...report(),
      toolRegistration: {
        ...report().toolRegistration,
        count: 2,
      },
    })).toThrow("count does not agree");

    expect(() => parseServerVerificationReport({
      ...report(),
      toolRegistration: {
        status: "passed",
        count: 2,
        names: ["api_search", "api_search"],
        issues: [],
      },
    })).toThrow("must not contain duplicates");
  });
});

describe("setup completion registrar", () => {
  it("registers only after the exact successful report and emits one JSON receipt", async () => {
    const register = vi.fn(() => registration());
    const stdout: string[] = [];

    const exitCode = await executeRegistrationCli([
      "--server",
      SERVER_PATH,
      "--verification-report",
      REPORT_PATH,
      "--json",
    ], {
      readReport: vi.fn(async () => report()),
      register,
      serverExists: () => true,
      writeStdout: (text) => stdout.push(text),
    });

    expect(exitCode).toBe(0);
    expect(register).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledWith({
      serverPath: SERVER_PATH,
      nodePath: process.execPath,
    });
    expect(stdout).toHaveLength(1);
    const receipt = JSON.parse(stdout[0]!) as SetupReceipt;
    expect(receipt.overallStatus).toBe("passed");
    expect(receipt.runtime.serverPresent).toBe(true);
    expect(receipt.runtime.nodePath).toBe(process.execPath);
    expect(receipt.verification.workbenchNetApi.status).toBe("not_tested");
    expect(receipt.verification.observerCapture.status).toBe("not_tested");
    expect(receipt.modifiedFiles).toEqual([
      "C:\\Users\\tester\\.cursor\\mcp.json",
    ]);
    expect(receipt.backups).toEqual([
      "C:\\Users\\tester\\.cursor\\mcp.json.bak",
    ]);
  });

  it.each([
    {
      name: "failed report",
      verificationReport: report({
        success: false,
        serverHandshake: {
          status: "failed",
          issues: ["Handshake failed."],
        },
        toolRegistration: {
          status: "not_run",
          count: 0,
          names: [],
          issues: [],
        },
      }),
      serverPath: SERVER_PATH,
    },
    {
      name: "wrong server",
      verificationReport: report(),
      serverPath: resolve("C:\\other", "dist", "index.js"),
    },
    {
      name: "wrong Node executable",
      verificationReport: report({
        nodePath: resolve("C:\\other", "node.exe"),
      }),
      serverPath: SERVER_PATH,
    },
    {
      name: "unrepresented startup arguments",
      verificationReport: report({
        startupArguments: ["--config", "custom.json"],
      }),
      serverPath: SERVER_PATH,
    },
  ])("does not mutate clients for a $name", async ({
    verificationReport,
    serverPath,
  }) => {
    const register = vi.fn(() => registration());
    const stdout: string[] = [];

    const exitCode = await executeRegistrationCli([
      "--server",
      serverPath,
      "--verification-report",
      REPORT_PATH,
      "--json",
    ], {
      readReport: vi.fn(async () => verificationReport),
      register,
      writeStdout: (text) => stdout.push(text),
    });

    expect(exitCode).toBe(1);
    expect(register).not.toHaveBeenCalled();
    const receipt = JSON.parse(stdout.join("")) as SetupReceipt;
    expect(receipt.overallStatus).toBe("failed");
    expect(receipt.failure?.layer).toBe("verification");
    expect(receipt.verification.clientRegistration.status).toBe("not_run");
  });

  it("returns attention for registration problems without retracting server proof", async () => {
    const stdout: string[] = [];
    const failedRegistration = registration({
      receipts: [{
        ...registration().receipts[0]!,
        status: "failed",
        detail: "Client update failed.",
        modifiedFiles: [],
        backupFiles: [],
      }],
      hasFailures: true,
    });

    const exitCode = await executeRegistrationCli([
      "--server",
      SERVER_PATH,
      "--verification-report",
      REPORT_PATH,
      "--json",
    ], {
      readReport: vi.fn(async () => report()),
      register: vi.fn(() => failedRegistration),
      serverExists: () => true,
      writeStdout: (text) => stdout.push(text),
    });

    const receipt = JSON.parse(stdout.join("")) as SetupReceipt;
    expect(exitCode).toBe(2);
    expect(receipt.overallStatus).toBe("attention_required");
    expect(receipt.verification.serverHandshake.status).toBe("passed");
    expect(receipt.verification.clientRegistration.status).toBe(
      "attention_required"
    );
  });

  it("fails without mutation if the verified server disappears before registration", async () => {
    const register = vi.fn(() => registration());
    const stdout: string[] = [];

    const exitCode = await executeRegistrationCli([
      "--server",
      SERVER_PATH,
      "--verification-report",
      REPORT_PATH,
      "--json",
    ], {
      readReport: vi.fn(async () => report()),
      register,
      serverExists: () => false,
      writeStdout: (text) => stdout.push(text),
    });

    expect(exitCode).toBe(1);
    expect(register).not.toHaveBeenCalled();
    const receipt = JSON.parse(stdout.join("")) as SetupReceipt;
    expect(receipt.runtime.serverPresent).toBe(false);
    expect(receipt.failure?.layer).toBe("verification");
  });
});

describe("failed verification receipt CLI", () => {
  it("preserves passed earlier layers and identifies the failed layer", async () => {
    const stdout: string[] = [];
    const failedReport = report({
      success: false,
      serverHandshake: {
        status: "failed",
        issues: ["Handshake failed."],
      },
      toolRegistration: {
        status: "not_run",
        count: 0,
        names: [],
        issues: [],
      },
    });

    const exitCode = await executeSetupReceiptCli([
      "--server",
      SERVER_PATH,
      "--verification-report",
      REPORT_PATH,
      "--json",
    ], {
      readReport: vi.fn(async () => failedReport),
      serverExists: () => true,
      writeStdout: (text) => stdout.push(text),
    });

    expect(exitCode).toBe(1);
    expect(stdout).toHaveLength(1);
    const receipt = JSON.parse(stdout[0]!) as SetupReceipt;
    expect(receipt.verification.steamDiscovery.status).toBe("passed");
    expect(receipt.verification.effectiveSettings.status).toBe("passed");
    expect(receipt.verification.serverHandshake.status).toBe("failed");
    expect(receipt.verification.toolRegistration.status).toBe("not_run");
    expect(receipt.verification.clientRegistration.status).toBe("not_run");
    expect(receipt.failure).toEqual({
      layer: "verification",
      message: "MCP server verification did not pass every required level.",
    });
  });

  it("still writes JSON when argument parsing fails after --json was requested", async () => {
    const stdout: string[] = [];

    const exitCode = await executeSetupReceiptCli(["--json"], {
      writeStdout: (text) => stdout.push(text),
    });

    expect(exitCode).toBe(1);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!).overallStatus).toBe("failed");
  });
});
