import { describe, expect, it, vi } from "vitest";
import type {
  ClientInspectionReceipt,
  ClientInspectionSummary,
} from "../../src/setup/client-registration.js";
import {
  executeDoctorCli,
  parseDoctorArguments,
} from "../../src/setup/doctor-cli.js";
import {
  runDoctor,
  type DoctorDependencies,
} from "../../src/setup/doctor.js";
import type {
  ServerVerificationReport,
} from "../../src/setup/server-verification.js";
import type { SetupReceipt } from "../../src/setup/setup-receipt.js";
import type {
  WorkbenchNetApiPort,
} from "../../src/workbench/net-api-client.js";

const SERVER_PATH = "C:\\package\\dist\\index.js";
const PACKAGE_ROOT = "C:\\package";

function verificationReport(
  overrides: Partial<ServerVerificationReport> = {}
): ServerVerificationReport {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-24T00:00:00.000Z",
    success: true,
    nodeVersion: "v22.0.0",
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
      issues: [],
    },
    serverHandshake: { status: "passed", issues: [] },
    toolRegistration: {
      status: "passed",
      count: 55,
      names: ["api_search"],
      issues: [],
    },
    ...overrides,
  };
}

function inspectionReceipt(
  overrides: Partial<ClientInspectionReceipt> = {}
): ClientInspectionReceipt {
  return {
    id: "codex",
    name: "Codex",
    status: "current",
    target: {
      kind: "config_file",
      scope: "user",
      path: "C:\\Users\\tester\\.codex\\config.toml",
    },
    manual: "Configure Codex manually.",
    modifiedFiles: [],
    backupFiles: [],
    nextActions: [],
    ...overrides,
  };
}

function inspectionSummary(
  receipts: readonly ClientInspectionReceipt[] = [inspectionReceipt()]
): ClientInspectionSummary {
  return {
    serverPath: SERVER_PATH,
    receipts,
    hasFailures: receipts.some((receipt) => receipt.status !== "current"),
  };
}

function dependencies(
  overrides: Partial<DoctorDependencies> = {}
): DoctorDependencies {
  return {
    verifyServer: vi.fn(async () => verificationReport()),
    inspectClients: vi.fn(() => inspectionSummary()),
    readPackageVersion: vi.fn(() => "1.1.0"),
    nodePath: "C:\\node\\node.exe",
    nodeVersion: "v22.0.0",
    ...overrides,
  };
}

describe("doctor core", () => {
  it("runs server verification and read-only client inspection without a live check", async () => {
    const createWorkbenchClient = vi.fn();
    const deps = dependencies({ createWorkbenchClient });

    const receipt = await runDoctor({
      serverPath: SERVER_PATH,
      packageRoot: PACKAGE_ROOT,
    }, deps);

    expect(deps.verifyServer).toHaveBeenCalledWith({
      packageRoot: PACKAGE_ROOT,
      packageVersion: "1.1.0",
      serverPath: SERVER_PATH,
      startupArguments: [],
      nodeVersion: "v22.0.0",
    });
    expect(deps.inspectClients).toHaveBeenCalledTimes(1);
    expect(createWorkbenchClient).not.toHaveBeenCalled();
    expect(receipt.verification.workbenchNetApi.status).toBe("not_tested");
    expect(receipt.verification.observerCapture.status).toBe("not_tested");
    expect(receipt.modifiedFiles).toEqual([]);
    expect(receipt.backups).toEqual([]);
  });

  it("does not miscompare standard client entries to custom startup arguments", async () => {
    const deps = dependencies();

    const receipt = await runDoctor({
      serverPath: SERVER_PATH,
      packageRoot: PACKAGE_ROOT,
      startupArguments: ["--project-path", "C:\\addons"],
    }, deps);

    expect(deps.inspectClients).not.toHaveBeenCalled();
    expect(receipt.verification.clientRegistration).toMatchObject({
      status: "not_tested",
      detail:
        "Standard config-free client registration was not compared against custom startup arguments.",
    });
    expect(receipt.nextActions.join(" ")).toContain(
      "custom server arguments"
    );
  });

  it("performs exactly one direct read-only Workbench ping when requested", async () => {
    const call = vi.fn();
    const workbenchClient: WorkbenchNetApiPort = {
      call: async <T>(
        apiFunc: string,
        params?: Record<string, unknown>,
        options?: { timeoutMs?: number; responseCapBytes?: number }
      ): Promise<T> => {
        call(apiFunc, params, options);
        return { mode: "edit" } as T;
      },
    };
    const createWorkbenchClient = vi.fn(() => workbenchClient);

    const receipt = await runDoctor({
      serverPath: SERVER_PATH,
      packageRoot: PACKAGE_ROOT,
      checkWorkbench: true,
    }, dependencies({ createWorkbenchClient }));

    expect(createWorkbenchClient).toHaveBeenCalledOnce();
    expect(createWorkbenchClient).toHaveBeenCalledWith("127.0.0.1", 5775);
    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith(
      "EMCP_WB_Ping",
      {},
      { timeoutMs: 5_000 }
    );
    expect(receipt.verification.workbenchNetApi.status).toBe("passed");
  });

  it("does not attempt a ping when effective settings are unavailable", async () => {
    const report = verificationReport({
      success: false,
      effectiveSettings: {
        status: "failed",
        issues: ["Invalid settings."],
      },
      serverHandshake: { status: "not_run", issues: [] },
      toolRegistration: {
        status: "not_run",
        count: 0,
        names: [],
        issues: [],
      },
    });
    const createWorkbenchClient = vi.fn();

    const receipt = await runDoctor({
      serverPath: SERVER_PATH,
      packageRoot: PACKAGE_ROOT,
      checkWorkbench: true,
    }, dependencies({
      verifyServer: vi.fn(async () => report),
      createWorkbenchClient,
    }));

    expect(createWorkbenchClient).not.toHaveBeenCalled();
    expect(receipt.verification.effectiveSettings.status).toBe("failed");
    expect(receipt.verification.workbenchNetApi.status).toBe("failed");
    expect(receipt.overallStatus).toBe("failed");
  });

  it("preserves client inspection success when server verification throws", async () => {
    const receipt = await runDoctor({
      serverPath: SERVER_PATH,
      packageRoot: PACKAGE_ROOT,
    }, dependencies({
      verifyServer: vi.fn(async () => {
        throw new Error("verifier exploded");
      }),
    }));

    expect(receipt.verification.serverHandshake).toMatchObject({
      status: "failed",
      issues: ["Server verification could not run: verifier exploded"],
    });
    expect(receipt.verification.clientRegistration.status).toBe("passed");
    expect(receipt.clients[0]?.status).toBe("current");
    expect(receipt.overallStatus).toBe("failed");
  });

  it("preserves successful verification when client inspection fails", async () => {
    const receipt = await runDoctor({
      serverPath: SERVER_PATH,
      packageRoot: PACKAGE_ROOT,
    }, dependencies({
      inspectClients: vi.fn(() => {
        throw new Error("unreadable client settings");
      }),
    }));

    expect(receipt.verification.serverHandshake.status).toBe("passed");
    expect(receipt.verification.toolRegistration.status).toBe("passed");
    expect(receipt.verification.clientRegistration).toMatchObject({
      status: "attention_required",
      issues: ["unreadable client settings"],
    });
    expect(receipt.nextActions.join(" ")).toContain(
      "client inspection error"
    );
    expect(receipt.overallStatus).toBe("attention_required");
  });
});

describe("doctor CLI", () => {
  it("requires doctor flags before -- and preserves ordered server arguments after it", () => {
    expect(parseDoctorArguments([
      "--server",
      SERVER_PATH,
      "--json",
      "--",
      "--config",
      "custom.json",
      "--project-path",
      "C:\\addons",
    ])).toEqual({
      serverPath: SERVER_PATH,
      checkWorkbench: false,
      json: true,
      startupArguments: [
        "--config",
        "custom.json",
        "--project-path",
        "C:\\addons",
      ],
    });
  });

  it("writes JSON stdout as exactly one parseable receipt document", async () => {
    const receipt = await runDoctor({
      serverPath: SERVER_PATH,
      packageRoot: PACKAGE_ROOT,
    }, dependencies());
    const stdout: string[] = [];
    const stderr: string[] = [];
    const run = vi.fn(async () => receipt);

    const exitCode = await executeDoctorCli([
      "--server",
      SERVER_PATH,
      "--json",
      "--",
      "--config",
      "custom.json",
    ], {
      run,
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
    });

    expect(exitCode).toBe(0);
    expect(run).toHaveBeenCalledWith({
      serverPath: SERVER_PATH,
      checkWorkbench: false,
      startupArguments: ["--config", "custom.json"],
    });
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toEqual(receipt);
    expect(stderr).toEqual([]);
  });

  it("keeps parser and operational errors off JSON stdout", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await executeDoctorCli(["--json"], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("--server is required");
  });

  it("returns the dedicated attention exit code without changing the receipt", async () => {
    const receipt = {
      ...(await runDoctor({
        serverPath: SERVER_PATH,
        packageRoot: PACKAGE_ROOT,
      }, dependencies())),
      overallStatus: "attention_required",
    } satisfies SetupReceipt;
    const stdout: string[] = [];

    const exitCode = await executeDoctorCli([
      "--server",
      SERVER_PATH,
    ], {
      run: vi.fn(async () => receipt),
      writeStdout: (text) => stdout.push(text),
    });

    expect(exitCode).toBe(2);
    expect(stdout.join("")).toContain(
      "ReforgerForge doctor requires attention"
    );
  });
});
