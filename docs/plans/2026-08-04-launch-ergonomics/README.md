# Launch ergonomics project

> **Execution constraint:** Do not launch Enfusion Workbench or the game client
> while carrying out an open plan in this directory. If validation requires
> either application, stop before launch and wait for explicit confirmation
> that it is available for use.

This directory is the canonical home for the launch-ergonomics delivery: its
completed MCP lifecycle foundation, the numbered implementation series, and
the MCP-056 recovery follow-up discovered during idle-shutdown acceptance.
This page replaces the former series-only overview and the completed
`MCP Lifecycle Option A Implementation Plan`.

The [Observer API simplification plan](../2026-08-03-observer-api-simplification.md)
remains separate because it was an independently delivered project. It was
reviewed against the lifecycle foundation, and its compatibility constraints
are recorded in both places.

## Completed lifecycle foundation (Option A)

Option A was implemented and validated on 2026-08-04 in `ce0f915`. Its durable
contract is retained here; the obsolete phase-by-phase implementation checklist
is available in repository history at `7bfa974` and `ce0f915` if needed.

The foundation delivered:

- structured, bounded owned-runtime shutdown diagnostics before changing the
  shutdown design;
- an explicit `open -> quiescing -> sealing -> closing -> closed` host lifecycle,
  with `retryable_unsafe` preserving the same application and ownership identity
  after an incomplete seal;
- protocol admission closure and capture quiescence before exact-runtime sealing,
  using one absolute deadline across all shutdown phases;
- a CLI-only 30-second emergency deadline that may terminate only its disposable
  private Observer child and exit non-zero, while embedded disposal never calls
  `process.exit()` and neither path kills Workbench or a game runtime; and
- transparent first-use initialization inside `SearchEngine`, avoiding the full
  API-index cost for hosts that never use an index-backed operation or resource.

An unsafe ordinary shutdown retains the Observer connection and restoration
services so the same owner can retry; it never disguises an incomplete seal as
a clean close. Index construction publishes only a complete result and caches a
bounded stable failure instead of exposing partial state or parsing repeatedly.
Shared transports, per-session configuration, public schema changes, and any
weakening of exact-runtime or restoration authority remained out of scope.

The full hermetic suite, guarded real Workbench lifecycle acceptance, built
MCP/private-child process-tree acceptance, typecheck, build, MCP verification,
package validation, and the comparative memory probe passed. No game runtime was
launched under the original no-game constraint; the persistent unsafe path was
covered by the real-child black-box fixture. The Observer API simplification
plan was then reviewed and updated to preserve quiescence, admission, deadline,
and lazy-index boundaries.

On the reference Windows x64/Node v26.4.0 probe, full-data idle registration
matched the empty-index median at 89.4 MiB RSS; first use loaded the index once,
reached 208.1 MiB, and showed a 118.7 MiB median idle reduction relative to the
loaded baseline. These figures are characterization results, not portable CI
thresholds.

## Series map

1. [Workbench contextual refusals](2026-08-04-launch-ergonomics-01-workbench-refusals.md).
2. [Observer bounded remedies](2026-08-04-launch-ergonomics-02-observer-refusals.md).
3. [Registered project-world resolution](2026-08-04-launch-ergonomics-03-world-resolution.md).
4. [Dependency and add-on-root safety](2026-08-04-launch-ergonomics-04-dependency-root-safety.md).
5. [Shared runtime launch policy](2026-08-04-launch-ergonomics-05-runtime-launch-policy.md).
6. [Shared owned-runtime tool plumbing](2026-08-04-launch-ergonomics-06-runtime-plumbing.md).
7. [Owned `game_launch` baseline](2026-08-04-launch-ergonomics-07-owned-game-launch.md).
8. [Non-runnable Workbench launch preview](2026-08-04-launch-ergonomics-08-workbench-preview.md).
9. [Deferred fenced successor recovery](2026-08-04-launch-ergonomics-09-successor-recovery.md).
10. [Deferred external PowerShell descriptor infrastructure](2026-08-04-launch-ergonomics-10-powershell-descriptor.md).
11. [Deferred bounded runtime process inventory](2026-08-04-launch-ergonomics-11-runtime-process-inventory.md).
12. [Deferred external-script activation](2026-08-04-launch-ergonomics-12-external-script-activation.md).
13. [Operator-visible MCP host identity](2026-08-04-launch-ergonomics-13-mcp-host-identity.md).
14. [Host-scoped MCP idle readiness fencing](2026-08-04-launch-ergonomics-14-mcp-idle-readiness.md).
15. [Bounded MCP idle auto-shutdown](2026-08-04-launch-ergonomics-15-mcp-idle-shutdown.md).

The direct post-series recovery item is the resolved
[MCP-056 bounded owned-runtime history recovery plan](2026-08-05-mcp-056-bounded-runtime-history-recovery.md).

## Implementation status

| Work item | Status | Last updated | Notes |
|---|---|---|---|
| Foundation | Implementation complete; live validated | 2026-08-04 | Bounded retry-correct shutdown, capture quiescence, emergency private-child cleanup, and lazy API-index loading passed hermetic, Workbench, process-tree, packaging, and memory acceptance. Landed in `ce0f915`. |
| 1 | Implementation complete; live validated | 2026-08-04 | Required static gates and stage 3 tests 345/345 passed. Live compile-check, lifecycle, and explicit-save acceptances passed with final process vacancy. Landed in grouped commit `ff71390`. |
| 2 | Implementation complete; live validated | 2026-08-04 | Focused tests 40/40 and stage 4 tests 180/180 passed. Positive Workbench Observer acceptance passed with six captures, restoration, cleanup, and final process vacancy. Landed in grouped commit `ff71390`. |
| 3 | Implementation complete; live validated | 2026-08-04 | Focused tests 21/21, typecheck, and unused-code analysis passed. A real Workbench registration produced metadata that strict explicit/discovery resolution and evidence revalidation accepted. Landed in grouped commit `ff71390`. |
| 4 | Implementation complete; non-live validated | 2026-08-04 | Focused tests 14/14 and stage 3 tests 345/345 passed; typecheck and unused-code analysis passed. No live gate applies. Landed in `7a30eaf`. |
| 5 | Implementation complete; non-live validated | 2026-08-04 | Focused policy/compatibility tests 84/84 and stage 4 tests 180/180 passed; typecheck and unused-code analysis passed. No live gate applies. Landed in `5b76653`. |
| 6 | Implementation complete; non-live validated | 2026-08-04 | Focused operation/executable tests 33/33 and stage 4 tests 180/180 passed; typecheck and unused-code analysis passed. No live gate applies. Landed in `40dcabd`. |
| 7 | Implementation complete; live validated | 2026-08-05 | Focused and live-support tests 105/105, stage 4 tests 208/208, and cross-cutting baseline tests 55/55 passed, followed by full repository and package gates. Fresh-root listen-server and client cycles proved capture, restoration, exact-owned stop, cleanup, and final process vacancy. Landed in `5b37f62`. |
| 8 | Implementation complete; live validated | 2026-08-05 | Focused preview suites, stage 3 tests 370/370, the complete serial suite 2,278/2,278, typecheck, and unused-code analysis passed. Live acceptance returned a presentation-only preview without launching or claiming Workbench. Landed in `8b15049`. |
| 9 | Deferred; not started | 2026-08-05 | Optional lifecycle follow-up; retain until usage evidence justifies its durable-state cost. |
| 10 | Deferred; not started | 2026-08-05 | External-activation infrastructure follow-up. |
| 11 | Deferred; not started | 2026-08-05 | External-activation prerequisite. |
| 12 | Deferred; not started | 2026-08-05 | Final external-script activation follow-up. |
| 13 | Implementation complete; live validated | 2026-08-05 | Focused tests 172/172, stage 3 tests 345/345, stage 4 tests 228/228, and cross-cutting baseline tests 55/55 passed; typecheck, build, package smoke, and unused-code analysis passed. Windows black-box and live OS attestation proved distinct operator-visible host identities. Landed in `5ed27f3`. |
| 14 | Implementation complete; live validated | 2026-08-05 | Focused tests 189/189, stage 3 tests 351/351, stage 4 tests 254/254, cross-cutting baseline tests 56/56, and the full repository suite 2,211/2,211 passed with one intentional skip. A live Workbench session proved the default-open foundation remained behavior-neutral. Landed in `ba3b7ff`. |
| 15 | Implementation complete; live validated | 2026-08-05 | Focused tests 212/212, stage 3 tests 352/352, stage 4 tests 284/284, cross-cutting baseline tests 56/56, and the full repository suite 2,259/2,259 passed with one intentional skip. Safe idle exit and fail-closed historical-state paths both passed. Landed in `cc6648a`. |
| MCP-056 | Implementation complete; live validated | 2026-08-05 | Focused recovery tests 9/9 and the complete serial suite 2,278/2,278 passed with one intentional skip. Snapshot acceptance classified retained history, refused foreign authority without mutation, and proved controlled idle exit. Landed in `8b15049`. |

## Delivery groups

Commits 1-7 are the required ergonomic baseline. Commit 8 was optional and is
now delivered. Commits 9-12 remain intentionally deferred; their documents are
retained because each owns a distinct lifecycle or external-process contract
and none is redundant with the delivered baseline. Commit 13 is an independent
setup/operability follow-up.

Commit 14 is the behavior-neutral host-lifecycle foundation: existing-only
readers, typed readiness, provider revisions, and a default-open admission gate.
It depends only on Commit 13. Commits 7, 9, and 12 each carry a compatibility
obligation to extend its typed blocker projection when those features are
present. Commit 15 is the atomic idle-shutdown actor. MCP-056 is the completed
recovery follow-up produced by Commit 15's fail-closed live acceptance.

## Dependency map

The numbering is recommended review order, not a claim that every commit is
linearly dependent:

```text
1 independent
2 independent
3 independent
4 -> 3
5 -> 3 + 4
6 behavior-independent, ordered after 5
7 -> 2 + 3 + 4 + 5 + 6
8 optional and independent
9 -> 7
10 -> 5 + 6
11 -> 6
12 -> 7 + 9 + 10 + 11
13 independent
14 -> 13; 7 + 9 + 12 extend its blocker projection when present
15 -> 14
MCP-056 -> 15
```

Each numbered document remains the authoritative implementation task for its
step, including scope, validation, and acceptance criteria. This README is the
authoritative project navigation and status record.
