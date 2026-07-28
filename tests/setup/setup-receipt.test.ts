import { describe, expect, it } from "vitest";
import type {
  ClientRegistrationReceipt,
  ClientRegistrationSummary,
} from "../../src/setup/client-registration.js";
import {
  composeSetupReceipt,
  createSetupFailureReceipt,
  formatSetupReceipt,
  serializeSetupReceipt,
  type ComposeSetupReceiptOptions,
  type SetupReceipt,
} from "../../src/setup/setup-receipt.js";

function options(
  overrides: Partial<ComposeSetupReceiptOptions> = {}
): ComposeSetupReceiptOptions {
  return {
    operation: "doctor",
    runtime: {
      serverPath: "C:\\package\\dist\\index.js",
      serverPresent: true,
      nodePath: "C:\\node\\node.exe",
      nodeVersion: "v22.0.0",
      serverVersion: "1.1.0",
      transport: "stdio",
    },
    settings: {
      configPath: null,
      gamePath: "D:\\Arma Reforger",
      workbenchPath: "D:\\Arma Reforger Tools",
      workbenchAddonDirs: ["D:\\Arma Reforger\\addons"],
      startupArguments: [],
      steamCandidates: {
        game: ["D:\\Arma Reforger"],
        workbench: ["D:\\Arma Reforger Tools"],
      },
    },
    verification: {
      steamDiscovery: { status: "passed", issues: [] },
      effectiveSettings: { status: "passed", issues: [] },
      serverHandshake: { status: "passed", issues: [] },
      toolRegistration: {
        status: "passed",
        detail: "55 tools agree with the documented surface.",
        issues: [],
      },
      workbenchNetApi: {
        status: "not_tested",
        detail: "Live connectivity was not requested.",
        issues: [],
      },
      observerCapture: {
        status: "not_tested",
        detail: "Doctor never performs observer capture.",
        issues: [],
      },
    },
    ...overrides,
  };
}

function client(
  overrides: Record<string, unknown> = {}
): ClientRegistrationReceipt {
  return {
    id: "codex",
    name: "Codex",
    status: "already_current",
    manual: "Configure Codex manually.",
    ...overrides,
  } as unknown as ClientRegistrationReceipt;
}

describe("canonical setup receipt", () => {
  it("defaults live Workbench and observer checks to not tested", () => {
    const receipt = composeSetupReceipt(options());

    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.operation).toBe("doctor");
    expect(receipt.overallStatus).toBe("passed");
    expect(receipt.verification.workbenchNetApi.status).toBe("not_tested");
    expect(receipt.verification.observerCapture.status).toBe("not_tested");
    expect(receipt.settings.configPath).toBeNull();
  });

  it("aggregates exact files, backups, CLI-managed changes, and next actions", () => {
    const registration = {
      serverPath: "C:\\package\\dist\\index.js",
      receipts: [
        client({
          status: "updated",
          modifiedFiles: ["C:\\client\\config.json"],
          backupFiles: ["C:\\client\\config.json.bak"],
          managedChanges: [{
            clientId: "codex",
            clientName: "Codex",
            kind: "client_cli",
            command: "C:\\bin\\codex.exe",
            scope: "user",
            configFile: null,
            configFileVerification: "unverified",
            detail:
              "Updated the 'reforger-forge' user registration through the client CLI. The exact client-owned configuration file was not verified.",
          }],
          nextActions: ["Restart Codex."],
        }),
      ],
      hasFailures: false,
    } as ClientRegistrationSummary;

    const receipt = composeSetupReceipt(options({
      operation: "setup",
      registration,
      modifiedFiles: ["C:\\setup\\receipt.json"],
      backups: ["C:\\client\\config.json.bak"],
      nextActions: ["Restart Codex."],
    }));

    expect(receipt.modifiedFiles).toEqual([
      "C:\\setup\\receipt.json",
      "C:\\client\\config.json",
    ]);
    expect(receipt.backups).toEqual(["C:\\client\\config.json.bak"]);
    expect(receipt.managedChanges).toEqual([
      expect.objectContaining({
        clientId: "codex",
        command: "C:\\bin\\codex.exe",
        configFile: null,
        configFileVerification: "unverified",
      }),
    ]);
    expect(receipt.nextActions).toEqual(["Restart Codex."]);
    expect(receipt.verification.clientRegistration.status).toBe("passed");
  });

  it("treats client drift as attention without overstating server failure", () => {
    const receipt = composeSetupReceipt(options({
      clients: [
        client({
          status: "different",
          detail: "The configured command differs.",
        }),
      ],
    }));

    expect(receipt.overallStatus).toBe("attention_required");
    expect(receipt.verification.serverHandshake.status).toBe("passed");
    expect(receipt.verification.clientRegistration).toMatchObject({
      status: "attention_required",
    });
  });

  it("marks a failed verification layer as an overall failure", () => {
    const base = options();
    const receipt = composeSetupReceipt({
      ...base,
      verification: {
        ...base.verification,
        serverHandshake: {
          status: "failed",
          issues: ["The MCP handshake timed out."],
        },
      },
    });

    expect(receipt.overallStatus).toBe("failed");
    expect(receipt.verification.steamDiscovery.status).toBe("passed");
    expect(receipt.verification.serverHandshake.status).toBe("failed");
  });

  it("renders human and JSON output from the same complete object", () => {
    const receipt = composeSetupReceipt(options({
      skipped: ["Cursor: not detected"],
      ambiguous: ["Steam game candidates: D:\\one, E:\\two"],
      nextActions: ["Resolve the Steam installation selection."],
    }));

    const parsed = JSON.parse(serializeSetupReceipt(receipt)) as SetupReceipt;
    expect(parsed).toEqual(receipt);

    const human = formatSetupReceipt(receipt);
    expect(human).toContain("Receipt schema: 1");
    expect(human).toContain("Operation:      doctor");
    expect(human).toContain("Workbench NET API:  not tested");
    expect(human).toContain("Observer capture:   not tested");
    expect(human).toContain("Cursor: not detected");
    expect(human).toContain("Resolve the Steam installation selection.");
  });

  it("does not imply that no state changed after a CLI-managed update", () => {
    const managedChange = {
      clientId: "claude-code" as const,
      clientName: "Claude Code",
      kind: "client_cli" as const,
      command: "C:\\bin\\claude.exe",
      scope: "user" as const,
      configFile: null,
      configFileVerification: "unverified" as const,
      detail:
        "Updated the 'reforger-forge' user registration through the client CLI. The exact client-owned configuration file was not verified.",
    };
    const receipt = composeSetupReceipt(options({
      operation: "setup",
      clients: [
        client({
          id: "claude-code",
          name: "Claude Code",
          status: "updated",
          target: {
            kind: "client_cli",
            scope: "user",
            command: managedChange.command,
          },
          modifiedFiles: [],
          backupFiles: [],
          managedChanges: [managedChange],
          nextActions: [],
        }),
      ],
    }));

    expect(receipt.modifiedFiles).toEqual([]);
    expect(receipt.managedChanges).toEqual([managedChange]);
    expect(JSON.parse(serializeSetupReceipt(receipt))).toMatchObject({
      modifiedFiles: [],
      managedChanges: [managedChange],
    });

    const human = formatSetupReceipt(receipt);
    expect(human).toContain(
      "none directly verified; client-CLI changes are listed separately"
    );
    expect(human).toContain("CLI-managed changes:");
    expect(human).toContain("Claude Code:");
    expect(human).toContain("exact config file: unverified");
  });

  it("does not describe unresolved settings as discovered defaults", () => {
    const receipt = createSetupFailureReceipt({
      operation: "setup",
      serverPath: "C:\\package\\dist\\index.js",
      serverPresent: false,
      nodePath: "node",
      nodeVersion: "v22.0.0",
      layer: "build",
      message: "Compiled output is missing.",
    });

    const human = formatSetupReceipt(receipt);
    expect(human).toContain("Failed layer:   build");
    expect(human).toContain("Config:         not resolved");
    expect(human).not.toContain("automatic discovery and internal defaults");
    expect(human).not.toContain("project-independent mode");
  });
});
