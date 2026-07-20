# Task 6 — Shared test support

**Status:** Planned follow-on work
**Parent context:** [Cross-cutting consolidation implementation guide](README.md), Task 6
**Prerequisite:** Task 2 supplies the injectable time contract used by manual
time and polling test support.

## Intended outcome

Ordinary tests use a small shared support layer for temporary directories,
manual time, polling, and observer fixtures. Tests that must exercise native
filesystem, process, or cleanup behavior retain direct control of those
resources.

## Planned work

1. Add cleanup-safe temporary-directory, manual-time, wait, and observer
   fixture helpers under `tests/support/`.
2. Make the manual clock implement the foundation time seam, including a
   controlled sleeper for deadline and polling tests.
3. Consolidate reusable observer and Workbench fixture construction without
   creating a second exact-process fake or parallel fixture owner.
4. Migrate reviewable groups of ordinary tests first; document every remaining
   raw temporary-directory allocation that is itself under test.

## Completion signals

- Support helpers clean up after success, assertion failure, and rejected async
  work, including under parallel execution.
- Fixture builders have valid deterministic defaults and preserve overrides.
- Ordinary tests no longer hand-roll polling or temporary-root setup.
- Every direct native setup call has a documented behavioral reason.


## Detailed task plan

**Goal:** Make the shortest correct test setup the shared setup, without
forcing native/integration tests into inappropriate fakes.

**Primary files:**

- Add tests/support/temporary-directory.ts, tests/support/manual-time.ts,
  tests/support/wait.ts, and tests/support/observer-fixtures.ts.
- Move or adapt tests/observer/helpers.ts into tests/support/.
- Reuse the existing shared exact-process fake rather than creating another.
- Add a small Workbench fixture module only for shared construction that is
  genuinely reused.

At this snapshot, direct temporary-directory allocation appears in dozens of
test sites across more than two dozen files. Recount at Task 0 rather than
turning that incidental number into a completion criterion.

**Actions:**

1. Provide a test-scoped temporary-directory helper with automatic cleanup
   after each test. It must support a caller-provided prefix and expose the
   path only; it must not hide a mid-test cleanup action when that action is
   the behavior under test.
2. Make the manual clock implement the new foundation time seam. It should support
   deterministic now/advance behavior and a controlled sleeper for polling
   tests, not merely a mutable Date.now substitute.
3. Move observer session/registration builders out of the observer-local
   helper. Make defaults valid, deterministic, and easy to override without
   duplicating a full InstanceRegistration object.
4. Provide a test wait helper only where it delegates to the foundation polling
   contract. Do not add another hand-written waitFor loop.
5. Migrate in reviewable groups: foundation/observer unit tests first,
   Workbench unit tests second, then integration tests where the helper is
   appropriate. Preserve an explicit exception for tests that require a real
   OS-created directory, child process, or cleanup timing as the assertion.
6. Delete the old observer-local helper or leave a short forwarding module for
   one migration boundary only. Do not maintain two fixture implementations.

**Tests:**

- temporary roots are removed after success, assertion failure, and rejected
  async work;
- two concurrent tests receive distinct roots;
- fake clock/sleeper drives deadline and abort tests without wall-clock waits;
- fixture builders produce protocol-valid defaults and preserve explicit
  overrides;
- representative observer and Workbench tests migrate with no loss of their
  domain assertion.

**Acceptance:** Ordinary tests no longer import node temporary-directory APIs
directly. Any remaining raw call has a documented behavioral reason and is
listed as a narrow architecture-check exception.
