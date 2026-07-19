import { z } from "zod";
import {
  artifactManifestSchema,
  cameraLeaseStatusSchema,
  captureRequestSchema,
  heartbeatSchema,
  instanceRegistrationSchema,
  jobStatusSchema,
  limitsSchema,
  runtimeCommandEnvelopeSchema,
  sessionContractSchema,
} from "./schemas.js";
import type { ObserverErrorCode } from "./registry.js";

export type ObserverLimits = z.infer<typeof limitsSchema>;
export type SessionContract = z.infer<typeof sessionContractSchema>;
export type InstanceRegistration = z.infer<typeof instanceRegistrationSchema>;
export type Heartbeat = z.infer<typeof heartbeatSchema>;
export type CaptureRequest = z.infer<typeof captureRequestSchema>;
export type CaptureView = CaptureRequest["view"];
export type RuntimeCommandEnvelope = z.infer<typeof runtimeCommandEnvelopeSchema>;
export type CameraLeaseStatus = z.infer<typeof cameraLeaseStatusSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;

export interface ProtocolErrorBody {
  protocolVersion: "1.0";
  error: {
    code: ObserverErrorCode;
    message: string;
  };
}
