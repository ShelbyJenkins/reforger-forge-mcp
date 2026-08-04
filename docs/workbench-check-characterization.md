# Workbench Enforce Script check characterization

MCP-052 was characterized on 2026-08-03 with Arma Reforger Workbench
1.7.0.54. The guarded live harness used a private managed profile, exact
owner-token log attribution, one valid fixture, one syntax-broken fixture, and
an absent configuration preflight.

## Selected launch contract

The proven argument shape is:

```text
-addonsDir <dependency-and-target-roots>
-profile <private-managed-profile>
-noThrow
-gproj <exact-absolute-gproj>
-gprojConfig <configuration>
-reforgerForgeOwnerToken=<private-token>
-wbsilent
-wbModule=ScriptEditor
-validate <configuration>
```

`-wbsilent` must remain before `-wbModule`: arguments after the module selector
are module-specific. `-run` is not needed for validation and is intentionally
absent. The foreground child is still spawned with the hidden/no-shell Windows
policy and is supervised through exact PID, executable, creation-time, and
owner-token identity.

## Observations

| Case | Native result | Windows/Node result | Compilation evidence | Window evidence |
|---|---:|---:|---|---|
| Valid `PC` | `0` | `0` | `compiled` | No visible windows observed. |
| Broken `PC` | `-1` | `4294967295` | `PROJECT_COMPILE_FAILED`, module `Game`, exact `script.log` diagnostic | Workbench 1.7.0.54 briefly exposed one top-level Qt tool window titled `Arma Reforger Workbench` despite `-wbsilent -noThrow`. |
| Absent configuration | not spawned | not spawned | `INVALID_TARGET` preflight | No process-count change. |

The broken fixture diagnostic was:

```text
Scripts/Game/RFO_MCP052_Broken.c(5): Expected ',' or ')', not a '52'
```

The runner classifies the unsigned Windows representation of native `-1` as
an ordinary nonzero compiler exit, retains `4294967295` in the JSON receipt,
and maps it to portable CLI exit code `1`. Other native nonzero statuses remain
distinct and are not inferred to be compiler failures without an exact
attributed compiler log.

Both fixture runs automatically exited, left the lifecycle and endpoint
vacant, changed no fixture source bytes, and produced no build-output tree.
Normal Workbench project initialization created the repository-ignored
`resourceDatabase.rdb` project cache in each fixture; the acceptance harness
records and removes those exact fixture caches. This cache is not the fresh,
caller-selected build output created and attested by `wb_build`.

The selected switches and their intended semantics follow Bohemia's
[official Workbench startup-parameter reference](https://community.bistudio.com/wiki/Arma_Reforger%3AStartup_Parameters).
