import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { AGENT_VERSION } from "../protocol/index.js";
import { ArtifactStore } from "./artifacts.js";
import { ObserverControlApi, type ObserverControlOptions } from "./control-api.js";
import { JobStore } from "./jobs.js";
import { InstanceRegistry, type RegistryOptions } from "./registry.js";
import { ObserverRunStore, type RunStoreOptions } from "./runs.js";
import { ObserverAgentServer, type ObserverAgentServerOptions } from "./server.js";

export interface CreateObserverAgentOptions extends ObserverControlOptions, ObserverAgentServerOptions, RunStoreOptions {
  registry?: RegistryOptions;
}

export function createObserverAgent(options: CreateObserverAgentOptions = {}) {
  const agentInstanceId = randomUUID();
  const control = new ObserverControlApi({ ...options, agentInstanceId });
  const registry = new InstanceRegistry(control.sessions, options.registry);
  const jobs = new JobStore(control.sessions, registry, options.clock);
  const artifacts = new ArtifactStore(control.paths.artifacts, control.sessions, jobs);
  const runs = new ObserverRunStore(control.paths.runs, control.paths.exportWork, artifacts, jobs, {
    evidenceRoots: options.evidenceRoots,
    supportingLogRoots: [control.paths.logs, ...(options.supportingLogRoots ?? [])],
  });
  const server = new ObserverAgentServer(agentInstanceId, control, registry, jobs, artifacts, runs, options);
  return { control, registry, jobs, artifacts, runs, server };
}

export { AGENT_VERSION };
export * from "./artifacts.js";
export * from "./bmp.js";
export * from "./control-api.js";
export * from "./control-client.js";
export * from "./errors.js";
export * from "./jobs.js";
export * from "./launch-arguments.js";
export * from "./mailbox.js";
export * from "./mailbox-coordinator.js";
export * from "./paths.js";
export * from "./registry.js";
export * from "./runs.js";
export * from "./server.js";
export * from "./sessions.js";
export * from "./staging.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { runCli } = await import("./cli.js");
  await runCli(process.argv.slice(2));
}
