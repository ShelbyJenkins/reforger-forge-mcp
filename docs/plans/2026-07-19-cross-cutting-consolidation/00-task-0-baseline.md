# Cross-cutting consolidation: Task 0 baseline

Recorded on 2026-07-19 against the current working tree before the
consolidation migrations. These are discovery results, not count assertions:
later tasks are expected to reduce or relocate them.

## Fresh inventory

| Concern | Source files | Test files | Search scope and result |
| --- | ---: | ---: | --- |
| Enforce vocabulary | 28 | 7 | Runtime and Workbench add-on C sources; host adapter/helper and packaging scripts; observer and Workbench contract suites. |
| Diagnostic redaction | 8 | 3 | Agent logger/evidence exporter, host child client, Workbench CLI/NET paths, and existing observer redaction suites. |
| Deadline, sleep, polling | 32 | 29 | Agent artifact intake, host/runtime lifecycle, Workbench readiness/runner/session control, acceptance scripts, and their contract suites. |
| Tool error formatting | 7 | 0 | Host tool adapter, owned-runtime tool adapter, public contract, and error-producing observer backends. Task 0 adds direct boundary coverage. |
| Add-on inventory | 12 | 6 | Source-manifest updater, source/staged-bundle validation, helper staging, package checker, and package/staging suites. |
| Temporary test setup | 0 | 26 | Direct `mkdtemp`/`mkdtempSync` use remains confined to test fixtures and is the Task 6 migration inventory. |

The exact commands used were:

```powershell
rg -n "function redact|redact[A-Za-z]+\\(" observer src scripts tests -g "*.ts"
rg -n "function sleep|pollUntil|waitFor|deadline|remaining" observer src scripts tests -g "*.ts"
rg -n "RFO_Observer|EMCP_WB_Observer|reforger-forge-workbench-observer" observer src scripts tests
rg -n "mkdtemp(Sync)?\\(" tests -g "*.ts"
npm run protocol:check
npm run test:package
```

The counts distinguish source from tests so the later migration reviews can
compare categories without treating this snapshot as a stale exact-count gate.

## Characterization coverage

`npm run test:cross-cutting:baseline` is additive to `npm test` and covers:

- secret sentinels through structured diagnostics, child stderr forwarding, and
  exported evidence logs;
- both public MCP error boundaries, including their distinct stable subjects and
  their fixed-message redaction policy;
- the Workbench vacancy poller's immediate first probe, bounded interval,
  absolute timeout, cancellation, and endpoint-unverifiable error mapping;
- source-manifest failure for both an undeclared added payload and a missing
  declared payload at staging and at the packed-add-on inventory boundary,
  alongside the protocol-artifact and readiness contracts;
- deterministic registry injection for protocol artifacts in
  `tests/observer/protocol-artifacts.test.ts`.

The protocol renderer already accepts an injected `ProtocolRegistrySource`; no
real add-on is mutated by those tests. Generated Enforce C vocabulary does not
exist in this baseline and remains deliberately deferred to Task 5, where its
renderer and C-drift checks will be introduced. The existing pure injected
registry characterization is the pre-migration seam that Task 5 extends.

## Recorded validation

- `npm run test:cross-cutting:baseline`: 30 tests passed across 8 files.
- `npm run protocol:check`: 14 generated protocol artifacts current.
- `REFORGER_FORGE_NPM_ONLINE=1 npm run test:package`: 828-file tarball,
  fresh production-only install, and both advertised binaries passed.

## Preserved behavior by later task

| Later task | Task 0 comparison point |
| --- | --- |
| 1: redaction | Current diagnostic and evidence replacement behavior and fixed tool-error messages. |
| 2: time | Workbench readiness/vacancy probe ordering, wait bounding, timeout, cancellation, and error codes. |
| 3: public errors | Current tool-specific public subjects plus canonical fixed-message policy. |
| 4: manifests | Source staging and packed-add-on inventory checks reject incomplete and undeclared payload sets. |
| 5: protocol generation | Injected registry rendering is deterministic without touching checked-in add-ons. |
| 6: test support | Direct temporary-directory usage inventory above. |
| 7: architecture checks | Search categories above define the narrow owner patterns to guard. |

## Detailed task plan

**Goal:** Give every migration a behavioral comparison point before the
existing duplicates are moved or deleted.

**Actions:**

. Record fresh search results for the categories in
   [Starting-point inventory](#starting-point-inventory). Include both source
   and test occurrences, with no hard-coded expectation that an old count is
   still correct.
. Add characterization tests before changing behavior:
   - every known secret sentinel is absent from diagnostic and evidence output;
   - each existing wait/poll path retains its first-attempt, interval, timeout,
     cancellation, and error-mapping behavior;
   - both tool boundaries produce the current stable public code/message
     policy;
   - a source-manifest file addition/removal is detected by staging and
     packaging checks;
   - generated C output is stable for a representative registry input.
. Make the protocol generator's render function accept an injected registry
   source, as its current artifact tests already do. This permits pure tests
   of generated C without mutating the real add-ons.
. Add a focused follow-on test command only after the new suites exist. It
   should be additive; do not weaken the existing full-suite command.

**Acceptance:** The baseline is recorded, the focused tests are green without
production changes, and a reviewer can identify which existing behavior each
later task preserves.
