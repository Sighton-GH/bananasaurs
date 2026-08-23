# Reviewing Claude Code's output

The bottleneck on this project is not how fast code gets written. It is how well it gets reviewed. An agent that writes faster than you can review produces a codebase you do not understand, which is worse than no codebase.

This is the checklist. It is short on purpose — a checklist you actually run beats a thorough one you skip.

---

## Reviewing a plan (Phase 2)

**Are the safety controls in the architecture or at the call sites?**

This is the single most important question in the whole project. If the rate limiter is something each handler remembers to call, a handler written six months from now will forget it, and nothing will fail loudly. If it sits inside the one path every role mutation must pass through, forgetting is impossible.

Ask: *what would happen if someone added a new feature that mutates roles and forgot about the safety controls entirely?* If the answer is "it would work fine and bypass everything," the design is wrong regardless of how good the code looks.

**Is the guild scope structural or conventional?**

"Every query takes a guild ID" is a sentence a plan can contain while permitting queries that don't. Look for repository function signatures that *require* it and database constraints that enforce it. A query that *can* omit guild scope is a bug even if every current caller passes it.

**Does the SQL exist, or just a description of SQL?**

`CHECK` constraints, `UNIQUE` indexes, and `NOT NULL` are checkable. "We enforce idempotency" is not. If a plan describes intent where it could show a constraint, ask for the constraint.

**Is the single-writer discipline real?**

SQLite allows exactly one writer. With a background job worker and interactive commands in one process, the plan needs a named mechanism — one writer object, one serialised queue, something you can point at. "We're careful about writes" will produce `SQLITE_BUSY` errors at the worst moment.

**Is it building ahead?**

Scaffolding for a provider router, a module runtime, or a second dashboard page during Release 1 is a guess about requirements you have not discovered. Guesses are wrong and hard to delete. Cut them.

---

## Reviewing a diff (Phase 3)

Four questions, every time:

1. **Does every new query take a guild ID?**
2. **Does every new Discord side effect have a durable idempotency key and a unique constraint making double execution impossible?**
3. **Does any untrusted input reach an execution path without a Zod validator?** Untrusted means: Discord messages, model output, HTTP request bodies, config files, anything from outside.
4. **Would each new test fail if the implementation were broken?**

Question 4 catches the most common failure in agent-written tests. They drift toward asserting *that a mock was called with the right arguments* rather than *that the behaviour is correct*. Those tests pass forever regardless of whether the feature works, and they give you a green suite that means nothing.

The cheap fix, which is built into the kickoff prompt: make Claude break the implementation deliberately, confirm the tests fail, then restore it. If it can't make a test fail, the test isn't testing.

---

## Things specific to this project that are easy to get wrong

| Trap | What to check |
|---|---|
| Reactions silently ignored | `partials` enabled for Message, Channel, Reaction, User. Without it, reactions on uncached messages produce no event at all. |
| Panel appears dead after a restart | Reconciliation runs on reconnect; reactions added while offline generate no replay event. |
| Role changes fail confusingly | Hierarchy checked immediately before every mutation, not just at startup. |
| A repair pass becomes a mass role change | Reconciliation computes the full change list first and refuses if it exceeds the budget. |
| Deletion log lies about who did it | `MESSAGE_DELETE` carries no actor. Audit-log correlation is inferred, delayed, and absent for self-deletions. It must be labelled inferred everywhere it appears. |
| `/mod purge` hangs | Bulk delete only reaches messages under 14 days old, 100 per call. Anything larger is a background job. |
| Timeout silently fails | Discord caps timeouts at 28 days. The parser must clamp or reject. |
| Interaction times out | 3 seconds to acknowledge, 15 minutes to follow up. Defer immediately, then edit. |
| Dev run touches the club server | Guild allowlist contains only the test guild ID in the dev `.env`. |

---

## Session hygiene

- **`/clear` between slices.** Long sessions degrade — the agent contradicts decisions it made earlier and burns context re-reading files. A fresh session plus a written plan is better than a marathon.
- **Commit at every green checkpoint**, with a message you approved. Small commits are how you bisect a bug an agent introduced.
- **Prefer reverting to arguing.** `git checkout .` plus a better prompt beats five rounds of "no, not like that." Agents anchor on their earlier attempt.
- **Never run with permissions bypassed.** No `--dangerously-skip-permissions`. That flag is for throwaway containers.
- **Read commands before approving them**, especially anything with `sudo`, `rm`, or a path outside the repo. The deny list is pattern matching; the permission prompt is the real control.
- **`npm install` is the realistic supply-chain risk.** Postinstall scripts run as your user. Check package names for typos before approving.
- **Run `/security-review` before every release cutover**, and before the bot first touches the real club server.

---

## When to stop and think

Three signals that the session is going wrong and you should `/clear` and restart with a better prompt rather than push on:

- The agent is explaining why something is hard instead of doing it.
- You've said "no, not like that" twice about the same thing.
- The diff is much bigger than the slice warranted.

None of those are failures. They mean the framing was wrong, and framing is cheap to redo.
