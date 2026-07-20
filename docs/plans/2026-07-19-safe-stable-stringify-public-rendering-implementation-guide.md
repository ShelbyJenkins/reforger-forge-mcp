# Safe-stable-stringify public rendering implementation guide

**Status:** Proposed follow-on work  
**Parent context:** [Cross-cutting consolidation implementation guide](2026-07-19-cross-cutting-consolidation-implementation-guide.md), Tasks 1 and 3  
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
3. Keep the public error-code classifier, fixed-message gate, subject line,
   redaction profiles, and character budgets in local code.
4. Normalize unknown values before serialization. Do not rely on a serializer
   to make arbitrary Error instances, class instances, getters, proxies, or
   toJSON methods safe for a public boundary.
5. Use deterministic key order and finite depth/breadth limits. A detail that
   cannot fit safely must become a fixed harmless representation, never a
   sliced JSON fragment.
6. Do not replace JSON serialization for manifests, protocol artifacts,
   receipts, evidence, configuration, or persistence with this dependency.

## Non-goals

- Do not turn serialization into a secret-redaction policy.
- Do not serialize a raw Error object, stack trace, request, process handle,
  or server instance for an MCP response.
- Do not change stable public error codes or subject lines.
- Do not promise that arbitrary JavaScript objects are safe to inspect.
- Do not use this migration to change successful tool-result JSON formatting.

## Starting-point inventory

The two observer tool boundaries currently construct error text locally and
pass details through JSON.stringify. The parent guide already requires their
error policy to converge in src/observer/public-contract.ts.

Run:

    rg -n "function jsonText|function toolError|JSON.stringify\(details" src/observer/tools.ts src/tools/observer-runtime.ts
    rg -n "canonicalPublicObserverError|diagnosticDetailsAllowed" src/observer/public-contract.ts
    rg -n "redactForDiagnostics|redactOwnerTokens|redactPrivateOwnerTokens" observer src scripts -g "*.ts"

Before migration, characterize the two current public subject lines, canonical
error codes, fixed-message behavior, diagnostic-detail eligibility, and
existing character limits.

## Target boundary

Add a small foundation adapter, for example src/foundation/public-json.ts. It
should have a deliberately narrow contract:

    export interface PublicJsonRenderOptions {
      readonly maximumDepth: number;
      readonly maximumBreadth: number;
      readonly maximumCharacters: number;
    }

    export interface PublicJsonRenderResult {
      readonly text: string;
      readonly truncated: boolean;
    }

    export function renderRedactedPublicJson(
      value: unknown,
      options: PublicJsonRenderOptions
    ): PublicJsonRenderResult;

The name is intentional: callers must pass a value that has already crossed
the diagnostic redaction boundary. The adapter should not accept a redaction
profile or secret list because that would make it another competing policy
owner.

The rendering pipeline is:

    known error details
        -> diagnostic redactor
        -> public-value normalizer
        -> safe-stable-stringify with fixed limits
        -> complete JSON result or fixed truncation result
        -> public-contract transport formatter

The normalizer accepts primitives, arrays, and plain records only. It applies
the same depth and breadth policy before reading values, rejects unsupported
objects with a harmless marker, and must not invoke a getter or a custom
toJSON method. It preserves cycles for the serializer to mark safely, rather
than recursively expanding them without bound.

Configure safe-stable-stringify through a single module-level factory. The
review must verify the selected version's ESM import shape and support for:

- deterministic key ordering;
- a configured circular marker;
- bounded maximum depth and breadth;
- an explicit BigInt representation; and
- a non-throwing fallback for unrenderable input.

If the serialized text is over maximumCharacters, return one complete fixed
JSON value such as an object indicating truncation. Never use string slicing
that leaves an unterminated string, incomplete code fence, or partial secret.
The public-contract layer owns the final response-wide budget and may omit
details entirely when no valid bounded form fits.

## Implementation tasks

### SSS-0: freeze the existing public contract

1. Add characterization tests for both tool boundaries covering known
   bounded-diagnostic errors, fixed-message errors, unknown errors, and their
   existing subject text.
2. Add sentinels for bearer credentials, owner tokens, contract bodies,
   Windows paths. Confirm no permitted rendered detail leaks a
   sentinel after the parent redactor is introduced.
3. Add pre-migration cases for a circular record, BigInt, excessive nesting,
   excessive breadth, an unsupported class instance, a throwing getter, and a
   throwing toJSON method.
4. Record the current public message and response-size limits. Any changed
   output must be explicitly reviewed rather than inherited accidentally from
   a serializer default.

**Acceptance:** The suite distinguishes error-policy regressions, redaction
regressions, and serialization-safety regressions.

### SSS-1: add and verify the dependency

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

### SSS-2: implement the safe public-value adapter

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

### SSS-3: compose it with the redactor and public contract

1. Extend the central public observer projector in
   src/observer/public-contract.ts to obtain details only from its narrow
   error-class adapter.
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

### SSS-4: prove negative cases and package behavior

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

Run focused foundation and observer projection tests first, then:

    npm ci
    npm run build
    npm test
    npm run test:package

Include the parent guide's diagnostic-redaction sentinel suite in every review.
If a controlled evidence or Workbench acceptance evaluator renders public
diagnostics, run its focused tests as well. Do not report an unrun controlled
test as passing.

## Completion criteria

This follow-on is complete when:

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
