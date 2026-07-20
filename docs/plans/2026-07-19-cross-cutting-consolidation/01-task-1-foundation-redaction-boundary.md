# Foundation redaction boundary implementation guide

**Status:** Proposed follow-on work  
**Parent context:** [Cross-cutting consolidation implementation guide](README.md), Task 1  
**Research snapshot:** 2026-07-19, against the active working tree  
**Entry condition:** Task 0's baseline and characterization results are retained with the review. This guide does not change input-admission policy, public error codes, or lifecycle identity checks.

## Outcome

One reviewed `src/foundation/redact.ts` implementation owns redaction for
diagnostics, command arguments, and portable evidence. Every migrated output
sink uses that implementation before it emits text, persists a diagnostic, or
exports evidence. Exact tokens and source data remain available to the narrow
operational code that verifies process ownership, validates a contract, or
hashes an artifact.

The change removes duplicated bearer, token, owner-argument, contract-body,
and Windows-path rules without silently changing non-secret output. Existing
replacement spellings stay caller-configurable so a CLI receipt, observer log,
and acceptance artifact retain their established public contracts.

## Scope and fixed decisions

1. Add `src/foundation/redact.ts` and `tests/foundation/redact.test.ts`. Use
   the existing `#foundation/*` import map; the shared TypeScript build already
   emits `src/foundation` to `dist/foundation`.
2. Implement three profiles: `diagnostic`, `command_argument`, and
   `evidence_portability`. Do not add a Boolean "redact" switch.
3. Redaction is an output-sink policy. Evidence runtime configuration must
   continue rejecting secret-bearing input; it must not be converted to a
   sanitizer.
4. Do not pass a redacted owner argument, nonce, contract, or path back to
   process inspection, request encoding, hashing, source-manifest validation,
   or another operation that needs exact bytes.
5. A structured redactor accepts primitives, arrays, and own data properties
   of plain records only. It does not claim arbitrary class instances,
   accessors, functions, or other host objects are safely serializable.
6. Truncate only after textual redaction has completed. A token that begins
   before a caller's character limit must not survive because its suffix fell
   outside a pre-redaction slice.
7. The packaged Enforce-mailbox acceptance script consumes the built module;
   it must not copy a JavaScript version of the redactor or import unbuilt
   TypeScript.

## Non-goals

- Do not change the observer protocol, public error taxonomy, or success
  receipt shape.
- Do not turn redaction into authorization, validation, encryption, or secret
  storage.
- Do not make raw `Error`, proxy, request, process, or class instances safe to
  serialize merely by recursively walking them.
- Do not normalize all paths globally. Path substitution is limited to the
  evidence-portability profile and its selected acceptance/evidence sinks.
- Do not remove evaluator-specific presentation rules unless the foundation
  profile has an explicitly equivalent rule and regression test.

## Starting-point inventory

The following current owners overlap. Re-run the searches before editing; the
parent guide deliberately treats categories rather than line counts as the
contract.

| Current location | Current behavior | Migration destination |
| --- | --- | --- |
| `observer/agent/logger.ts` | recursive key/body and bearer masking for agent stderr | diagnostic profile for both message text and fields |
| `src/observer/agent-client.ts` | child-line credential and contract masking | diagnostic text profile |
| `observer/agent/evidence-bundle-service.ts` | supporting-log bearer/key redaction | diagnostic text profile before evidence formatting |
| `src/workbench/runner-cli.ts`, `runner.ts`, `session-controller.ts` | owner-argument regular expressions or exact-argument replacement | command-argument/text helpers at the respective presentation sinks |
| `src/workbench/net-api-client.ts` | request-token collection plus exact replacement in a Workbench status | caller-provided exact secrets plus diagnostic text profile |
| `src/observer/owned-runtime-manager.ts` | owner-token diagnostic redaction | command-argument or diagnostic profile, according to its sink |
| `scripts/observer-live-acceptance-support.ts` | owner/path canonicalization for evidence identity | evidence-portability argument helper |
| controlled acceptance evaluators | console/path/structured-result sanitizers | foundation profile plus any documented evaluator-only presentation rule |
| `scripts/run-observer-enforce-mailbox-acceptance.mjs` | copied text and recursive value sanitizer | built `#foundation/redact` module |

The parent plan mentions `src/observer/coordinator.ts`; it is not present in
this worktree. The current coordinator is
`observer/agent/mailbox-coordinator.ts`. Treat that as an inventory correction,
not permission to skip its diagnostic sinks. Likewise, inspect
`observer/agent/runs.ts` and the evidence bundle path together: a returned or
persisted value should be redacted only at its presentation/export boundary,
never while it is still operational state.

Useful characterization commands:

```powershell
rg -n "function redact|function sanitize|redact[A-Za-z]+\(|sanitize[A-Za-z]+\(" observer src scripts tests -g "*.ts" -g "*.mjs"
rg -n "reforgerForgeOwnerToken|Bearer|sessionToken|launchNonce|instanceNonce|contract" observer src scripts tests -g "*.ts" -g "*.mjs"
npm run build
npm test -- tests/observer/protocol.test.ts tests/workbench/net-api-client.test.ts tests/workbench/runner-cli.test.ts
npm run test:package
```

Record current non-secret text, replacement spellings, and output bounds in the
review before moving a caller. That makes an accidental user-visible wording
change distinguishable from a redaction fix.

## Target API and semantics

Keep the public surface small. The exact internal helper names may differ, but
callers should depend on an API equivalent to this:

```ts
export type RedactionProfile =
  | "diagnostic"
  | "command_argument"
  | "evidence_portability";

export interface RedactionOptions {
  readonly profile: RedactionProfile;
  readonly replacement?: string;
  readonly knownSecretValues?: readonly string[];
  readonly maxLength?: number;
}

export function redactText(value: string, options: RedactionOptions): string;
export function redactDiagnostic(value: unknown, options: RedactionOptions): unknown;
export function redactArguments(
  values: readonly string[],
  options: RedactionOptions
): readonly string[];
```

Validate options before using them: profile and replacement must be known,
`maxLength` must be a non-negative bounded integer when supplied, and known
secret values must be strings within a defensive per-value limit. Ignore empty
known values. Deduplicate the remaining exact values and apply them
longest-first so a shorter token cannot leave the suffix of an overlapping
token visible.

`redactText` returns a new string, applies all applicable substitutions, then
applies `maxLength`. `redactArguments` returns a new array and treats each
element as one argument; it must not join and re-tokenize command lines.
`redactDiagnostic` returns a safe, bounded representation for primitives,
arrays, and records. It is not a general serializer.

### Profile rules

`diagnostic` owns these rules:

- bearer credentials in text, case-insensitively;
- authorization-like, credential, password, private-key, nonce, token, and
  secret-bearing keys and their values in structured records and recognizable
  key/value text assignments;
- exact caller-supplied secrets, including opaque values that a regular
  expression could not discover;
- full contract bodies. When a recognizable contract, contract body, or
  contract payload assignment is found, replace the entire value rather than
  attempting to whitelist child fields; and
- `-reforgerForgeOwnerToken` arguments in both `=value` and whitespace-value
  forms when they occur in text.

Key matching must tolerate the current casing and quoted JSON assignment
forms. Keep the contract rule deliberately broad: the existing `contract`
form and its body/payload variants all conceal their complete assigned value.
The implementation should use finite, reviewable matchers rather than one
unbounded expression with interacting captures.

`command_argument` is narrower. It masks exact owner-token argument forms
while preserving ordinary arguments. It is used when callers already have an
argument vector or a receipt/error that should retain all non-owner arguments.

`evidence_portability` composes diagnostic rules with the current evidence
normalization behavior:

- substitute an absolute Windows path with the existing portable placeholder;
- replace a comma-separated argument only with an absolute-path-list
  placeholder when every list member is absolute; and
- retain the evaluator's established Steam-ID replacement as a documented
  evidence-portability rule, if that output remains part of the controlled
  artifact contract.

The helper must recognize the Windows forms accepted by the current
`portableIsAbsolute` policy, including the relevant drive-root and UNC forms.
It must not erase a mixed relative/absolute comma-separated value as though it
were a path list. For `name=value` arguments, preserve `name=` and redact only
the absolute value. Preserve the current `<absolute-path>`,
`<absolute-path-list:N>`, and `<steam-id>` spellings where callers already
publish them.

### Structured-data boundary

Walk only arrays and plain records whose prototype is `Object.prototype` or
`null`. Before reading a record member, inspect its own property descriptor;
do not invoke a getter while preparing a diagnostic. Replace accessors,
unsupported prototypes, cycles, excess depth, and excess breadth with
documented harmless markers. Use identity tracking and finite constants (or
validated internal limits) so a pathological object cannot cause unbounded
work.

Preserve strings, numbers, booleans, `null`, and safe non-secret keys/values
within those bounds. Redact a secret-bearing key before descending into its
value. The returned value can safely be passed to the caller's existing JSON
formatter, but only after the caller chooses the appropriate profile and
output budget.

The redactor must be idempotent for every profile. A second pass must neither
reveal data nor turn an already-redacted placeholder into a different public
string.

### Exact dynamic secrets

The Workbench NET client receives arbitrary token values in request parameters
and may receive them reflected in a status string. It must continue to collect
string leaves beneath token-bearing request keys, then supply them as
`knownSecretValues` to `redactText`. Collection is request-specific metadata,
not a second redaction policy: it must not render, truncate, or otherwise
sanitize the status itself. Keep cycle handling and longest-first application
in the foundation boundary, and ensure the operation still sends the original
parameter object to `encodeRequest`.

## Implementation tasks

### REDACT-0: freeze output behavior and establish the migration ledger

1. Run the characterization commands and record every duplicated rule, its
   caller, replacement spelling, and output type: stderr, log field, receipt,
   evidence JSON, or markdown/log export.
2. Add focused characterization tests for the current observer logger,
   NET-client status, runner CLI, Workbench launch diagnostic, evidence log,
   and acceptance artifact paths. Capture non-secret output text and error
   codes as assertions.
3. Define distinct sentinel strings for bearer, authorization value, nonce,
   owner argument, contract body, nested token, opaque dynamic token, Windows
   path, UNC path, comma-separated all-absolute list, Steam ID, and a safe
   control value. Do not reuse a generic word such as `secret` as every
   sentinel.
4. Create a migration ledger with an explicit decision for every sink found by
   the searches: migrate now, intentionally retain because it is not a sink,
   or remove. A later search result is not an implicit exception.

**Acceptance:** The review can name each raw value that reaches a presentation
sink and can distinguish current public wording from the desired sanitization
change.

### REDACT-1: implement and prove the foundation contract

1. Add `src/foundation/redact.ts` using the API above. Keep profile selection,
   rule ordering, recursive traversal, exact-value handling, path recognition,
   and post-redaction truncation in this module.
2. Build text rules as small, bounded transformations. Normalize no semantic
   input other than the concealed spans; preserve surrounding non-secret text
   and argument prefixes.
3. Implement structured traversal over array elements and own plain-record
   data properties only. Apply depth and breadth checks before descending and
   retain cycle protection.
4. Expose replacement configuration rather than making callers reimplement a
   pattern merely to retain `[REDACTED]`, `[redacted]`, or `<redacted>`.
   Validate a replacement so it cannot itself create an unsafe or recursive
   match.
5. Add `tests/foundation/redact.test.ts` before migrating callers. Cover each
   profile independently and record the chosen limits and harmless markers in
   test names or fixtures.
6. Add a narrow operation-vs-presentation test with an injected process or
   request fake: it must observe the exact raw owner argument or token while
   the corresponding error/log output contains only the configured
   replacement.

**Acceptance:** The foundation module is deterministic, idempotent, bounded,
and cannot leak a test sentinel after a caller-supplied character limit.

### REDACT-2: migrate observer and evidence sinks

1. Replace the local logic in `observer/agent/logger.ts` with foundation
   calls. Redact both its text message and structured fields before writing to
   stderr. Remove the local recursive helper and move tests that imported
   `redactForDiagnostics` to the foundation API or a deliberately thin,
   non-policy compatibility export during the same review.
2. Migrate `src/observer/agent-client.ts` child-line output and its callers in
   `src/observer/application.ts`. Child stderr and catch-path diagnostics are
   presentation sinks even when they originate in a trusted child process.
3. Migrate `observer/agent/evidence-bundle-service.ts` supporting-log
   filtering. Keep `assertNoSecrets` unchanged: it rejects export input before
   the evidence redactor is considered.
4. Inspect `observer/agent/mailbox-coordinator.ts`, `observer/agent/runs.ts`,
   and their evidence/export callers using the REDACT-0 ledger. Apply the
   diagnostic profile only where they format logs, export a diagnostic, or
   persist a public-facing failure; do not redact durable operational records
   in place.
5. Migrate owner-token diagnostic output in
   `src/observer/owned-runtime-manager.ts` and any related observer receipt
   formatter. Keep exact receipt fields intact until the existing code has
   completed its identity comparison, hashing, and persistence decision.

**Acceptance:** Observer stderr, child diagnostics, supporting-log evidence,
and owned-runtime diagnostics have one rule owner. Runtime-config secret
rejection and exact lifecycle matching retain their prior behavior.

### REDACT-3: migrate Workbench presentation paths

1. In `src/workbench/runner-cli.ts`, replace
   `redactPrivateOwnerTokens` with the foundation command-argument/text call
   before serializing the one stderr error record. Preserve the stable
   `RUNNER_FAILED` fallback and receipt exit-code behavior.
2. In `src/workbench/net-api-client.ts`, retain request-specific collection of
   dynamic token values, pass those values to the diagnostic profile, and
   remove its local replacement loop. Test nested records, arrays, cycles, and
   overlapping exact values without passing a redacted object to request
   encoding.
3. In `src/workbench/session-controller.ts`, call `redactArguments` only for
   the log presentation vector. Keep `preflight.argv` and
   `preflight.ownerArgument` raw for launch, identity publication, and later
   verification.
4. In `src/workbench/runner.ts`, redact the validation-failure message only at
   receipt construction. Do not change output attestation inputs or the
   failure-code classification.
5. Search the Workbench subtree again for owner-token patterns and
   redact-prefixed helpers. Migrate each presentation sink or document why it
   is an internal matcher rather than a sink.

**Acceptance:** The exact process/request fakes receive raw credentials while
runner, session, and NET diagnostics retain their current non-secret wording
and never include a sentinel.

### REDACT-4: migrate controlled acceptance and portability output

1. Replace the path/owner normalization in
   `scripts/observer-live-acceptance-support.ts` with the
   evidence-portability argument helper. Preserve its canonical hash domain,
   list count marker, `observed` flag, and normalization version unless a
   separately reviewed artifact schema change is required.
2. Replace `redactConsoleError` in
   `scripts/run-workbench-build-acceptance.ts` with the foundation profile and
   caller-supplied exact argument values. Apply the configured output bound
   after redaction.
3. Migrate the text and structured-output sanitizers in the controlled
   evaluators, including `scripts/validate-observer-enforce.mjs` where it
   exports portable diagnostics. Retain only domain-specific presentation that
   is not a duplicate security rule, and document it in the ledger.
4. Replace `sanitizeText` and `sanitizeValue` in
   `scripts/run-observer-enforce-mailbox-acceptance.mjs` with imports from
   `#foundation/redact`. That import resolves to `dist/foundation/redact.js`
   under Node's normal package-import conditions; it must never target
   `src/foundation/redact.ts`.
5. Add `dist/foundation/redact.js` to the package check's required built-file
   proof. Verify a freshly packed `--omit=dev` installation can run the
   packaged mailbox acceptance script with the built module present. If the
   script is promised to run directly from a source checkout, make its
   build-first prerequisite explicit and fail clearly when the built artifact
   is unavailable.

**Acceptance:** Controlled artifacts retain their portable placeholders and
published `.mjs` code has no copied redactor or unbuilt-TypeScript import.

### REDACT-5: remove duplicate owners and prove the package boundary

1. Delete migrated local redact/sanitize helpers and their owner-token regular
   expressions. Retain only narrow internal matchers that validate raw process
   arguments and cannot emit diagnostics.
2. Update focused tests to import the foundation boundary rather than testing
   deleted implementation details.
3. Add a focused source/architecture assertion suitable for this task's
   scope: no migrated production output sink defines a redact-prefixed helper
   or owner token masking regular expression. Keep it narrow and tied to the
   migrated sinks; do not create a broad brittle repository scan.
4. Run `npm pack`/package tests after the source tests. Confirm the installed
   package import map resolves `#foundation/redact`, the compiled JavaScript is
   included, and the acceptance script cannot fall back to a second
   implementation.

**Acceptance:** Exactly one module owns output-redaction rules, and both the
source checkout and packed application exercise that same module.

## Required test matrix

The foundation suite should assert absence of every applicable sentinel from
both rendered text and `JSON.stringify` of the structured result. Include at
least:

- bearer, authorization-like, nonce/token/secret, owner-argument, and broad
  contract-body redaction with case variation and quoted JSON assignments;
- exact dynamic secret values, including overlapping values applied
  longest-first;
- `-reforgerForgeOwnerToken=value` and
  `-reforgerForgeOwnerToken value` forms;
- nested arrays and plain records, `null`, safe primitives, safe non-secret
  controls, excessive depth/breadth, cyclic graphs, class instances, and
  accessor properties that must not execute;
- repeated calls with exactly the same result;
- a secret spanning the caller's future character boundary, proving that
  redaction occurs before truncation;
- drive-root and UNC paths, path values after `=`, all-absolute comma lists,
  and mixed lists that must not acquire a misleading list placeholder; and
- replacement spellings expected by the CLI, diagnostic logs, and evidence
  artifacts.

Migration tests should additionally prove:

- the NET client sends the raw dynamic token while its reflected status is
  redacted;
- the Workbench session/runner raw owner argument reaches the injected
  verifier/launcher while only its presentation is redacted;
- evidence runtime-config secret admission still fails rather than producing
  sanitized output; and
- a freshly packed installation resolves and executes the mailbox acceptance
  script through the built foundation module.

## Validation

Run focused tests after each migration group, then the complete repository
checks:

```powershell
npm run build
npm test -- tests/foundation/redact.test.ts tests/observer/protocol.test.ts tests/workbench/net-api-client.test.ts tests/workbench/runner-cli.test.ts tests/workbench/runner.test.ts tests/workbench/workbench-session-controller.test.ts
npm run protocol:check
npm run observer:manifest
npm test
npm run test:package
```

When the controlled Windows environment is available, also run:

```powershell
npm run observer:validate:enforce -- --target both
npm run observer:acceptance:enforce-mailbox
```

Record skipped controlled checks as skipped, not passed. Re-run the inventory
searches after the suite passes and attach the migration ledger and sentinel
results to the review.

## Completion criteria

This task is complete when:

- `src/foundation/redact.ts` is the sole reviewed owner of diagnostic,
  owner-argument, exact-secret, contract-body, and evidence-portability rules;
- every migrated production, evidence, CLI, and packaged acceptance sink uses
  that boundary at presentation time;
- operational identity comparison, request encoding, hashing, validation, and
  durable records retain raw values until their existing work is complete;
- input secret rejection remains rejecting;
- sentinel tests cover text, structured values, truncation, dynamic tokens,
  and portability paths;
- non-secret public text and error codes remain characterized and stable;
- the packed `.mjs` acceptance script resolves the compiled foundation module
  without a copied redactor; and
- focused tests, build, full tests, manifest/protocol checks, package checks,
  and available controlled checks are green.
