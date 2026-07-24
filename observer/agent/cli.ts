import { readFileSync } from "node:fs";
import { AGENT_VERSION } from "../protocol/index.js";
import { requestObserverControl } from "./control-client.js";
import { errorBody } from "./errors.js";
import { observerLogger, setObserverDebugEnabled } from "./logger.js";
import { inspectPaths } from "./paths.js";
import { createObserverApplication } from "./application.js";

function option(argumentsArray: string[], name: string): string | undefined {
  const index = argumentsArray.indexOf(name);
  return index >= 0 ? argumentsArray[index + 1] : undefined;
}

function optionValues(argumentsArray: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argumentsArray.length; index += 1) {
    if (argumentsArray[index] === name && argumentsArray[index + 1] !== undefined) values.push(argumentsArray[index + 1]);
  }
  return values;
}

function numberOption(argumentsArray: string[], name: string): number | undefined {
  const value = option(argumentsArray, name);
  return value === undefined ? undefined : Number(value);
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function baseOptions(argumentsArray: string[]) {
  return {
    root: option(argumentsArray, "--root"),
    profileRoot: option(argumentsArray, "--profile-root"),
    sourceDirectory: option(argumentsArray, "--source-addon"),
    evidenceRoots: optionValues(argumentsArray, "--evidence-root"),
    supportingLogRoots: optionValues(argumentsArray, "--supporting-log-root"),
    retentionIntervalMs: numberOption(argumentsArray, "--retention-interval-ms"),
    retentionMaxAgeMs: numberOption(argumentsArray, "--retention-max-age-ms"),
    retentionMaxBytes: numberOption(argumentsArray, "--retention-max-bytes"),
    sweepIntervalMs: numberOption(argumentsArray, "--sweep-interval-ms"),
    sessionStore: {
      terminalRetentionMs: numberOption(argumentsArray, "--session-terminal-retention-ms"),
    },
  };
}

function createCliApplication(options: ReturnType<typeof baseOptions> & { port?: number; host?: "127.0.0.1" | "::1"; enableControlHttp?: boolean }) {
  return createObserverApplication(options);
}

export async function runCli(argumentsArray: string[]): Promise<void> {
  try {
    setObserverDebugEnabled(argumentsArray.includes("--debug"));
    const command = argumentsArray[0] ?? "serve";
    if (command === "--version" || command === "version") {
      process.stdout.write(`${AGENT_VERSION}\n`);
      return;
    }
    if (command === "stage") {
      const agent = createCliApplication(baseOptions(argumentsArray));
      print(agent.control.ensureStaged());
      return;
    }
    if (command === "doctor") {
      const options = baseOptions(argumentsArray);
      const inspection = inspectPaths(options.root, options.profileRoot);
      print({
        readOnly: true,
        mutationPerformed: false,
        diagnostic: "doctor",
        observerRoot: inspection.paths.root,
        profileRoot: inspection.paths.profiles,
        managedStorage: inspection.entries,
        stateLoaded: false,
        sessions: [],
        instances: [],
        jobs: [],
        promises: {
          launchesProcesses: false,
          signalsProcesses: false,
          mutatesWorkbenchHandlers: false,
        },
      });
      return;
    }
    if (command === "prepare-launch") {
      const descriptorPath = option(argumentsArray, "--agent-descriptor");
      if (!descriptorPath || descriptorPath === "-") {
        throw new Error("prepare-launch requires --agent-descriptor <file> for an already-running authenticated agent");
      }
      const requestPath = option(argumentsArray, "--request");
      const content = requestPath && requestPath !== "-" ? readFileSync(requestPath, "utf8") : await stdinText();
      const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
      const result = await requestObserverControl(descriptor, "/v1/control/prepare-launch", {
        method: "POST",
        body: JSON.parse(content),
      });
      print(result);
      return;
    }
    if (command !== "serve") throw new Error(`Unknown observer agent command: ${command}`);
    const portValue = option(argumentsArray, "--port");
    const agent = createCliApplication({
      ...baseOptions(argumentsArray),
      port: portValue === undefined ? 0 : Number(portValue),
      host: argumentsArray.includes("--ipv6") ? "::1" : "127.0.0.1",
      enableControlHttp: argumentsArray.includes("--control-http"),
    });
    const descriptor = await agent.server.start();
    print(descriptor);
    observerLogger.info("agent listening", { host: descriptor.host, port: descriptor.port, controlHttpEnabled: descriptor.controlHttpEnabled });
    const close = async () => {
      await agent.server.close();
      process.exitCode = 0;
    };
    process.once("SIGINT", () => void close());
    process.once("SIGTERM", () => void close());
    if (argumentsArray.includes("--exit-on-stdin-close")) process.stdin.once("end", () => void close());
  } catch (error) {
    observerLogger.error("command failed", errorBody(error));
    process.exitCode = 1;
  }
}
