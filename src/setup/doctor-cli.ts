#!/usr/bin/env node

import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDoctor, type DoctorOptions } from "./doctor.js";
import {
  formatSetupReceipt,
  serializeSetupReceipt,
  type SetupReceipt,
} from "./setup-receipt.js";

export interface ParsedDoctorArguments {
  readonly serverPath: string;
  readonly checkWorkbench: boolean;
  readonly json: boolean;
  readonly startupArguments: readonly string[];
}

export interface DoctorCliDependencies {
  readonly run?: (options: DoctorOptions) => Promise<SetupReceipt>;
  readonly writeStdout?: (text: string) => void;
  readonly writeStderr?: (text: string) => void;
}

export function doctorUsage(): string {
  return [
    "Usage:",
    "  node dist/setup/doctor-cli.js --server <absolute-dist-index.js> [--check-workbench] [--json] [-- <server configuration arguments>]",
    "",
    "Doctor is read-only. --check-workbench performs exactly one EMCP_WB_Ping",
    "and never launches or terminates Workbench or the game.",
  ].join("\n");
}

export function parseDoctorArguments(
  argv: readonly string[]
): ParsedDoctorArguments {
  const separator = argv.indexOf("--");
  const doctorArguments =
    separator === -1 ? argv : argv.slice(0, separator);
  const startupArguments =
    separator === -1 ? [] : argv.slice(separator + 1);
  let serverPath: string | undefined;
  let checkWorkbench = false;
  let json = false;

  for (let index = 0; index < doctorArguments.length; index += 1) {
    const argument = doctorArguments[index];
    switch (argument) {
      case "--server": {
        if (serverPath !== undefined) {
          throw new Error(`--server may be supplied only once.\n${doctorUsage()}`);
        }
        const value = doctorArguments[++index];
        if (value === undefined || value.startsWith("--")) {
          throw new Error(`--server requires one path.\n${doctorUsage()}`);
        }
        if (!isAbsolute(value)) {
          throw new Error(
            `--server must be an absolute path.\n${doctorUsage()}`
          );
        }
        serverPath = resolve(value);
        break;
      }
      case "--check-workbench":
        if (checkWorkbench) {
          throw new Error(
            `--check-workbench may be supplied only once.\n${doctorUsage()}`
          );
        }
        checkWorkbench = true;
        break;
      case "--json":
        if (json) {
          throw new Error(`--json may be supplied only once.\n${doctorUsage()}`);
        }
        json = true;
        break;
      case "-h":
      case "--help":
        throw new Error(doctorUsage());
      default:
        throw new Error(
          `Unknown doctor argument: ${argument}\n${doctorUsage()}`
        );
    }
  }

  if (serverPath === undefined) {
    throw new Error(`--server is required.\n${doctorUsage()}`);
  }
  return {
    serverPath,
    checkWorkbench,
    json,
    startupArguments,
  };
}

export async function executeDoctorCli(
  argv: readonly string[],
  dependencies: DoctorCliDependencies = {}
): Promise<number> {
  const writeStdout =
    dependencies.writeStdout ?? ((text: string) => process.stdout.write(text));
  const writeStderr =
    dependencies.writeStderr ?? ((text: string) => process.stderr.write(text));
  let parsed: ParsedDoctorArguments;
  try {
    parsed = parseDoctorArguments(argv);
  } catch (error) {
    writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  try {
    const receipt = await (dependencies.run ?? runDoctor)({
      serverPath: parsed.serverPath,
      checkWorkbench: parsed.checkWorkbench,
      startupArguments: parsed.startupArguments,
    });
    const rendered = parsed.json
      ? serializeSetupReceipt(receipt)
      : formatSetupReceipt(receipt);
    // One write and one document: diagnostics never mix operational logging
    // into structured stdout.
    writeStdout(`${rendered}\n`);
    switch (receipt.overallStatus) {
      case "passed":
        return 0;
      case "attention_required":
        return 2;
      case "failed":
        return 1;
    }
  } catch (error) {
    writeStderr(
      `Doctor could not start: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
    return 1;
  }
}

function isDirectExecution(): boolean {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined &&
    resolve(entryPoint) === resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
  process.exitCode = await executeDoctorCli(process.argv.slice(2));
}
