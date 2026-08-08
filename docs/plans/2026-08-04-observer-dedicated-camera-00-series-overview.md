# Step 0: dedicated runtime-camera series overview

> **Execution constraint:** Do not launch Enfusion Workbench or the game client
> while carrying out this plan. If testing reaches a point that requires either,
> stop before launching it and wait for explicit confirmation that it is
> available for use.

> **Document role:** Series-wide navigation and sequencing metadata only. This
> is not an implementation task and does not produce a commit.

## Series map

The implementation should not be one commit. Use this order:

1. [Fix active-view resolution](2026-08-04-observer-dedicated-camera-01-active-view-resolution.md).
2. [Add the default-inert engine qualification harness and pass the manager
   gate](2026-08-04-observer-dedicated-camera-02-engine-qualification.md).
3. [Make lease binding and outstanding-restoration status explicit without
   changing camera behavior](2026-08-04-observer-dedicated-camera-03-lease-obligation-model.md).
4. [Implement the complete manager-owned dedicated-camera
   transaction](2026-08-04-observer-dedicated-camera-04-manager-transaction.md).
5. [Optionally add narrowly qualified editor self-reselection
   recovery](2026-08-04-observer-dedicated-camera-05-qualified-reselection-recovery.md).
6. [Separate stable support from per-attempt readiness and wait in
   `RESOLVING`](2026-08-04-observer-dedicated-camera-06-capability-and-resolving.md).
7. [Add native restoration/takeover fault
   acceptance](2026-08-04-observer-dedicated-camera-07-restoration-fault-acceptance.md).
8. [Publish final operator
   documentation](2026-08-04-observer-dedicated-camera-08-operator-documentation.md).
9. [Optionally implement detached-camera hand-back after its separate
   gate](2026-08-04-observer-dedicated-camera-09-detached-follow-up.md).

Items 5 and 9 are omitted when their live gates do not pass. The manager
release does not depend on detached-camera support.

Each numbered document is the authoritative implementation task for that step,
including its own scope, validation, and acceptance criteria.
