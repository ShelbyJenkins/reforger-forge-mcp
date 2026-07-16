# Observer protocol errors

Consumers branch on the stable `error.code` value exported by `constants.ts`; message prose is diagnostic only. Authentication failures intentionally avoid saying whether a session exists. Protocol-major mismatch is fatal. Runtime, artifact, and camera failures never authorize the agent to signal or terminate an Enfusion process.

`RESTORATION_UNCONFIRMED` is distinct from ordinary capture failure: the runtime could not prove that the observer still owned the camera and therefore did not blindly overwrite another camera. Callers must treat the renderer as unavailable until a later heartbeat or explicit release proves a safe state.
