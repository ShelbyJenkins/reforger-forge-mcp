# Tar package-archive verification implementation guide

**Status:** Proposed follow-on work  
**Parent context:** [Cross-cutting consolidation implementation guide](2026-07-19-cross-cutting-consolidation-implementation-guide.md), Task 4  
**Research snapshot:** 2026-07-19, against the active working tree  
**Entry condition:** The source-manifest contract is implemented or scheduled for the same review boundary. This guide does not redefine that contract.

## Outcome

Package verification treats the npm-produced tarball as the authoritative
artifact. It reads both observer add-on manifests from that archive, validates
their declared payloads against the archive entries, and fails closed on an
unexpected or unsafe archive layout.

Use the maintained Node tar library as a development dependency. Its archive
reader replaces any need to implement tar or gzip parsing in package checks.
The project still owns its manifest schema, path policy, digest policy, and
package-content contract.

## Scope and fixed decisions

1. Add tar as a pinned development dependency. The package checker is a
   repository verification script; it is not an installed-server runtime
   dependency.
2. Keep npm pack --json only to obtain the exact tarball filename. Do not use
   its reported file inventory as evidence that the archive is valid.
3. Read archive entries directly. Do not extract an untrusted tarball to a
   temporary directory merely to inspect it.
4. Treat the two archive-resident source manifests as the sole inventory
   authority for their corresponding add-on payloads:

       package/observer/addon/.reforger-forge-observer-source.json
       package/observer/workbench-addon/.reforger-forge-workbench-helper-source.json

5. A regular payload file must be declared exactly once by the manifest for
   its add-on. The manifest itself and explicitly documented generated
   resource-database exception remain the only permitted extras.
6. Preserve the existing fresh --omit=dev installation smoke test. Tarball
   inventory validation supplements it; it does not replace installation.

## Non-goals

- Do not add a general package-extraction API to the product.
- Do not trust a source-checkout manifest while checking a tarball.
- Do not make an archive parser responsible for add-on manifest semantics.
- Do not change what npm includes in the package merely to simplify this
  inspection.
- Do not use this work to normalize unrelated package-check assertions.

## Starting-point inventory

The current package checker invokes npm pack --json, obtains the produced
tarball path, and uses npm's JSON report for its file set before installing the
tarball. The source-manifest updater independently walks add-on source
directories and rejects links. Record the current behavior before changing it.

Run:

    rg -n "npm pack|report\[0\]|files = new Set|tarballPath" scripts/check-package.mjs
    rg -n "function visit|lstatSync|resourceDatabase.rdb" scripts/update-observer-source-manifest.mjs
    npm run test:package

Retain a representative packed tarball only in a controlled temporary
directory or test fixture; do not commit an npm artifact.

## Target boundary

Add a small repository-only helper, for example
scripts/lib/packed-archive.mjs. Its API should remain independent of the
observer domain:

    export async function inspectPackedArchive(options) {
      // options: tarballPath, packagePrefix, maximumEntryBytes
      // result: normalized regular-file paths and bounded text for requested entries
    }

    export async function readPackedTextEntry(options) {
      // options: tarballPath, entryPath, maximumBytes
      // result: exact UTF-8 text, or a typed inspection failure
    }

The helper must:

- accept a canonical tarball path under the package-check temporary root;
- inspect entries through tar's read API, without extraction;
- allow one package root prefix, normally package/;
- normalize separators and reject empty, absolute, traversal, duplicate, or
  case-colliding payload paths;
- allow only regular files and directories for the inspected payload tree;
- reject symbolic links, hard links, devices, fifos, and other special entries;
- bound the bytes collected for every manifest text entry before decoding;
- require each requested manifest entry to occur once; and
- surface typed, bounded diagnostics suitable for the package-check script.

Archive metadata is untrusted input, even though npm produced the first-party
artifact. The package checker must not follow archive paths, create arbitrary
files, or accept a second manifest because one happens to parse.

## Implementation tasks

### TAR-0: freeze the package contract

1. Record the existing npm pack --json report, current required-file
   assertions, and the fresh installed-package smoke-test result.
2. Add focused tests that characterize the current two manifest locations,
   generated-resource exception, and expected add-on payload roots.
3. Decide the maximum manifest byte bound from the source-manifest validator;
   use the same or a stricter bound for archive reading.
4. Do not remove existing required-file assertions in this task. They protect
   non-add-on package content that source manifests do not describe.

**Acceptance:** A reviewer can distinguish package-wide required files from
the two manifest-governed add-on payload inventories.

### TAR-1: introduce and prove the pinned dependency

1. Add tar with an exact reviewed version to devDependencies and regenerate
   package-lock.json.
2. Confirm the package supports the repository's Node 20 baseline and its ESM
   usage in the current TypeScript/Node configuration.
3. Run a clean dependency install, the build, and the existing package smoke
   test on Windows.
4. Record the package license and the dependency's transitive footprint in the
   review. Do not use a floating range for this first adoption.

**Acceptance:** The lockfile is current, the repository scripts can import the
package, and the normal packed application does not gain a runtime dependency
on a repository-only archive checker.

### TAR-2: implement bounded, non-extracting archive inspection

1. Implement the helper's path and entry-type validation before adding
   observer-specific logic.
2. Consume each manifest entry as a bounded stream. Stop and fail on an entry
   that exceeds the configured limit instead of buffering it without bound.
3. Verify how the selected tar version reports PAX headers, GNU long paths,
   directory entries, and link entries. Normalize only final logical file
   entries; do not mistake metadata entries for payload.
4. Build fixtures that contain duplicate paths, traversal spelling, an
   absolute spelling, a link, an oversized manifest, a missing manifest, and
   two copies of one manifest.
5. Verify the helper neither writes archive contents nor accepts an entry that
   would be ambiguous on Windows' case-insensitive filesystem.

**Acceptance:** The helper produces a deterministic inventory for a valid
fixture and fails closed for every malformed or unsafe fixture.

### TAR-3: make the packed manifests authoritative

1. After npm pack completes, use the helper to enumerate the tarball's regular
   files and read both archive-resident manifests.
2. Pass each parsed manifest through the shared source-manifest validator from
   Task 4. Do not introduce a second manifest schema in check-package.mjs.
3. For each add-on root, compare the normalized archive payload set with the
   manifest's declared paths. Verify every declared file is present, every
   packaged payload is declared, and every declared digest still matches the
   archive bytes.
4. Keep the generated resourceDatabase.rdb exception narrow and contextual:
   it may be allowed only where the existing staging/package contract permits
   it, never as a wildcard for arbitrary binary files.
5. Delete only the report[0].files assertions that duplicate this
   archive-and-manifest proof. Retain explicit checks for dist, configuration,
   documentation, and executable entry points.

**Acceptance:** Modifying the source checkout after npm pack cannot influence
the add-on inventory result, and a packed undeclared or missing payload fails
the package check.

### TAR-4: test the complete package path

1. Add fixtures for a valid archive and each TAR-2 rejection. Keep fixtures
   small and construct them during tests where practical.
2. Add a regression test that deliberately changes a source manifest after
   packing; the checker must continue to use the archive version.
3. Add a regression test that injects an undeclared add-on payload into a
   tarball fixture and confirms failure.
4. Add a regression test that modifies one payload byte while preserving the
   manifest and confirms the digest failure is attributed to the archive.
5. Run the fresh --omit=dev installation smoke test unchanged after inventory
   verification.

## Validation

Run the focused archive-helper tests first, then:

    npm ci
    npm run protocol:check
    npm run observer:manifest:check
    npm run build
    npm test
    npm run test:package

The observer:manifest:check command is a Task 4 outcome. Until it exists, run
the current manifest generation/check workflow and record that limitation
explicitly. Test package verification on a clean Windows checkout because npm,
path casing, and executable handling are part of the contract.

## Completion criteria

This follow-on is complete when:

- tar is pinned, locked, and used only by repository verification tooling;
- the actual npm tarball, rather than npm's JSON report or the source tree,
  supplies both add-on manifests and payload entries;
- unsafe archive paths, links, duplicate manifests, oversize manifests,
  undeclared payloads, missing payloads, and digest drift fail closed;
- the existing package-wide required-file and fresh-install proofs remain;
- package checks have no duplicated hand-maintained add-on filename list; and
- build, focused tests, full tests, and package smoke tests are green.

