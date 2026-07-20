# Public observer error projection and safe rendering implementation guide

**Status:** Implementation-ready follow-on work
**Parent context:** [Cross-cutting consolidation implementation guide](README.md), Task 3; Task 1 is a prerequisite  
**Research snapshot:** 2026-07-19, against the active working tree  
**Entry condition:** The reviewed diagnostic-redaction contract is available. This guide must not cause unredacted values to reach a public renderer.

## Outcome

Public observer tool errors safely render permitted, already-redacted structured
details without depending on JSON.stringify to handle circular references,
BigInt values, or pathological nested objects. The safe-stable-stringify
package supplies deterministic, bounded serialization mechanics; local code
continues to own public error policy, redaction, value admissibility, and
transport formatting.

The result is one public observer error projector used by both current MCP tool
boundaries. A malformed detail can never replace the intended public error with
a formatter failure or reveal a secret through a fallback path.

## Scope and fixed decisions

1. Add safe-stable-stringify as a pinned production dependency because compiled
   runtime code imports it.
2. Use it only for public diagnostic-detail presentation after the registry
   policy and diagnostic redactor have allowed the detail.
3. The central projector owns code canonicalization, fixed-message selection,
   diagnostic-detail gating, redaction, safe presentation, and final response
   bounding. Each tool boundary remains only a classifier and subject-label
   adapter.
4. Keep the public error-code classifier, fixed-message gate, subject line,
   redaction profiles, and character budgets in local code. Unknown errors
   retain the existing internal public error policy.
5. Normalize unknown values before serialization. Do not rely on a serializer
   to make arbitrary Error instances, class instances, getters, proxies, or
   toJSON methods safe for a public boundary.
6. Use deterministic key order and finite depth/breadth limits. A detail that
   cannot fit safely must become a fixed harmless representation, never a
   sliced JSON fragment.
7. Do not replace JSON serialization for manifests, protocol artifacts,
   receipts, evidence, configuration, persistence, or successful tool results
   with this dependency.

## Non-goals

- Do not turn serialization into a secret-redaction policy.
- Do not serialize a raw Error object, stack trace, request, process handle,
  or server instance for an MCP response.
- Do not change stable public error codes or subject lines.
- Do not promise that arbitrary JavaScript objects are safe to inspect.
- Do not add lifecycle, server-composition, or tool-registration dependencies
  to the public-contract boundary.

## Implementation blueprint (normative)

This section turns the task outline below into the concrete implementation
contract. It resolves the API, dependency, limit, ordering, and test decisions
that must not be left to an implementer to infer. If it differs from a more
general statement later in this guide, this section takes precedence.

### Boundary ownership and data flow

The public error flow is deliberately one-way:

```text
thrown value
  -> thin tool adapter identifies one known error class
  -> public-contract canonicalizes the public code and applies the fixed-message gate
  -> Task 1 diagnostic redactor (only for a non-fixed known error)
  -> public-json normalizer
  -> configured safe-stable-stringify
  -> public-contract MCP text formatter and complete-response budget
  -> { content: [{ type: "text", text }], isError: true }
```

At no point may a raw diagnostic message or raw details value bypass the
diagnostic redactor. The public JSON adapter accepts an **already-redacted**
value only; it does not accept a redaction profile, known secrets, or a raw
`Error`. It provides mechanics, not policy.

Keep these owners separate:

| Owner | Responsibilities | Explicitly not responsible for |
| --- | --- | --- |
| `src/observer/public-contract.ts` | Public code canonicalization, generated fixed-message selection, fixed-message gate, diagnostic admission, Task 1 redaction calls, response budget, subject/code/message/fence formatting. | Inspecting arbitrary objects or serializer configuration. |
| `src/foundation/redact.ts` | Existing Task 1 diagnostic text and structured-value redaction. | Public error codes, MCP formatting, or serialization. |
| New `src/foundation/public-json.ts` | Side-effect-resistant post-redaction normalization, deterministic complete JSON rendering, serializer fallback. | Secret rules, error classification, response subjects, protocol transport. |
| `src/observer/tools.ts` | Recognize `ObserverCoordinatorError`; supply `Observer error`. | Redaction, code selection, detail gating, formatting, and JSON rendering. |
| `src/tools/observer-runtime.ts` | Recognize `OwnedRuntimeError`; supply `Observer runtime error`. | Redaction, code selection, detail gating, formatting, and JSON rendering. |

The two tool modules retain `jsonText` for successful results. That behavior is
outside this task; only the `toolError` detail path migrates.

### Exact dependency decision

Add the following exact production dependency; do not use a range:

```json
"safe-stable-stringify": "2.5.0"
```

Regenerate `package-lock.json` with the supported Node 20/npm toolchain. The
package's named ESM `configure` export, built-in declarations, deterministic
ordering, circular marker, maximum depth/breadth settings, and configurable
BigInt behavior are all verified requirements. Confirm the production tarball
and a fresh `--omit=dev` installation resolve the compiled import.

### Public-contract API

Add the following shapes to `src/observer/public-contract.ts`. Equivalent
internal helper names are fine; the public responsibilities and narrow input
shape are not optional.

```ts
export const PUBLIC_OBSERVER_ERROR_TEXT_MAXIMUM = 512;

export interface PublicObserverErrorCandidate {
  readonly code: unknown;
  readonly readDiagnosticMessage: () => unknown;
  readonly readDetails: () => unknown;
}

export interface PublicObserverErrorProjectionOptions {
  readonly subject: "Observer error" | "Observer runtime error";
  readonly extract: (error: unknown) => PublicObserverErrorCandidate | undefined;
}

export function projectPublicObserverToolError(
  error: unknown,
  options: PublicObserverErrorProjectionOptions
): string;
```

Return a text string rather than an MCP SDK result. This keeps the public
contract independent of the SDK while making it the only formatter for the
public error text. The caller still wraps that text in the standard MCP error
envelope.

The tool-specific extractors are intentionally the only code that knows their
concrete error classes. They must be equivalent to:

```ts
function extractObserverCoordinatorError(error: unknown): PublicObserverErrorCandidate | undefined {
  if (!(error instanceof ObserverCoordinatorError)) return undefined;
  return {
    code: error.code,
    readDiagnosticMessage: () => error.message,
    readDetails: () => error.details,
  };
}
```

Use the parallel extractor for `OwnedRuntimeError`. Do not retain the current
`error instanceof Error ? error.message : undefined` fallback: an unrecognized
error must stay on the established internal public path without publishing its
raw message.

### Exact projection sequence

Implement `projectPublicObserverToolError` in this order:

1. Call `options.extract(error)` once. If it throws or returns `undefined`, use
   `INTERNAL_ERROR` and no diagnostic candidate.
2. Canonicalize the candidate code using the existing
   `canonicalPublicObserverErrorCode` registry gate.
3. Look up the generated fixed message **before calling either diagnostic
   reader**.
4. For a fixed-message code, return only
   `<subject> (<code>): <fixed message>`, bounded to the complete response
   limit. Do not call the redactor, normalizer, or serializer. This is a hard
   redaction boundary, not a presentation preference.
5. For a non-fixed known error, call `readDiagnosticMessage()` once, then pass
   a string result through
   `redactText(message, { profile: "diagnostic", maxLength: ... })`, then use
   the existing `Observer operation failed.` fallback if absent or empty.
6. Build the header, calculate the remaining whole-response budget, and omit
   details if no complete fenced block can fit.
7. When details are present, call `readDetails()` once, then pass its result to
   `redactDiagnostic(details, { profile: "diagnostic" })` and pass only that
   result to `renderRedactedPublicJson`.
8. Append the result only when it is a complete JSON value and the combined
   header, fence, and JSON fit the complete 512-character public response.
9. Catch unexpected extractor, redactor, normalizer, serializer, and formatter
   failures. Return the harmless internal public result with no caught message,
   details, stack, cause, or raw fallback.

Do not use a truthiness check for details. A present `0`, `false`, `null`, or
empty string is still a value that the safe normalizer can handle. Represent
presence separately from the rendered outcome.

### Whole-response budget

The current code bounds only the message. This task intentionally changes the
bound to cover the actual `content[0].text` value. Define the following beside
the projection code and test the final text length directly:

```ts
const JSON_FENCE_PREFIX = "\n\n```json\n";
const JSON_FENCE_SUFFIX = "\n```";
const MINIMUM_JSON_DETAIL_BLOCK = JSON_FENCE_PREFIX.length + JSON_FENCE_SUFFIX.length + 2;
```

After redacting the message, ordinary text may be sliced to its calculated
allowance. Details may not. Let `available` be 512 minus the header and exact
fence lengths. Call the renderer only when `available` is sufficient for a
complete fallback object; otherwise return the header. If the final defensive
length check fails, return the header again. Never slice serialized JSON, a
code fence, a marker, or a replacement string.

### New `public-json` foundation module

Create `src/foundation/public-json.ts` and
`tests/foundation/public-json.test.ts`. Use this API:

```ts
export interface PublicJsonRenderOptions {
  readonly maximumDepth: number;
  readonly maximumBreadth: number;
  readonly maximumNodes: number;
  readonly maximumStringLength: number;
  readonly maximumCharacters: number;
}

export interface PublicJsonRenderResult {
  readonly text: string | undefined;
  readonly truncated: boolean;
  readonly fallback: boolean;
}

export function renderRedactedPublicJson(
  value: unknown,
  options: PublicJsonRenderOptions
): PublicJsonRenderResult;
```

`text: undefined` is a normal outcome: the caller omits the details block when
no complete safe JSON value fits. `truncated` means a complete intentional
fallback value is returned. `fallback` identifies a renderer failure path for
tests and must never contain an exception's text.

Use these fixed production limits at the observer call site:

```ts
const PUBLIC_DETAIL_MAXIMUM_DEPTH = 6;
const PUBLIC_DETAIL_MAXIMUM_BREADTH = 24;
const PUBLIC_DETAIL_MAXIMUM_NODES = 128;
const PUBLIC_DETAIL_MAXIMUM_STRING_LENGTH = 256;
```

The renderer validates all limits as small positive safe integers. A node limit
is required in addition to depth and breadth, which alone do not bound the
total work performed on a wide tree.

### Normalizer requirements

Create a fresh presentation graph. Never return an input container or copy an
arbitrary object into it.

| Input | Required normalized form |
| --- | --- |
| `null`, boolean, finite number, bounded string | Same primitive |
| Long string | Bounded complete string plus a string-limit marker |
| `bigint` | Fixed BigInt marker; do not convert it to a potentially imprecise JSON number |
| `NaN`, `Infinity`, `-Infinity` | Fixed non-finite-number marker |
| Array | Fresh array of bounded own data-property elements; holes become `null` |
| Record with `Object.prototype` or `null` prototype | Fresh null-prototype record of bounded own enumerable string-keyed data properties |
| Circular accepted container | Corresponding cycle in the fresh graph, for the serializer to mark |
| Accessor | Fixed accessor marker without calling getter or setter |
| Function, symbol, `undefined`, class instance, `Error`, date, map, set, typed array, request, process, server | Fixed unsupported marker |
| Reflection/proxy trap | Fixed uninspectable marker, caught locally |

Use one marker map with stable literal spellings, for example:

```ts
const PUBLIC_JSON_MARKERS = {
  accessor: "[public-json:accessor]",
  bigint: "[public-json:bigint]",
  breadth: "[public-json:breadth]",
  depth: "[public-json:depth]",
  nodeLimit: "[public-json:node-limit]",
  nonFiniteNumber: "[public-json:non-finite-number]",
  stringLimit: "[public-json:string-limit]",
  uninspectable: "[public-json:uninspectable]",
  unsupported: "[public-json:unsupported]",
};
const PUBLIC_JSON_TRUNCATION = { details: "[public-json:truncated]" };
const PUBLIC_JSON_FAILURE = { details: "[public-json:unavailable]" };
```

Apply the limits before descending or copying. Use a
`WeakMap<object, object>` from the source container to the fresh destination;
register the fresh destination before walking children. This preserves a
finite cycle without recursively expanding it.

Inspect property descriptors before reading values. Never use `Object.entries`,
object spread, `value[key]`, `for...of`, `Array.prototype.map`, or `toJSON`.
For plain records, sort accepted keys before copying. For arrays, inspect own
index descriptors and never read through the prototype chain. JavaScript cannot
reliably identify a `Proxy`; wrap reflection in narrow `try`/`catch` blocks and
substitute `uninspectable` when inspection traps. Do not log a caught object.

The Task 1 redactor already normalizes diagnostic input. This normalizer is a
defense-in-depth boundary for unexpected values and future callers; it must not
copy Task 1 secret-key rules or become another redaction owner.

### Serializer and complete truncation

Create one module-level serializer factory:

```ts
import { configure } from "safe-stable-stringify";

const stringifyPublicJson = configure({
  bigint: false,
  circularValue: "[public-json:circular]",
  deterministic: true,
  maximumBreadth: 24,
  maximumDepth: 6,
  strict: false,
});
```

The normalizer always replaces reachable `BigInt`, so `bigint: false` is a
defense-in-depth guard rather than the public representation. Use the factory
without a replacer or indentation. The adapter's local node and string limits
remain necessary because the dependency has no equivalent input-work limit.

Serialize the normalized value first. If its text fits, return it. If it does
not, serialize `PUBLIC_JSON_TRUNCATION` and return that only when it fits. If
even that cannot fit, return `text: undefined`. If configuration, normalization,
or serialization throws, attempt only the fixed `PUBLIC_JSON_FAILURE` value;
otherwise omit details. Never retry with `JSON.stringify`, `String`, template
interpolation, `util.inspect`, or raw value spreading.

### Required test matrix

Add direct adapter tests that assert every defined `text` parses with
`JSON.parse` and that repeated renders match exactly. Cover deterministic key
ordering; circular record and array graphs; nested `BigInt`; depth, breadth,
node, and string limits; non-finite numbers; invalid options; tiny character
budgets; `Error`, class, map, set, typed-array, function, and symbol values;
a getter/setter counter that stays at zero; a throwing `toJSON` counter that
stays at zero; and a proxy that throws during reflection.

Add direct public-contract tests for canonical code selection, every existing
fixed message, redacted non-fixed messages/details, normal/truncated/omitted
detail blocks, full `text.length <= 512`, and extractor/redactor/renderer
failure. A fixed-message test must place a throwing getter or proxy in details
and prove it was not inspected. Scan final normal and truncation output for
bearer, owner-token, token, nonce, contract-body, and Windows-path sentinels.

Retain and extend `tests/cross-cutting/task0-characterization.test.ts` for the
two real MCP boundaries. Verify that their subjects remain exactly `Observer
error` and `Observer runtime error`, their fixed-message output remains exact,
and equivalent permitted errors differ only by that subject. Add the focused
runtime registration coverage in `tests/observer/phase-h.test.ts` where it is
already used for this boundary.

### Package and architecture checks

Add `dist/foundation/public-json.js` to the required packed files in
`scripts/check-package.mjs`. Extend its fresh-install proof, or add a narrowly
scoped installed-package probe, so a built public boundary renders a circular
detail from the packed tarball. Source-mode tests alone do not prove the
production dependency is present.

Add a narrow architecture assertion that neither target tool module calls
`JSON.stringify(details` for a public error and both import the central
projector. Do not create a repository-wide ban: successful `jsonText` calls
remain outside this task.

## Starting-point inventory

The two observer tool boundaries currently construct error text locally and
pass details through JSON.stringify. The target is their convergence in
src/observer/public-contract.ts.

Run:

    rg -n "function jsonText|function toolError|JSON.stringify\(details" src/observer/tools.ts src/tools/observer-runtime.ts
    rg -n "canonicalPublicObserverError|diagnosticDetailsAllowed" src/observer/public-contract.ts
    rg -n "redactForDiagnostics|redactOwnerTokens|redactPrivateOwnerTokens" observer src scripts -g "*.ts"

Before migration, characterize the two current public subject lines, canonical
error codes, fixed-message behavior, diagnostic-detail eligibility, and
existing character limits.

## Target boundary

The normative blueprint above is the complete target boundary. In particular,
the projector owns public policy and transport text, `public-json.ts` accepts
only already-redacted values, and no local tool boundary serializes public
details. The remaining tasks translate that contract into implementation and
review checkpoints.

## Implementation tasks

### T3-0: freeze the existing public contract

1. Add characterization tests for both tool boundaries covering known
   bounded-diagnostic errors, fixed-message errors, unknown errors, and their
   existing subject text.
2. Add sentinels for bearer credentials, owner tokens, contract bodies, and
   Windows paths. Confirm no permitted rendered detail leaks a sentinel after
   the parent redactor is introduced.
3. Add pre-migration cases for a circular record, BigInt, excessive nesting,
   excessive breadth, an unsupported class instance, a throwing getter, and a
   throwing toJSON method.
4. Record the current public message and response-size limits. Any changed
   output must be explicitly reviewed rather than inherited accidentally from
   a serializer default.

**Acceptance:** The suite distinguishes error-policy regressions, redaction
regressions, and serialization-safety regressions.

### T3-1: add and verify the dependency

1. Add an exact reviewed safe-stable-stringify version to dependencies and
   regenerate package-lock.json.
2. Verify Node 20 compatibility, TypeScript declarations, ESM import behavior,
   license, and the production npm package contents.
3. Write one focused adapter test that proves the selected import uses the
   intended configuration rather than relying on package defaults.
4. Confirm npm pack and fresh --omit=dev installation include the compiled
   adapter and resolve the production dependency.

**Acceptance:** The installed MCP server can load the adapter on supported
Node versions, and no dependency version is floating.

### T3-2: implement the safe public-value adapter

1. Implement a normalizer that recognizes only primitives, arrays, and records
   with an approved plain-object prototype.
2. Inspect property descriptors before accessing a record value. Substitute a
   fixed marker for accessors and unsupported prototypes; do not execute user
   code while formatting an error.
3. Track objects by identity so a cyclic structure remains finite. Preserve
   stable traversal order and apply depth/breadth limits before descending.
4. Configure one serializer instance with deterministic ordering, explicit
   circular and BigInt policy, and finite maximum depth/breadth.
5. Catch every adapter-internal exception and return a fixed safe JSON result.
   Error rendering must never throw over the original operation failure.
6. Apply the configured character limit after serialization by choosing a
   complete truncation representation, not by truncating raw text.

**Acceptance:** Every unknown input produces a finite, deterministic,
non-throwing result without evaluating accessors or toJSON methods.

### T3-3: compose the projector with the redactor and public contract

1. Extend the central public observer projector in
   src/observer/public-contract.ts to obtain details only from its narrow
   error-class adapter. It owns canonical code selection, fixed-message
   selection, diagnostic-detail gating, redaction, safe presentation, and the
   final 512-character response bound.
2. Apply canonical code selection and the fixed-message gate before requesting
   details. A fixed-message result must not inspect or serialize hidden
   diagnostic data.
3. For a permitted detail, pass it through the diagnostic redactor, then the
   public JSON adapter, then the common MCP text formatter.
4. Keep the existing observer and observer-runtime subject lines in their
   respective thin adapters. They should differ only in subject/classification,
   not in rendering policy.
5. Remove direct JSON.stringify calls for public error details after both
   boundaries use the projector.
6. Keep successful-result JSON rendering out of scope unless a separately
   reviewed change establishes an equivalent redaction and transport contract.

**Acceptance:** Both error paths return the same code, gate, redaction, safe
serialization, and bounded-detail result for equivalent input.

### T3-4: prove negative cases and package behavior

1. Assert circular details render their configured marker and do not throw.
2. Assert BigInt values follow the selected explicit representation.
3. Assert deep and broad data returns a bounded complete JSON value.
4. Assert accessors, proxies that throw during inspection, custom toJSON
   functions, functions, symbols, and Error instances become harmless markers
   or the fixed fallback without executing their user code where avoidable.
5. Assert every redaction sentinel remains absent before and after truncation.
6. Assert fixed-message errors never contain a rendered details block.
7. Run a package smoke test that exercises a built, freshly installed public
   tool boundary rather than only source-mode tests.

## Validation

Run focused foundation, public-contract, and real-boundary tests first, then
the complete repository and packaging checks:

```powershell
npm ci
npm run build
npm test -- tests/foundation/redact.test.ts tests/foundation/public-json.test.ts tests/observer/public-contract.test.ts tests/cross-cutting/task0-characterization.test.ts tests/observer/phase-h.test.ts
npm run protocol:check
npm run observer:manifest
npm test
npm run test:package
```

The package check must use the built tarball and a fresh `--omit=dev`
installation. Include the parent guide's diagnostic-redaction sentinel suite in
every review. If a controlled evidence or Workbench acceptance evaluator renders
public diagnostics, run its focused tests as well. Do not report an unrun
controlled test as passing; record it as skipped with the reason.

## Completion criteria

This Task 3 follow-on is complete when:

- safe-stable-stringify is pinned, locked, compatible with supported Node
  versions, and available in the packed production installation;
- public details pass through the reviewed redactor before serialization;
- a narrow normalizer prevents arbitrary objects from executing code at the
  public boundary;
- circular, BigInt, deep, broad, malformed, and unsupported values produce
  bounded, complete, non-throwing output;
- both observer tool boundaries use the same renderer while retaining their
  stable subject lines and canonical error policy;
- direct public-error JSON.stringify detail rendering is removed; and
- focused tests, full tests, build, and package checks are green.
