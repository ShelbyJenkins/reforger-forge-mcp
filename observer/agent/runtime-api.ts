import { ArtifactStore } from "./artifacts.js";
import { JobStore } from "./jobs.js";
import { InstanceRegistry } from "./registry.js";
import { SessionStore } from "./sessions.js";

export class ObserverRuntimeApi {
  constructor(
    private readonly sessions: SessionStore,
    private readonly registry: InstanceRegistry,
    private readonly jobs: JobStore,
    private readonly artifacts: ArtifactStore
  ) {}

  register(message: unknown, token: string) {
    return this.registry.register(message, token);
  }

  heartbeat(message: unknown, token: string) {
    return this.registry.heartbeat(message, token);
  }

  nextCommand(sessionId: string, instanceId: string, instanceNonce: string, token: string) {
    this.sessions.authorize(sessionId, token);
    return this.jobs.nextCommand(sessionId, instanceId, instanceNonce);
  }

  updateJob(message: unknown, token: string) {
    return this.jobs.update(message, token);
  }

  announceArtifact(message: unknown, token: string) {
    return this.artifacts.intake(message, token);
  }
}
