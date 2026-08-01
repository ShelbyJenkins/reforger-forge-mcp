import { isAbsolute } from "node:path";
import { z } from "zod";
import { ObserverError } from "./errors.js";

const runtimeLogEvidenceGrantSchema = z.object({
  version: z.literal(1),
  runId: z.string().regex(/^\d{8}T\d{6}Z-[a-f0-9]{8}$/),
  captureLabel: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,95}$/),
  sessionId: z.string().min(1).max(96).regex(/^[A-Za-z0-9_-]+$/),
  runtimeId: z.string().regex(/^rt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  generation: z.string().regex(/^[a-f0-9]{64}$/),
  profilePath: z.string().min(1).max(32_768),
  scriptLogPath: z.string().min(1).max(32_768),
  grantedAt: z.string().datetime(),
}).strict();

export type RuntimeLogEvidenceGrant = z.infer<typeof runtimeLogEvidenceGrantSchema>;

/** Validate private durable authority before it is stored or consumed. */
export function validateRuntimeLogEvidenceGrant(input: unknown): RuntimeLogEvidenceGrant {
  const parsed = runtimeLogEvidenceGrantSchema.safeParse(input);
  if (!parsed.success) {
    throw new ObserverError(
      "SESSION_UNVERIFIABLE",
      "Runtime log evidence authority is malformed",
      409
    );
  }
  const grant = parsed.data;
  if (!isAbsolute(grant.profilePath) || !isAbsolute(grant.scriptLogPath)) {
    throw new ObserverError(
      "SESSION_UNVERIFIABLE",
      "Runtime log evidence authority does not contain absolute managed paths",
      409
    );
  }
  return grant;
}
