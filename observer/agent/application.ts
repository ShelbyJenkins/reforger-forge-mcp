import { randomUUID } from "node:crypto";
import { ArtifactStore } from "./artifacts.js";
import { ObserverControlApi, type ObserverControlOptions } from "./control-api.js";
import { JobStore, type JobStoreOptions } from "./jobs.js";
import { InstanceRegistry, type RegistryOptions } from "./registry.js";
import { ObserverRunStore } from "./runs.js";
import { ObserverAgentServer, type ObserverAgentServerOptions } from "./server.js";
import { ObserverApplicationOperations } from "./application-operations.js";
import { FileEvidenceBundleService, type EvidenceBundleService } from "./evidence-bundle-service.js";
import { ObserverError } from "./errors.js";

export interface CreateObserverApplicationOptions extends ObserverControlOptions, ObserverAgentServerOptions {
  registry?: RegistryOptions;
  jobs?: JobStoreOptions;
  evidenceRoots?: string[];
  supportingLogRoots?: string[];
}

export interface ObserverApplication {
  agentInstanceId: string;
  control: ObserverControlApi;
  registry: InstanceRegistry;
  jobs: JobStore;
  artifacts: ArtifactStore;
  runs: ObserverRunStore;
  evidenceBundle?: EvidenceBundleService;
  server: ObserverAgentServer;
  operations: ObserverApplicationOperations;
}

/** Sole mutable observer-agent composition root. */
export function createObserverApplication(options: CreateObserverApplicationOptions = {}): ObserverApplication {
  const agentInstanceId = randomUUID();
  const control = new ObserverControlApi({ ...options, agentInstanceId });
  const registry = new InstanceRegistry(control.sessions, { clock: options.clock, ...options.registry });
  const jobs = new JobStore(control.sessions, registry, options.clock, options.jobs);
  const artifacts = new ArtifactStore(control.paths.artifacts, control.sessions, jobs);
  if ((options.supportingLogRoots?.length ?? 0) > 0 && (options.evidenceRoots?.length ?? 0) === 0) {
    throw new ObserverError("INVALID_REQUEST", "Supporting log roots require at least one evidence destination");
  }
  const evidenceBundle = (options.evidenceRoots?.length ?? 0) > 0
    ? new FileEvidenceBundleService(control.paths.exportWork, options.evidenceRoots!, [control.paths.logs, ...(options.supportingLogRoots ?? [])])
    : undefined;
  const runs = new ObserverRunStore(control.paths.runs, artifacts, evidenceBundle);
  const server = new ObserverAgentServer(agentInstanceId, control, registry, jobs, artifacts, runs, options);
  const application = { agentInstanceId, control, registry, jobs, artifacts, runs, server, ...(evidenceBundle ? { evidenceBundle } : {}) } as ObserverApplication;
  const operations = new ObserverApplicationOperations(application);
  application.operations = operations;
  server.setControlOperations(operations);
  return application;
}
