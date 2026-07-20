# Task 1 redaction migration ledger

The shared owner is `src/foundation/redact.ts`. Operational values remain raw
until a caller formats a log, error, receipt, or portable evidence artifact.

| Sink | Decision | Replacement spelling |
| --- | --- | --- |
| Agent stderr logger | Diagnostic text and structured-value boundary | `[REDACTED]` |
| Observer child stderr/startup/response diagnostics | Diagnostic text boundary | `[REDACTED]` |
| Observer application shutdown logs and error details | Diagnostic boundary | `[REDACTED]` |
| Supporting evidence logs | Diagnostic boundary before export formatting | `[REDACTED]` |
| Owned-runtime diagnostics | Command-argument boundary | `[owner-token-redacted]` |
| Workbench CLI and validation receipts | Command-argument text boundary | `[redacted]` |
| Workbench session launch log | Token-preserving argument boundary | `[owner-token-redacted]` |
| Workbench NET API status | Existing dynamic-token collection plus diagnostic boundary | `[redacted]` |
| Operational baseline argument identity | Evidence-portability arguments | `<redacted>`, `<absolute-path>`, `<absolute-path-list:N>` |
| Build-acceptance console output | Diagnostic then command-argument boundary | `<redacted-path>`, `<redacted>` |
| Enforce controlled artifacts | Evidence-portability boundary plus exact artifact-path labels | `<redacted>`, `<steam-id>` |
| `application-operations.ts` projection | Retained: operational field omission, not a diagnostic sink | n/a |
| Mailbox coordinator and run state | Retained: operational state, not presentation output | n/a |

Focused tests cover bearer credentials, authorization values, nonces, owner
arguments, contract bodies, nested and opaque dynamic tokens, drive/UNC paths,
all-absolute lists, Steam IDs, safe controls, bounded recursion, accessors,
cycles, idempotence, and redaction-before-truncation.

Validation completed: `npm test`, `npm run build`, `npm run protocol:check`,
and the packed `--omit=dev` installation smoke test (including the compiled
mailbox acceptance import). Live controlled Workbench checks remain skipped
because this workspace has no configured live Workbench environment.
