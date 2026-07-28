# MCP Problem Tracking

These files are the source-backed record for problems found in the public MCP
contract: runtime behavior, registered schemas and descriptions, prompts,
configuration, packaging, and current operator guidance.

Tracker ownership follows the affected MCP, not the caller's working
directory. Record a ReforgerForge MCP problem here when it is discovered from
any sibling project, mod, or task in the containing monorepo. Problems in a
consumer project's own code or content belong to that project's tracker.

| Class | Open queue | Closed history |
|---|---|---|
| Bugs | [MCP_BUGS.md](MCP_BUGS.md) | [MCP_BUGS_RESOLVED.md](MCP_BUGS_RESOLVED.md) |
| Issues | [MCP_ISSUES.md](MCP_ISSUES.md) | [MCP_ISSUES_RESOLVED.md](MCP_ISSUES_RESOLVED.md) |

Use **bugs** for an unintended, reproducible failure of the supported
contract, including a mismatch between implementation and advertised API.
Use **issues** for an open contract decision, an acknowledged limitation, or a
deferred improvement that is not currently a broken supported behavior. When
classification is uncertain, record an issue and state the uncertainty.

## Ordering and lifecycle

- All four files share one permanent ticket namespace: `MCP-NNN`, using at
  least three zero-padded digits. Before assigning an ID, search every open and
  resolved tracker and choose the next unused number. Do not use subsystem
  prefixes such as `DEV-`, `PKG-`, or `OBS-`.
- Open files are FIFO queues: append each new entry at the bottom. Never
  insert a new finding ahead of older work.
- Closed files are reverse chronological: move a resolved or verified entry to
  the top of the corresponding history and record its closure date and
  validation evidence.
- Retain an entry's identifier when moving it. Search both its open queue and
  history before opening a duplicate.
- Do not close an entry merely because prose changed. For a contract problem,
  the schema/description, handler behavior, focused tests, and current
  guidance must agree.

## Entry minimums

Each entry needs an `MCP-NNN` ID, status, severity or priority when meaningful, the
observed behavior, expected contract or decision needed, affected files or
tools, and links to evidence. A close-out additionally records the validation
that established the result.

When a coding agent finds a problem, it must add the entry before finishing the
related work and tell the user that the problem was found and documented,
including the entry ID and tracker path. It must do the same when it resolves
or reclassifies an existing entry.
