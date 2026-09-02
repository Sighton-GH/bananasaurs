# Delegating to subagents, and spending context well

How Claude Code should split work between the session that coordinates and the
subagents that do the work. Written 2026-09-01 after executing Slice 0 of
Release 2 this way; every rule below has a concrete failure or saving from that
run behind it, cited inline.

**The scarce resource is the coordinating session's context, not the number of
model calls.** A coordinator that reads six task diffs, three reports and a
migration in full has nothing left to notice cross-cutting problems with. A
coordinator that reads *conclusions* keeps its judgement. Delegation is how you
buy that, and the rules below are what stop it costing more than it saves.

---

## What to delegate, and what never to

**Delegate:**

- Implementation from a written brief, where the requirements are already
  decided and the work is transcription plus testing.
- Noisy investigation — grep sweeps, log trawls, "where does X get wired up",
  anything whose output is a paragraph but whose process is fifty tool calls.
- Code review. A reviewer that did not write the code is worth more than one
  that did, and its reading of the diff stays out of the coordinator's context.

**Keep in the coordinating session:**

- **Decisions.** Anything that changes authorisation, privacy, retention, cost,
  or external side effects is the owner's or yours — never a subagent's,
  because a subagent cannot weigh it against the project's history.
- **Verification of anything that matters.** Run the gates yourself. See
  "Trust nothing you did not verify" below.
- **Rulings.** When a reviewer and a plan disagree, the coordinator decides and
  records why. Delegating that produces churn, not resolution.

---

## Model selection

Use the least capable model that will do the job, and specify it explicitly on
every dispatch — an omitted model inherits the coordinator's, which is usually
the most expensive one.

| Work | Model |
| --- | --- |
| Implementation from a brief containing the actual code | cheapest tier |
| Multi-file integration, pattern-matching against existing code | mid tier |
| Code review, scaled to the diff's risk | mid tier; strongest for a whole-branch review |
| Architecture, design, whole-branch review | strongest |

**Turn count beats token price.** The cheapest model taking three times as many
turns costs more in wall-clock and in coordinator context than a mid-tier model
getting it right first time. Use the cheap tier when the brief contains the code
to write; use mid tier when the subagent must work from prose.

---

## Hand work over as files, never as prose in the prompt

Everything pasted into a dispatch prompt, and everything a subagent prints back,
stays in the coordinator's context for the rest of the session and is re-read on
every later turn. So:

- **Extract the brief to a file** and pass the path. Never paste a whole plan
  into a prompt, and never paste "state after tasks 1-3" history into task 4 —
  a fresh subagent needs its own task, the interfaces it touches, and the
  global constraints. Nothing else.
- **Give the subagent a report path** and tell it to write detail there and
  return only: status, commit SHAs, a one-line test summary, and concerns. Five
  lines back, not five hundred.
- **Hand reviewers a diff file**, generated once, rather than having them
  re-derive it with git commands whose output lands in your context.

## Subagents do not dispatch subagents

Say so in every dispatch. A worker that spawns its own reviewer duplicates the
review the coordinator is about to run — a whole extra seat, reviewing the same
diff, whose findings arrive twice.

---

## Commit after each unit of work

A fix pass in this run was killed mid-job by a rate limit with **nothing
committed**, losing the whole attempt. The retry was told to commit after each
finding and lost nothing. Tell every subagent to commit incrementally, and to
commit-and-report-partial rather than lose work if it runs low on capacity.

---

## Trust nothing you did not verify

This is the rule that earns its keep, and this run produced four separate
demonstrations:

1. **An exploring subagent reported that no `AutoModerationExecution` intent bit
   exists.** It does — `2097152`. The claim was hedged and wrong, and had it
   been believed, the slice's central mechanism would have been designed around
   a falsehood.
2. **A plan asserted a compile-time exhaustiveness gate that did not exist.**
   The claim came from a subagent's summary and was repeated into an ADR without
   testing. Falling off the end of a `string | undefined` function is legal
   TypeScript.
3. **A test written to guard a byte-level invariant could not detect the change
   it existed to catch** — a one-element `join` never reads its separator. It
   looked correct and was decorative.
4. **A fix that reads as more principled was measurably worse.** Given two
   candidate repairs to the keyword matcher, the elegant one (normalise both
   sides into one space) introduced false positives; the pragmatic one scored
   10/10. Probing ten cases before writing code chose correctly; reasoning would
   have shipped the wrong one.

Practically, that means:

- The coordinator re-runs `npm run typecheck && npm run lint && npm run test`
  itself before believing "all green".
- A claim about a library is checked against the library, in this repo's
  `node_modules`, not from memory.
- A guard is not trusted until it has been **watched failing**. Temporarily
  break the thing it protects, confirm it goes red, restore. Both of this run's
  real guards were proven this way.
- Before dispatching a reviewer, confirm the diff package actually contains the
  code to review. One package here rendered the slice's most important file as
  `Binary files … differ`; the review would have been vacuous.

---

## Review is layered because no single layer catches everything

Slice 0 found six defects. Each was caught by a different layer, and no layer
was redundant:

| Defect | Caught by |
| --- | --- |
| A plan step asserting a gate that did not exist | the implementer, contradicting its brief |
| A file unreviewable since Release 1 (a raw NUL byte made git treat it as binary) | the implementer noticing, and the coordinator refusing "pre-existing and harmless" |
| A golden test that could not detect what it guarded | the task reviewer |
| A live bug in already-shipped matcher code | an implementer whose fixture word happened to trigger it |
| The whole feature inert for want of a permission | the whole-branch reviewer |
| An ADR describing a validator that does not exist | the whole-branch reviewer |

So: a review after every task, and **one whole-branch review at the end, on the
strongest model**. The whole-branch pass exists because ADR 0036 was written
after exactly such a review found three defects that twelve per-task reviews had
each missed.

**Never pre-judge findings for a reviewer.** Do not write "don't flag X" into a
review prompt. If you think a finding would be a false positive, let it be
raised and adjudicate it — that is how this run's most valuable findings
survived.

---

## Keep a ledger

Conversation memory does not survive compaction. Track progress in a file, not
only in your head: which tasks are complete with their commit ranges, every
ruling with what it costs if wrong, and every deferred minor.

The ledger is the recovery map — the commits it names exist in git even when
context no longer remembers creating them. It is also the only place decisions
taken on the owner's behalf are written down where they can be reviewed and
reversed. A ruling that lives only in a chat message was a decision made in
secret.
