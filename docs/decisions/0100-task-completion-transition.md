# ADR 0100: member completion means awaiting approval

Status: accepted on the planning branch.

`/task complete` marks a task `awaiting_approval`, never `done`. A team task may be marked by a current team member or current lead. An individual task may be marked by its named assignee. A configured president can also submit a completion request for a team they can currently access, but not impersonate an individual assignee. The invoking Discord identity comes from the interaction, is fetched live, and is checked against the stored team membership and live team category; role names never grant access. A completion request on a `done` or archived task fails; one already awaiting approval returns its existing state without another write. The row update is a versioned compare-and-swap, so a replay or concurrent edit does not silently overwrite the other write. The guild-scoped pipeline deduplicates the interaction ID before the handler. No post, reminder or automatic approval follows the transition. Approval still needs a separate live-role-gated, audited workflow.

A successful transition records a guild-scoped audit row with the invoking Discord member and before/after status in the same storage transaction as the task update. Failed and duplicate attempts do not write a success row. The slash handler replies ephemerally. This audit is distinct from a future approval audit.
