/** Process-local convenience only; durable open runs are never auto-adopted. */
export class ActiveRunContext {
  private runId: string | undefined;

  current(): string | undefined { return this.runId; }

  activate(runId: string): void { this.runId = runId; }

  clearIf(runId: string): void {
    if (this.runId === runId) this.runId = undefined;
  }

  resolve(explicit?: string): string | undefined { return explicit ?? this.runId; }
}
