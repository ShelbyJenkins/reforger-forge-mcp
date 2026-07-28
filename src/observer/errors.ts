/** Public error type for the host-side ObserverApplication boundary. */
export class ObserverApplicationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ObserverApplicationError";
  }
}

/**
 * @deprecated Use ObserverApplicationError. Kept as an alias so existing
 * consumers retain `instanceof` compatibility during the terminology change.
 */
export { ObserverApplicationError as ObserverCoordinatorError };
