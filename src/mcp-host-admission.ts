/** A same-process state owner whose revision can be checked synchronously. */
export interface McpAdmissionRevisionSource {
  currentIdleRevision(): number;
}

export interface McpAdmissionRevisionSnapshot {
  readonly source: McpAdmissionRevisionSource;
  readonly revision: number;
}

/** Opaque, host-gate-owned authority produced only by a complete idle proof. */
export interface McpIdleSealProof {
  readonly kind: "mcp-idle-seal-proof";
}

export interface McpHostAdmissionSnapshot {
  readonly state: "open" | "sealed";
  readonly activeTokens: number;
  /** Disposer-authorized work currently running outside ordinary admission. */
  readonly privilegedCleanupCount: number;
  readonly revision: number;
}

export interface McpHostAdmissionToken {
  readonly active: boolean;
  release(): void;
  /** Move an admission to detached work without ever publishing a zero-token gap. */
  transfer(description: string): McpHostAdmissionToken;
}

export class McpHostAdmissionError extends Error {
  constructor(message = "MCP host admission is sealed") {
    super(message);
    this.name = "McpHostAdmissionError";
  }
}
interface AdmissionSlot {
  description: string;
  generation: number;
}

interface IssuedProof {
  readonly gateRevision: number;
  readonly providers: readonly McpAdmissionRevisionSnapshot[];
  used: boolean;
}

function assertDescription(description: string): string {
  if (typeof description !== "string" || description.trim().length === 0 || description.length > 256) {
    throw new TypeError("MCP host admission description must contain 1 through 256 characters.");
  }
  return description;
}

function assertRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError("MCP idle revision must be a non-negative safe integer.");
  }
  return revision;
}

/**
 * One process-wide, default-open admission fence.
 *
 * Embedded compositions leave this gate open. The CLI idle controller is the
 * sole production actor that may consume a complete proof and seal it.
 */
export class McpHostAdmissionGate implements McpAdmissionRevisionSource {
  private readonly slots = new Map<symbol, AdmissionSlot>();
  private readonly proofs = new WeakMap<object, IssuedProof>();
  private revision = 0;
  private sealed = false;
  private privilegedCleanupCount = 0;

  acquire(description: string): McpHostAdmissionToken {
    assertDescription(description);
    if (this.sealed) throw new McpHostAdmissionError();
    const id = Symbol(description);
    const slot: AdmissionSlot = { description, generation: 0 };
    this.slots.set(id, slot);
    this.bump();
    return this.tokenFor(id, slot.generation);
  }

  async run<T>(description: string, action: () => Promise<T> | T): Promise<T> {
    const token = this.acquire(description);
    try {
      return await action();
    } finally {
      token.release();
    }
  }

  /**
   * Cleanup authorized by the disposer runs outside ordinary admission, but
   * remains visible to diagnostics and invalidates any outstanding idle proof.
   */
  async runPrivilegedCleanup<T>(action: () => Promise<T> | T): Promise<T> {
    this.privilegedCleanupCount += 1;
    this.bump();
    try {
      return await action();
    } finally {
      this.privilegedCleanupCount -= 1;
      this.bump();
    }
  }

  snapshot(): McpHostAdmissionSnapshot {
    return Object.freeze({
      state: this.sealed ? "sealed" : "open",
      activeTokens: this.slots.size,
      privilegedCleanupCount: this.privilegedCleanupCount,
      revision: this.revision,
    });
  }

  currentIdleRevision(): number {
    return this.revision;
  }

  /**
   * Mint an opaque proof only for an idle, open gate. Provider snapshots are
   * retained privately and are never serialized into readiness diagnostics.
   */
  issueIdleSealProof(
    providers: readonly McpAdmissionRevisionSnapshot[],
  ): McpIdleSealProof | null {
    if (this.sealed || this.slots.size !== 0 || this.privilegedCleanupCount !== 0) return null;
    const normalized = providers.map(({ source, revision }) => ({ source, revision: assertRevision(revision) }));
    const proof = Object.freeze({ kind: "mcp-idle-seal-proof" as const });
    this.proofs.set(proof, { gateRevision: this.revision, providers: normalized, used: false });
    return proof;
  }

  /**
   * Synchronously validate and consume one proof. Every failure is nonthrowing
   * and leaves the admission gate open; a proof is single-use even on failure.
   */
  trySealIdleAdmissions(proof: McpIdleSealProof | null | undefined): boolean {
    if (!proof || typeof proof !== "object") return false;
    const issued = this.proofs.get(proof as object);
    if (!issued || issued.used) return false;
    issued.used = true;
    if (this.sealed || this.slots.size !== 0 || this.privilegedCleanupCount !== 0 ||
        this.revision !== issued.gateRevision) return false;
    try {
      for (const provider of issued.providers) {
        if (provider.source.currentIdleRevision() !== provider.revision) return false;
      }
    } catch {
      return false;
    }
    this.sealed = true;
    this.bump();
    return true;
  }

  private tokenFor(id: symbol, generation: number): McpHostAdmissionToken {
    const gate = this;
    let active = true;
    return Object.freeze({
      get active(): boolean {
        return active && gate.slots.get(id)?.generation === generation;
      },
      release(): void {
        if (!active) return;
        active = false;
        const slot = gate.slots.get(id);
        if (!slot || slot.generation !== generation) return;
        gate.slots.delete(id);
        gate.bump();
      },
      transfer(description: string): McpHostAdmissionToken {
        assertDescription(description);
        if (!active) throw new McpHostAdmissionError("MCP host admission token is no longer active");
        const slot = gate.slots.get(id);
        if (!slot || slot.generation !== generation) {
          active = false;
          throw new McpHostAdmissionError("MCP host admission token is no longer active");
        }
        active = false;
        slot.description = description;
        slot.generation += 1;
        gate.bump();
        return gate.tokenFor(id, slot.generation);
      },
    });
  }

  private bump(): void {
    if (this.revision === Number.MAX_SAFE_INTEGER) {
      // A process cannot practically reach this, but never wrap a fence value.
      throw new Error("MCP host admission revision exhausted");
    }
    this.revision += 1;
  }
}
