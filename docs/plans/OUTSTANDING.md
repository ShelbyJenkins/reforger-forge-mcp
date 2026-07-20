# Outstanding maintainability work

**Reviewed:** 2026-07-19  

## Active work

### Require the CI checks on `main`

**Remaining:** A repository administrator must require the Windows CI context in `main` branch protection.
**Completion proof:** Branch-protection settings show the Windows context as required.
**Source:** Consolidated from Stage 1 task 1.

### Complete the one-spawn Workbench build cutover

**Remaining:**

- Run the target-build acceptance harness twice against an explicit controlled `.gproj`, using distinct fresh caller-exclusive output directories:

  ```powershell
  $env:RFO_RUN_LIVE_WORKBENCH_BUILD_ACCEPTANCE = '1'
  npm.cmd run dev:workbench:acceptance:build -- --confirm-live-run --gproj <ABSOLUTE_TARGET_GPROJ> --output-root <EXTERNAL_OUTPUT_PARENT>
  ```

- For each run, prove zero pre-existing Workbench listeners/processes; one target-only spawn; no helper GUID, helper root, or NET call; exact executable/PID/creation/owner identity; bounded execution; attributed logs; zero exit; a fresh hashed nonempty `resourceDatabase.rdb`; exact-child absence; endpoint and lifecycle vacancy; and no supervised children.
- Retain sanitized, revision/source-closure-bound evidence that records product version, target identity/digest, redacted arguments, output/log hashes, timings, evaluator identity, and limitations.
- Only after that proof passes, remove the helper preflight and build-only companion staging, make public builds emit V4 receipts, and rerun the same two-run acceptance through the public build command.

**Completion proof:** Retained prototype and final-public evidence both prove the one-spawn target-only path; public builds emit an evidence-only V4 receipt.  
**Source:** Consolidated from Stage 3 Task 7.

### Retire legacy Workbench build compatibility

**Remaining:** After the V4 public-build proof exists, migrate V3 durable records so terminal records remain inspectable/archiveable and unresolved records recover safely or return a specific fail-closed remediation result. Then remove V3 receipts, preflight state, legacy launch aliases, build-only companion evidence, and obsolete Workbench compatibility consumers.  
**Completion proof:** Migration tests cover terminal and unresolved V3 records; consumer searches and package checks find no retired compatibility surface; final public V4 evidence remains valid.  
**Source:** Consolidated from Stage 6 Task 4.

### Prove live observer capture behavior and retire source-text contracts

**Remaining:**

- Run the controlled graphical-runtime acceptance through capture, cancellation, world unload, agent/transport loss, and shutdown during every camera-lease phase:

  ```powershell
  $env:RFO_RUN_LIVE_RUNTIME_OBSERVER_ACCEPTANCE = '1'
  npm.cmd run dev:observer:acceptance:runtime -- --confirm-live-run
  ```

- Run the controlled Workbench acceptance for public current, explicit-pose, and look-at captures; restoration; handler, lease, world, project, and PNG failures; and exact-owned shutdown without terminating an unrelated process:

  ```powershell
  $env:RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE = '1'
  npm.cmd run dev:observer:acceptance:workbench -- --confirm-live-run
  ```

- Retain evidence for both backends showing exact world-revision binding, bounded deadlines and cancellation, public terminal results, restoration or exact-exit disposition, validated managed PNGs, manifest-last export, idempotent release, and no outstanding child or camera obligation.
- Replace each camera, lifecycle, acceptance-harness, and package source-text assertion only after its behavioral replacement fails under the corresponding injected fault. Keep only documented AST rules where no dynamic proof is possible.

**Completion proof:** Sanitized, revision/source-closure-bound runtime and Workbench evidence covers the failure matrices; remaining tests are behavioral or justified AST ownership rules.  
**Source:** Consolidated from Stage 4 closeout and Stage 6 Task 2.

### Remove the host observer compatibility facade

**Remaining:** Migrate all host users of `ObserverCoordinator` to the host application interface, then remove coordinator aliases, union types, and compatibility tests. Preserve one host graph and one private-agent graph; do not merge their trust boundaries.  
**Completion proof:** Private-child recovery and both live capture paths prove shutdown ordering, runtime REST/control separation, redaction, evidence-run cleanup, and zero child/camera obligations at rest without the coordinator facade.  
**Source:** Consolidated from Stage 6 Task 6.

### Close the remaining validation tiers

**Remaining:** Restore the explicit `.gitattributes` policy required by package contracts, resolve the Windows temporary-file rename failure if it still blocks the suite, run the retry-disabled full suite, finish a fresh `--omit=dev` installed-package smoke, and retain the required Windows/Node CI results.
**Completion proof:** `npm test -- --retry=0`, `npm run test:package`, and the required Windows CI tier pass with recorded results and no waiver.
**Source:** Consolidated from Stage 4/5/6 validation and exit criteria.

## Deferred work

### Isolate the line-ending normalization commit

**Why deferred:** The required standalone commit cannot be made safely until unrelated overlapping work is separated.  
**Completion proof:** In an isolated worktree or after prior work is committed separately, verify Workbench leaves the addon `-text` paths unaffected, apply the explicit non-addon LF policy, renormalize tracked files, and commit only line-ending changes with a clean diff and no content-line changes.  
**Source:** Consolidated from Stage 5 Task 7.
