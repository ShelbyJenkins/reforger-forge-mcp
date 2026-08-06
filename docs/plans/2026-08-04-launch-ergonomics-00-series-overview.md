# Step 0: launch ergonomics series overview

> **Execution constraint:** Do not launch Enfusion Workbench or the game client
> while carrying out this plan. If testing reaches a point that requires either,
> stop before launching it and wait for explicit confirmation that it is
> available for use.

> **Document role:** Series-wide navigation and dependency metadata only. This
> is not an implementation task and does not produce a commit.

## Series map

1. [Workbench contextual refusals](2026-08-04-launch-ergonomics-01-workbench-refusals.md).
2. [Observer bounded remedies](2026-08-04-launch-ergonomics-02-observer-refusals.md).
3. [Registered project-world resolution](2026-08-04-launch-ergonomics-03-world-resolution.md).
4. [Dependency and add-on-root safety](2026-08-04-launch-ergonomics-04-dependency-root-safety.md).
5. [Shared runtime launch policy](2026-08-04-launch-ergonomics-05-runtime-launch-policy.md).
6. [Shared owned-runtime tool plumbing](2026-08-04-launch-ergonomics-06-runtime-plumbing.md).
7. [Owned `game_launch` baseline](2026-08-04-launch-ergonomics-07-owned-game-launch.md).
8. [Optional Workbench launch preview](2026-08-04-launch-ergonomics-08-workbench-preview.md).
9. [Deferred fenced successor recovery](2026-08-04-launch-ergonomics-09-successor-recovery.md).
10. [External PowerShell descriptor infrastructure](2026-08-04-launch-ergonomics-10-powershell-descriptor.md).
11. [Deferred bounded runtime process inventory](2026-08-04-launch-ergonomics-11-runtime-process-inventory.md).
12. [Deferred external-script activation](2026-08-04-launch-ergonomics-12-external-script-activation.md).
13. [Independent operator-visible MCP host identity](2026-08-04-launch-ergonomics-13-mcp-host-identity.md).
14. [Host-scoped MCP idle readiness fencing](2026-08-04-launch-ergonomics-14-mcp-idle-readiness.md).
15. [Bounded MCP idle auto-shutdown](2026-08-04-launch-ergonomics-15-mcp-idle-shutdown.md).

## Implementation status

| Commit | Status | Last updated | Notes |
|---|---|---|---|
| 1 | Implementation complete; live validated | 2026-08-04 | Required static gates and stage 3 tests 345/345 passed. Live compile-check, lifecycle, and explicit-save acceptances passed with final process vacancy. Landed in grouped commit `ff71390`. |
| 2 | Implementation complete; live validated | 2026-08-04 | Focused tests 40/40 and stage 4 tests 180/180 passed. Positive Workbench Observer acceptance passed with six captures, restoration, cleanup, and final process vacancy. Landed in grouped commit `ff71390`. |
| 3 | Implementation complete; live validated | 2026-08-04 | Focused tests 21/21, typecheck, and unused-code analysis passed. A real Workbench registration produced metadata that strict explicit/discovery resolution and evidence revalidation accepted. Landed in grouped commit `ff71390`. |
| 4 | Implementation complete; non-live validated | 2026-08-04 | Focused tests 14/14 and stage 3 tests 345/345 passed; typecheck and unused-code analysis passed. No live gate applies. Landed in `7a30eaf`. |
| 5 | Implementation complete; non-live validated | 2026-08-04 | Focused policy/compatibility tests 84/84 and stage 4 tests 180/180 passed; typecheck and unused-code analysis passed. No live gate applies. Landed in `5b76653`. |
| 6 | Implementation complete; non-live validated | 2026-08-04 | Focused operation/executable tests 33/33 and stage 4 tests 180/180 passed; typecheck and unused-code analysis passed. No live gate applies. Landed in `40dcabd`. |
| 7 | Implementation complete; live validated | 2026-08-05 | Focused and live-support tests 105/105, stage 4 tests 208/208, and cross-cutting baseline tests 55/55 passed; the exact full repository suite, typecheck, build, MCP verification, manifest/protocol checks, and unused-code analysis passed. Separate fresh-root public `game_launch` listen-server and client cycles each resolved the registered project world, exposed one matching graphical observer, produced five material captures with pose/look-at restoration, terminated the exact-owned runtime, revoked the session, removed scratch state, and proved final process vacancy. |
| 8 | Not started | 2026-08-04 | Optional. |
| 9 | Not started | 2026-08-04 | Deferred follow-up. |
| 10 | Not started | 2026-08-04 | Deferred follow-up. |
| 11 | Not started | 2026-08-04 | Deferred follow-up. |
| 12 | Not started | 2026-08-04 | Deferred follow-up. |
| 13 | Implementation complete; live validated | 2026-08-05 | Focused tests 172/172, stage 3 tests 345/345, stage 4 tests 228/228, and cross-cutting baseline tests 55/55 passed; typecheck, build, package smoke, and unused-code analysis passed. A Windows black-box acceptance concurrently attested two built MCP hosts with distinct client labels and UUIDs while preserving the configured Node image and byte-clean stdout. Live OS attestation then bound one Codex-managed host's UUID, PID, start time, configured Node image, product title, and `codex` client label to its exact command line, and Task Manager's command-line view displayed the product/client marker. |
| 14 | Implementation complete; live validated | 2026-08-05 | Focused tests 189/189, stage 3 tests 351/351, stage 4 tests 254/254, cross-cutting baseline tests 56/56, and the full repository suite 2211/2211 passed with one intentionally skipped integration file; typecheck, build, package smoke, and unused-code analysis passed. The foundation remained default-open and behavior-neutral before Commit 15 wiring. During a live exact-owned Workbench session, the same MCP host, Workbench PID, and NET API port remained alive beyond the configured 60-second idle deadline; exact-owned shutdown then released the process and port. Existing-only durable inspection remained noncreating and fail-closed against unresolved default-root evidence. |
| 15 | Implementation complete; live validated | 2026-08-05 | Focused tests 212/212, stage 3 tests 352/352, stage 4 tests 284/284, cross-cutting baseline tests 56/56, and the full repository suite 2259/2259 passed with one intentionally skipped launcher integration; typecheck, build, package smoke, MCP verification, protocol/manifest checks, and unused-code analysis passed. The two-host black-box stdio acceptance proved that one silent safe host shut down itself and its disposable private Observer child while a second remained alive under protocol backpressure; the focused idle suite additionally passed 30/30. A standalone production host using an isolated Observer root committed idle shutdown after 60.4 seconds and exited cleanly with code 0, while the default-root run stayed open with `INCOMPLETE_PROOF` and performed no automatic lifecycle mutation. The safe exit and fail-closed paths therefore both passed; the historical-runtime reconciliation limitation is tracked as MCP-056. |

Update this table after each numbered commit is completed. Mark a commit
complete only after its acceptance criteria are satisfied and its required
non-live validation has passed; record any intentionally deferred live gate in
the Notes column.

## Delivery groups

Commits 1-7 are the required ergonomic baseline. Commit 8 is independent and
optional. Commits 9-12 are follow-ups whose lifecycle and external-process cost
must not block the baseline. Commit 13 is an independent setup/operability
follow-up and may land without any game-launch commit.

Commit 14 is a behavior-neutral host-lifecycle foundation: existing-only readers,
typed readiness, provider revisions, and a default-open admission gate. It
depends only on Commit 13. Commits 7, 9, and 12 each carry a compatibility
obligation to extend its typed blocker projection when those features are present.
Commit 15 is the atomic actor: the 30-minute-default configuration, protocol
activity accounting, controller, diagnostics, and the sole production seal/exit
path land and revert together.

## Dependency map

The numbering is recommended review order, not a claim that every commit is
linearly dependent:

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

Each numbered document is the authoritative implementation task for that step,
including its own scope, validation, and acceptance criteria.
