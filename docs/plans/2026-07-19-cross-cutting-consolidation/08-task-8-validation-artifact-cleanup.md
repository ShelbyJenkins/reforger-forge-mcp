# Task 8 — Validation-artifact cleanup

**Status:** Planned follow-on work
**Parent context:** [Cross-cutting consolidation implementation guide](README.md), Task 8
**Sequencing:** Perform only after the other consolidation validation has been
reviewed; this task removes repository artifacts and changes default evidence
locations.

## Intended outcome

Validation receipts, screenshots, logs, and package-smoke evidence are local,
sanitized, and external to the repository. A clean checkout neither contains
nor recreates `docs/validation/` by default.

## Planned work

1. Ignore `docs/validation/` at the repository root immediately.
2. Change scripts, tests, and documentation to require an external evidence
   root or create a fresh OS-temporary directory by default.
3. Update hermetic tests to prove ordinary runs do not create a repository
   validation directory.
4. After retained claims are reviewed, remove tracked validation artifacts and
   stale references without relocating machine-local evidence into the repo.

## Completion signals

- `git ls-files docs/validation` returns no paths.
- `git check-ignore docs/validation/example.json` confirms the ignore rule.
- Clean checkout, package contents, and default validation runs contain no
  repository validation artifact.
- Maintainers can still choose an explicit external evidence location.


## Detailed task plan

**Goal:** Validation artifacts are local, temporary evidence—not repository
content or release documentation.

**Actions:**

1. Keep `docs/validation/` in the root `.gitignore` immediately. New logs,
   receipts, screenshots, package-smoke reports, and live-acceptance evidence
   under that path must remain untracked and must never be staged or committed.
2. Audit every script, test, and document that currently defaults to
   `docs/validation`. Change production and local-acceptance defaults to a
   caller-selected external evidence root or a fresh directory beneath the OS
   temporary root. Retain an explicit path option for a maintainer who needs
   to preserve sanitized evidence outside the repository.
3. Update the related hermetic tests so they use temporary roots and prove no
   default execution creates a repository `docs/validation` directory.
4. After all retained claims have been reviewed, delete the existing tracked
   `docs/validation/` directory and remove every tracked artifact beneath it.
   Do not copy its machine-local evidence to another repository location.
5. Update documentation and package checks to describe validation evidence as
   external and uncommitted. A final source search must find no production
   default or user instruction that writes validation artifacts into the
   repository.

**Acceptance:** `git ls-files docs/validation` returns no paths;
`git check-ignore docs/validation/example.json` confirms the ignore rule; a
clean checkout has no `docs/validation` directory; package contents contain no
validation artifact; and the validation harnesses retain evidence only in an
external or OS-temporary location.
