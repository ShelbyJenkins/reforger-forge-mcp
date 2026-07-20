import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ObserverAgentClient } from "./agent-client.js";

const SOURCE_MANIFEST_NAME = ".reforger-forge-observer-source.json";
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function inspectHostPath(path: string): Record<string, unknown> {
  try {
    const entry = lstatSync(path);
    return {
      path,
      exists: true,
      symbolicLink: entry.isSymbolicLink(),
      kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { path, exists: false, symbolicLink: false, kind: "missing" };
    return {
      path,
      exists: null,
      symbolicLink: null,
      kind: "unreadable",
      errorCode: typeof code === "string" ? code : "READ_FAILED",
    };
  }
}

export function inspectObserverSource(sourceAddon: string): Record<string, unknown> {
  const source = inspectHostPath(sourceAddon);
  const manifestPath = join(sourceAddon, SOURCE_MANIFEST_NAME);
  const manifestFile = inspectHostPath(manifestPath);
  if (source.exists !== true || source.kind !== "directory" || source.symbolicLink === true) {
    return { verificationState: "source_unavailable", verified: false, source, manifestFile };
  }
  if (manifestFile.exists !== true || manifestFile.kind !== "file" || manifestFile.symbolicLink === true) {
    return { verificationState: "manifest_unavailable", verified: false, source, manifestFile };
  }
  try {
    const entry = lstatSync(manifestPath);
    if (entry.size < 2 || entry.size > MAX_MANIFEST_BYTES) {
      return { verificationState: "manifest_size_invalid", verified: false, source, manifestFile, bytes: entry.size };
    }
    const bytes = readFileSync(manifestPath);
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!record(parsed)) throw new TypeError("manifest root is not an object");
    const declared = {
      manifestVersion: typeof parsed.manifestVersion === "number" ? parsed.manifestVersion : null,
      addonVersion: typeof parsed.addonVersion === "string" ? parsed.addonVersion : null,
      protocolVersion: typeof parsed.protocolVersion === "string" ? parsed.protocolVersion : null,
      addonId: typeof parsed.addonId === "string" ? parsed.addonId : null,
      addonGuid: typeof parsed.addonGuid === "string" ? parsed.addonGuid : null,
      buildIdentity: typeof parsed.buildIdentity === "string" ? parsed.buildIdentity : null,
      bundleDigest: typeof parsed.bundleDigest === "string" ? parsed.bundleDigest : null,
      fileCount: Array.isArray(parsed.files) ? parsed.files.length : null,
    };
    const readable = declared.manifestVersion === 1 &&
      typeof declared.addonVersion === "string" && typeof declared.protocolVersion === "string" &&
      typeof declared.addonId === "string" && typeof declared.addonGuid === "string" &&
      typeof declared.buildIdentity === "string" && /^[a-f0-9]{64}$/.test(declared.buildIdentity) &&
      typeof declared.bundleDigest === "string" && /^[a-f0-9]{64}$/.test(declared.bundleDigest) &&
      typeof declared.fileCount === "number" && declared.fileCount > 0;
    return {
      verificationState: readable ? "declared" : "manifest_shape_invalid",
      verified: false,
      source,
      manifestFile,
      bytes: bytes.length,
      manifestSha256: createHash("sha256").update(bytes).digest("hex"),
      declared,
    };
  } catch (error) {
    return {
      verificationState: "manifest_unreadable",
      verified: false,
      source,
      manifestFile,
      errorCode: (error as NodeJS.ErrnoException).code ?? "INVALID_JSON",
    };
  }
}

export class ObserverHostDiagnostics {
  constructor(
    private readonly agent: ObserverAgentClient,
    private readonly managedRoot: string,
    private readonly profileRoot: string,
    private readonly sourceAddon: string,
    private readonly requestTimeoutMs: number,
  ) {}

  async inspect(operation: "status" | "doctor", closing: boolean, closed: boolean): Promise<Record<string, unknown>> {
    if (!closed && !closing && this.agent.state === "ready") {
      const response = await this.agent.requestIfReady(operation, {}, { timeoutMs: this.requestTimeoutMs });
      if (!record(response)) throw new TypeError(`Observer ${operation} returned an invalid response`);
      return response;
    }
    const state = closed ? "closed" : closing ? "closing" : this.agent.state === "starting" ? "starting" : "idle";
    const sourceManifest = inspectObserverSource(this.sourceAddon);
    const declared = record(sourceManifest.declared) ? sourceManifest.declared : null;
    const digest = typeof declared?.bundleDigest === "string" && /^[a-f0-9]{64}$/.test(declared.bundleDigest)
      ? declared.bundleDigest : null;
    const addonId = typeof declared?.addonId === "string" && /^[A-Za-z0-9_-]{1,96}$/.test(declared.addonId)
      ? declared.addonId : null;
    const staged = digest && addonId ? join(this.managedRoot, "addons", digest, addonId) : null;
    return {
      readOnly: true,
      mutationPerformed: false,
      diagnostic: operation,
      agentState: state,
      running: false,
      endpoint: null,
      observerRoot: this.managedRoot,
      profileRoot: this.profileRoot,
      managedStorage: {
        root: inspectHostPath(this.managedRoot),
        addons: inspectHostPath(join(this.managedRoot, "addons")),
        artifacts: inspectHostPath(join(this.managedRoot, "artifacts")),
        runs: inspectHostPath(join(this.managedRoot, "runs")),
        exportWork: inspectHostPath(join(this.managedRoot, "export-work")),
        state: inspectHostPath(join(this.managedRoot, "state")),
        logs: inspectHostPath(join(this.managedRoot, "logs")),
        profileRoot: inspectHostPath(this.profileRoot),
        expectedStagedAddon: staged ? inspectHostPath(staged) : null,
      },
      sourceManifest,
      stateLoaded: false,
      sessions: [],
      instances: [],
      jobs: [],
      promises: { launchesProcesses: false, signalsProcesses: false, mutatesWorkbenchHandlers: false },
      note: "Private observer agent is not running; durable profile contracts and staged payloads were not opened or modified.",
    };
  }
}
