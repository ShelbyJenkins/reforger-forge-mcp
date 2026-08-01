# Standalone Workbench runner CLI

`reforger-forge-workbench` is the packaged standalone entry point for a
project script or CI job when no live MCP server owns the Workbench lifecycle
lease. When an MCP server already owns that lease, use `wb_build` instead.
Both paths use the same guarded build policy; this page is the authoritative
contract for the standalone runner's JSON receipts.

The runner has two intents:

```text
reforger-forge-workbench --config <file> editor --gproj <path> --foreground
reforger-forge-workbench --config <file> build --gproj <path> --platform PC --output <path> --timeout-ms <n>
```

`editor` is deliberately foreground-only. `build` requires a caller-exclusive,
new, empty output directory. `--config` is optional; the runner also accepts
the normal shared configuration flags, including repeated
`--workbench-addon-dir` values. See the [setup guide](../SETUP.md#optional-configuration)
for configuration precedence, add-on-root discovery, and the full flag
reference.

## Output and exit codes

On a completed invocation, the runner writes exactly one JSON receipt to
stdout. A setup, argument, or lifecycle error instead writes one JSON error
record to stderr and returns a nonzero code. Treat stdout as machine output;
put caller logging on stderr or in a separate file.

| Exit code | Meaning |
|---|---|
| `0` | The requested intent completed successfully. For a build, this also means output attestation succeeded and `validationFailure` is `null`. |
| `1` | A build exited zero but failed output attestation, an ordinary runner error occurred, the child returned/fell back to exit code `1`, or a native status could not be represented as a portable CLI exit code. |
| `124` | The runner timed out the intent. |
| `130` | The invocation was aborted. |
| `2`–`255` | The child process's ordinary exit code, passed through unchanged. |

If the child has no numeric exit code, the runner returns `1` when it has a
signal and `0` when it has neither a code nor a signal. Callers normally need
only the first rule: exit code `0` is the fully verified success path.

## Receipt shapes

Neither receipt has a `version` field. The build receipt is one direct,
helper-free target build: it intentionally has no `preflight` or
`companionIdentity` field. The editor receipt retains `companionIdentity`
because an editor launch really does load and qualify the managed helper.

### Editor receipt

| Field | JSON type | Exit-0 contract |
|---|---|---|
| `intent` | `"editor"` | Discriminates this receipt. |
| `pid` | number | PID of the managed editor child. |
| `target` | string | Canonical target `.gproj` path used for the editor lifecycle. |
| `lifecycleGeneration` | string | The managed lifecycle generation for this editor session. |
| `endpointOwnership` | `"verified"` | The editor endpoint was proven to belong to this exact managed process. |
| `companionIdentity` | object | The installed helper's exact identity was Ping-qualified; see below. |
| `logDirectory` | string | Attributed editor log directory; useful for diagnostics, not a second success gate. |
| `exitStatus` | object | The native completion status already mapped to the CLI exit code. |

`companionIdentity` has string fields `addonId`, `addonGuid`, `addonVersion`,
`protocolVersion`, `workbenchProtocol`, `buildIdentity`, and `bundleDigest`.
A successful editor receipt already proves those values match the managed helper
expected by the running MCP; a wrapper does not need to re-check them.

### Build receipt

| Field | JSON type | Exit-0 contract |
|---|---|---|
| `intent` | `"build"` | Discriminates this receipt. |
| `pid` | number | PID of the exact target-build child. |
| `executablePath` | string | Canonical executable path recorded for that child. |
| `creationTime` | string | Exact Windows process-creation identity for that child. |
| `target` | string | Canonical target `.gproj` path. |
| `targetAddon` | object | Parsed and re-attested target ID, GUID, and project-file hash; check the ID/GUID only when a caller has a separate expected project. |
| `lifecycleGeneration` | string | The target build's managed lifecycle generation. |
| `processOwnership` | `"verified"` | Exact process ownership was proven by the runner. |
| `endpointVacancy` | `"verified"` | The Workbench endpoint was proven vacant for the target-build reservation and spawn. |
| `logDirectory` | string | Attributed target-build log directory; optional diagnostic evidence. |
| `output` | object or `null` | Non-null only after a zero native exit and successful fresh-output attestation; the proof is described below. |
| `validationFailure` | object or `null` | An `OUTPUT_ATTESTATION_FAILED` object maps an otherwise zero native exit to CLI exit `1`; native process failures leave this field `null`. |
| `exitStatus` | object | The native completion status already mapped to the CLI exit code. |

`targetAddon` contains strings `addonId`, `addonGuid`, and `sourceSha256`.
`output`, when present, contains:

| Field | JSON type | Meaning |
|---|---|---|
| `root` | string | Reserved build-output root. |
| `freshArtifactCount` | number | Count of fresh regular output artifacts; informational for callers. |
| `freshBytes` | number | Total fresh artifact size; informational for callers. |
| `resourceDatabasePath` | string | The one fresh `resourceDatabase.rdb` accepted by the attestation. |
| `previousResourceDatabaseSha256` | string or `null` | Always `null` on a successful run because the runner reserves an empty output root. |
| `resourceDatabaseSha256` | string | SHA-256 of that fresh resource database. |

When present, `validationFailure` contains the literal code
`"OUTPUT_ATTESTATION_FAILED"` and a string `message`.

`exitStatus` has `reason` (`"exited"`, `"timed_out"`, or `"aborted"`),
`exitCode` (number or `null`), `signal` (string or `null`), `timedOut`
(boolean), and a derived `classification`. The classification is one of
`success`, `nonzero_exit`, `windows_exception`, `signal`, `timed_out`,
`aborted`, or `unknown`.

For a Windows error-status exit, `nativeStatus` contains a normalized unsigned
eight-digit value such as `0xC0000005`; otherwise it is `null`. The nullable
`exceptionName` supplies a known symbolic name, such as
`STATUS_ACCESS_VIOLATION`. These fields distinguish a native crash from an
ordinary validation failure without changing the original exit evidence. Do
not automatically retry `windows_exception`: inspect the attributed log and
the failing project or engine state first. The runner does not collect Windows
crash dumps or their potentially private contents.

## Guarantees and redundant checks

The runner performs the following checks before it returns a successful build
receipt. Repeating them in PowerShell is not defense in depth: it can only
duplicate or weaken the runner's already fail-closed transaction.

| Possible caller-side check | Runner guarantee | Caller action |
|---|---|---|
| `processOwnership`, child PID/creation identity, or `endpointVacancy` equals `"verified"` | The target-only lifecycle reserves a vacant endpoint, starts only its exact child, and verifies ownership internally. A success receipt can contain no other value. | Do not re-check. |
| A managed companion identity or a preflight PID/generation exists | A target build is helper-free and has no preflight. The companion is irrelevant to the resource build, so those fields are intentionally absent. | Do not add a replacement check. |
| `targetAddon.sourceSha256` matches the `.gproj` re-read by the wrapper | `resolveBuildProjectMetadata` is re-run before launch; any target path, ID, GUID, or content drift fails with `INVALID_TARGET` rather than returning a receipt. | Do not re-hash. |
| `output.previousResourceDatabaseSha256` is `null`, or the output directory was empty | `reserveBuildOutput` requires an empty exclusive directory before launch and revalidates it at the recoverable-spawn boundary. | Do not re-check. |
| Output is fresh, nonempty, and has exactly one hashed `resourceDatabase.rdb` | `attestFreshBuildOutput` enforces all of this after a zero native exit; a failure sets `validationFailure` and makes the CLI return `1`. | Do not re-check. |
| Attributed log directory exists or is nonempty | Log attribution is retained for troubleshooting, but it is not an additional caller success condition. | Inspect only when diagnosing. |
| `targetAddon.addonId` and `targetAddon.addonGuid` are the project the caller intended | The runner can prove what the supplied path contains, not which add-on the caller meant to supply. | Check this once after exit `0`. |

The source references for the target and output guarantees are
`resolveBuildProjectMetadata`, the `reattestTarget` closure, `reserveBuildOutput`,
and `attestFreshBuildOutput` in `src/workbench/runner.ts`.

## The one caller-side identity check

For a build wrapper with a fixed intended add-on, retain only the operating
system exit-code check and the expected add-on ID/GUID check:

```powershell
$Receipt = (& node $RunnerCli build --gproj $ProjectFile --platform PC --output $BuildTarget --timeout-ms $TimeoutMilliseconds) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Build failed." }
if ($Receipt.targetAddon.addonId -ne 'RoadblockRunners' -or $Receipt.targetAddon.addonGuid -ne '02412E2D8D82234A') {
    throw "Built the wrong project: $($Receipt.targetAddon.addonId) ($($Receipt.targetAddon.addonGuid))."
}
```

Insert `--config $ConfigPath` before `build` when the wrapper uses an explicit
configuration file. Do not compare `sourceSha256`, lifecycle fields, output
hashes, endpoint fields, or helper identity again: the runner has already made
those conditions part of whether it can return exit `0`.

For an editor wrapper, select the exact `.gproj` before invoking the runner.
Its zero-exit receipt already includes the managed-helper identity proof; there
is no build-style target add-on object or companion check to recreate.

## Out of scope

This reference covers runner invocation, lifecycle, and receipt semantics. It
does not define an add-on's diagnostic-line filtering, retained-log policy, or
evidence handling; those are separate project concerns.
