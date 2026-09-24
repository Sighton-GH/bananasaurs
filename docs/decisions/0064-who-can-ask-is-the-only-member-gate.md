# 0064. "Who can ask" is the only member gate

Date: 2026-09-23
Status: accepted (owner decision 2026-09-23)

## Context

A member request passed two independent gates in
`apps/daemon/src/assistant/service.ts`:

1. The behaviour's caller roles (`callerRoleIds`). The Assistant page edits
   these as "Who can ask".
2. A per-skill grant (`assistant_skill_grants`). The setup tracker writes these
   once through "Grant everyday skills" for the roles chosen at that moment,
   and the Skills page edits them one skill at a time.

Adding a role to "Who can ask" later did not add it to any grant. The owner
allowed the Operations role on a behaviour, and an Operations member was still
refused with "You do not have a matching grant for this assistant skill".
Nothing on the page they had just edited explained why.

## Decision

A member who passes a behaviour's "Who can ask" may use every skill in that
behaviour's allowlist. Owner-only skills stay owner-only. The owner passes
every gate, as before.

- `assistant_skill_grants` is no longer consulted on the request path. The
  table is kept and its rows are left untouched, so the decision can be
  reversed without data loss. The Skills page stops editing grants and states
  the rule instead.
- The setup tracker's skills step is done when a behaviour allows at least one
  skill. Turning a behaviour on stays its own step.
- Confirmation-class skills (reminders, decisions, memory proposals) keep their
  own confirmation step. What they are allowed to do does not change; only who
  may ask for them.
- A member refused on a role tag gets a visible reply (see ADR 0063's routing)
  instead of silence.

## Consequences

One setting answers "who can use this". To limit a sensitive skill to a
smaller group, the owner makes a separate behaviour with a narrower "Who can
ask" and that skill in its allowlist.
