# Reforger Forge MCP 1.2.0

This release adds bounded, selectable Observer image output and moves the
supported runtime to Node.js 24 LTS.

## Observer image output

- `observer_capture` accepts an optional `image` policy with independent
  `maxWidth` and `maxHeight` bounds. Resizing preserves aspect ratio, fits
  inside the supplied bounds, and never enlarges the renderer output.
- Output `format` may be `png`, `jpeg`, or `webp`. PNG is lossless. JPEG and
  WebP accept an optional integer `quality` from 1 through 100, subject to the
  operator-configured minimum and maximum; omitted lossy quality defaults to
  75 unless configured otherwise.
- Omitting `image` preserves the existing behavior: native-resolution PNG.
  Image policy is semantic request input, so capture replay and idempotency
  checks cannot substitute a different resolution, format, or quality.
- Synchronous and asynchronous reads report the actual MIME type, extension,
  dimensions, byte count, digest, effective quality, and source provenance.
  Evidence bundles and recovery preserve the same metadata.

Workbench captures use Enfusion's raw-data callback to create a fit-inside PNG
before persistence. The host validates that producer output, then uses the
pinned `@napi-rs/image` 1.14.0 encoder for requested PNG, JPEG, or WebP output.
Runtime captures use the same bounded host transformation after source intake.
Existing source, decoded-pixel, retained-artifact, inline-response, and
aggregate-retention limits remain enforced; an oversized final encoding fails
instead of silently changing requested quality.

## Runtime and compatibility

- Node.js 24 is now the supported and CI-tested runtime. Package metadata,
  setup validation, type definitions, and the Windows CI job use Node 24.
- The public change is additive. Existing capture callers that omit `image`
  continue to receive native-resolution PNG output.

## Validation

- Unit and integration coverage includes bounded output, PNG/JPEG/WebP
  metadata, retained-byte rejection, injected decode/encode failures, atomic
  promotion recovery, exact quality recovery, cancellation, and replay.
- The repository includes a live Workbench acceptance procedure for bounded
  PNG, JPEG, and WebP captures, producer-side scaling, camera restoration,
  cancellation, replay, and a subsequent capture.
- The v4 live procedure passed on Workbench 1.7.0.54 with Node.js 24.18.0. It
  reduced the 288x288 editor viewport to a 192x192 PNG before host retention,
  validated JPEG and WebP conversion and MIME metadata, preserved explicit
  and default quality, confirmed replay and cancellation restoration, finalized
  six captures, and left no Workbench or supervised child process running.
