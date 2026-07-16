import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { AGENT_VERSION } from "../protocol/index.js";
import { ArtifactStore } from "./artifacts.js";
import { requestObserverControl } from "./control-client.js";
import { ObserverControlApi } from "./control-api.js";
import { errorBody } from "./errors.js";
import { JobStore } from "./jobs.js";
import { observerLogger } from "./logger.js";
import { InstanceRegistry } from "./registry.js";
import { ObserverAgentServer } from "./server.js";

function option(argumentsArray: string[], name: string): string | undefined {
  const index = argumentsArray.indexOf(name);
  return index >= 0 ? argumentsArray[index + 1] : undefined;
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
  };
}

function createCliAgent(options: ReturnType<typeof baseOptions> & { port?: number; host?: "127.0.0.1" | "::1"; enableControlHttp?: boolean }) {
  const agentInstanceId = randomUUID();
  const control = new ObserverControlApi({ ...options, agentInstanceId });
  const registry = new InstanceRegistry(control.sessions);
  const jobs = new JobStore(control.sessions, registry);
  const artifacts = new ArtifactStore(control.paths.artifacts, control.sessions, jobs);
  const server = new ObserverAgentServer(agentInstanceId, control, registry, jobs, artifacts, options);
  return { control, registry, jobs, artifacts, server };
}

export async function runCli(argumentsArray: string[]): Promise<void> {
  try {
    const command = argumentsArray[0] ?? "serve";
    if (command === "--version" || command === "version") {
      process.stdout.write(`${AGENT_VERSION}\n`);
      return;
    }
    if (command === "stage") {
      const agent = createCliAgent(baseOptions(argumentsArray));
      print(agent.control.ensureStaged());
      return;
    }
    if (command === "doctor") {
      const agent = createCliAgent(baseOptions(argumentsArray));
      print({ ...agent.control.diagnostics(), instances: agent.registry.diagnostics(), jobs: agent.jobs.diagnostics() });
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
    const agent = createCliAgent({
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
