# Repository line-ending policy implementation guide

**Status:** Deferred standalone prerequisite  
**Parent context:** [Cross-cutting consolidation implementation guide](2026-07-19-cross-cutting-consolidation-implementation-guide.md)  
**Research snapshot:** 2026-07-19, against the active working tree  
**Entry condition:** Perform this in a clean, isolated worktree after unrelated
changes have been committed or moved elsewhere. It must be complete before
Cross-cutting consolidation Task 0 starts.

## Outcome

The repository has one explicit default text-classification rule while retaining
the existing binary add-on and protocol-artifact exceptions. The change is
reviewable as an isolated line-ending commit, rather than being hidden among
generated artifacts, package changes, or feature work.

The intended root `.gitattributes` policy is:

```gitattributes
* text=auto

observer/addon/** -text
observer/workbench-addon/** -text
observer/protocol/generated/** text eol=lf
...
```

`* text=auto` is a classification default. It is not a repository-wide
instruction to check out every text file with LF endings.

## Scope and fixed decisions

1. Add `* text=auto` as the first rule in the repository-root
   `.gitattributes` file.
2. Retain the `observer/addon/** -text` and
   `observer/workbench-addon/** -text` exceptions exactly. Workbench-owned
   payloads must not be normalized as text.
3. Retain every existing targeted `text eol=lf` protocol rule.
4. Do not add a blanket `eol=lf`, `eol=crlf`, `working-tree-encoding`, or
   `ident` rule.
5. Do not change generated artifacts, package contents, source code, or
   documentation content as part of the line-ending commit.
6. Do not use this change to "fix" unrelated whitespace. Any content change
   requires its own review and commit.

## Preconditions and baseline

1. Create or select an isolated worktree. Its status must be clean before the
   attribute edit; do not stash, reset, or overwrite another contributor's
   work to make it clean.
2. Record the current Git version, platform, and `core.autocrlf` and
   `core.eol` values. These values explain a checkout result but must not be
   changed by this task.
3. Record the current attributes for representative paths:

   ```powershell
   git check-attr -a -- .gitattributes package.json src/index.ts
   git check-attr -a -- observer/addon/.reforger-forge-observer-source.json
   git check-attr -a -- observer/workbench-addon/.reforger-forge-workbench-helper-source.json
   git check-attr -a -- observer/protocol/generated/README.md
   git check-attr -a -- observer/protocol/errors.md
   ```

   Substitute an existing generated-file path if `README.md` is not present.
   The baseline must include an ordinary text file, one path under each
   Workbench add-on root, and both a generated and a hand-authored protocol
   artifact.
4. Record `git status --short` and confirm no local tool output is already
   staged. Keep the command output with the review evidence.

## Implementation tasks

### LE-0: make the smallest attribute change

1. Add `* text=auto` as the first line of the root `.gitattributes` file.
   Keep the existing ordering and spelling of all following rules unless a
   review proves an independent correction is necessary.
2. Inspect the unstaged diff. It should contain only the one added default
   rule in `.gitattributes`.
3. Re-run the representative `git check-attr -a` commands. Confirm ordinary
   source and documentation paths are classified as text; confirm both
   add-on paths remain `-text`; confirm protocol rules retain `eol=lf`.

**Acceptance:** Attribute resolution proves the default text rule does not
override any existing binary/add-on or protocol-artifact exception.

### LE-1: renormalize and audit the index

1. In the isolated worktree only, stage the policy and let Git identify any
   canonical-content normalization it requires:

   ```powershell
   git add --renormalize -- .
   ```

2. Inspect the staged change before making a commit:

   ```powershell
   git diff --cached -- .gitattributes
   git diff --cached --check
   git diff --cached --stat
   git diff --cached --numstat
   ```

3. For every staged path other than `.gitattributes`, inspect the exact diff
   and prove it is only a reviewed canonical line-ending normalization. Do
   not accept a path merely because it is large or generated. In particular,
   verify that no path below either `observer/addon/` root has been staged by
   normalization.
4. If an unexpected content change appears, unstage only that known path,
   investigate its attributes and source bytes, and stop the task if the
   cause cannot be resolved without expanding scope. Do not use a broad reset
   or checkout command against the worktree.

**Acceptance:** The staged diff contains the attribute rule and only audited
canonical-content normalization; `git diff --cached --check` is clean; no
Workbench-owned `-text` payload is staged.

### LE-2: commit and cross-platform checkout proof

1. Commit the staged change by itself, using a focused message such as:

   ```text
   chore: establish repository text attribute policy
   ```

2. Test a fresh Windows checkout and a fresh non-Windows checkout at that
   commit. On each platform, verify:

   ```powershell
   git status --short
   git check-attr -a -- package.json
   git check-attr -a -- observer/addon/.reforger-forge-observer-source.json
   git check-attr -a -- observer/protocol/errors.md
   ```

3. Both checkouts must have an empty status after normal read-only setup. The
   Windows result must also prove that the add-on payload remains non-text and
   the protocol document remains explicitly LF.
4. Add the commit SHA, platform results, staged-diff audit, and any legitimate
   normalization paths to the review or retained validation evidence.

**Acceptance:** Fresh supported-platform checkouts are clean and have the
intended attribute resolution without a contributor-specific Git setting being
required to mask changes.

### LE-3: remove completed-task references from planning Markdown

After LE-2's evidence is accepted, make a separate documentation-maintenance
commit that removes this completed prerequisite rather than leaving it marked
as done:

1. Remove the `## Pre-step: establish the repository line-ending policy`
   section from
   `docs/plans/2026-07-19-cross-cutting-consolidation-implementation-guide.md`.
2. Remove `### Isolate the line-ending normalization commit` from
   `docs/plans/OUTSTANDING.md`.
3. Retain this implementation guide as the historical decision and execution
   record, unless the repository's documentation-retention policy later
   supersedes it.
4. Verify the remaining cross-cutting guide begins with Task 0 and no planning
   Markdown still presents the line-ending work as outstanding.

**Acceptance:** Completed work is removed from active and deferred task lists;
the standalone guide remains the discoverable record of what was reviewed and
validated.

## Validation summary

Before declaring the work complete, retain all of the following:

- a clean isolated-worktree baseline;
- representative before/after attribute-resolution output;
- an audited staged diff and a clean `git diff --cached --check` result;
- the isolated commit SHA; and
- clean fresh-checkout results from Windows and a non-Windows environment.

Do not run the Cross-cutting consolidation Task 0 baseline as a substitute for
this validation. This guide is its prerequisite.

## Completion criteria

This work is complete only when:

- the repository-root `.gitattributes` begins with `* text=auto`;
- existing `-text` and targeted LF exceptions are unchanged and effective;
- any normalization is narrowly audited with no content edits or Workbench
  payload changes;
- fresh Windows and non-Windows checkouts are clean; and
- the completed line-ending task has been removed from the cross-cutting and
  outstanding planning Markdown as described in LE-3.
