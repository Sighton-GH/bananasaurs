# 0033 — `/status` is open to every guild member, while `GET /api/health` stays capability-gated

Status: accepted
Date: 2026-08-30
Depends on ADR 0028 (a dashboard account is a principal) and ADR 0031 (dashboard
audit attribution). Sibling of ADR 0032 (where registration lives).
Decided by the project owner; recorded here because it is an authorization
decision, not a default.

## Context

`/status` reports exactly what slice 14's `GET /api/health` reports — the gateway
connection, the guild's safety state, job counts by state, and scheduler lag —
from the same `OpsPorts` and `OpsInstance` calls.

`GET /api/health` requires the `config.read` capability. Reaching the same data
through a slash command with no capability check looks, read side by side, like a
hole. It is not, and the reason is worth writing down before somebody "fixes" it.

## Decision

**`/status` performs no `authorize()` call and needs no capability grant. Any
member of an allowlisted guild may invoke it.** `GET /api/health` keeps
`config.read`. Both are correct, because the two front doors differ in what they
prove about the caller and in what refusing costs.

### The dashboard's gate is about the credential, not the data

A dashboard session is a bearer credential travelling over a network port. Its
holder is whoever has the cookie. Every route under `/api` is gated with no
exceptions, and that uniformity *is* the security property: a route that reads as
harmless today is one refactor away from returning something that is not, and an
ungated route in a gated surface is the one nobody re-audits. `config.read` on
`/api/health` is a statement about the surface, not a claim that job counts are
secret.

A slash-command interaction is the opposite shape. It arrives with the caller's
real Discord identity attached by Discord, from inside a guild the bot was
explicitly allowlisted into, and it cannot be replayed by anyone who intercepts
a token — the interaction token is single-use and expires in fifteen minutes.
The caller is already a member of the club.

### The data is not sensitive

Weighed field by field rather than by category:

| Field | What a member learns |
|---|---|
| gateway connected, ping, guild count | Whether the bot is up — which they can already tell by whether it responds. |
| killswitch, dry run, breaker | Why the bot is not doing anything. A member who reacts to a panel and gets no role is *owed* this. |
| rate cap, reconcile budget, breaker threshold | Configured limits. Reported by the operator `status` command; not reported here, because a member has no use for them. |
| job counts by state | How much work is queued. Cardinality, no payloads. |
| scheduler lag | How far behind the worker is. |

None of it is an audit trail, a configuration value, a secret, or another
member's data — the categories that make `audit.read` and `config.read` exist.
Compare `GET /api/audit`, which returns who did what to whom: that gate protects
content, and no equivalent slash command is being opened.

### Refusing has a cost that the dashboard's refusal does not

The failure `/status` exists to explain is "the bot is silently doing nothing" —
dry run left on, a kill switch nobody remembered, an open breaker. `docs/21`
exercises 2 and 3 are entirely about that confusion. A `/status` that answers
"you are not authorised" to the member best placed to notice the symptom removes
the diagnostic exactly when it is needed, and pushes the club back to
"ask the operator to SSH in".

There is also no capability system to gate it *with*. Capabilities in this
project are granted to dashboard accounts (ADR 0028), not to Discord members;
gating `/status` would mean inventing a member-facing grant model for one
read-only command. That is a larger decision than this slice, and building it
speculatively is what `CLAUDE.md`'s working-style section warns against.

### What this decision does not license

- It is scoped to `/status`. **Any future slash command that writes, that reads
  another member's data, or that reads configuration values needs its own
  authorization decision**, and the absence of a check here is not a precedent
  for the absence of one there.
- The reply is **ephemeral**. Not for secrecy — it is the same data either way —
  but because a public reply lets one member paste diagnostics into a channel
  repeatedly, and because a bot that answers a private question privately is the
  behaviour members already expect from panel interactions.
- `/status` remains **read-only through `OpsPorts`**. It writes no audit row,
  because `audit_events` records actions taken against the guild and reading a
  job count is not one. This is the same reason `bananasaurs status` on the
  operator socket writes none.

## Consequences

- The `/status` handler has no `authorize()` call, and its test asserts that a
  plain member gets an answer rather than a refusal — so removing the openness
  later is a visible, deliberate change.
- Cross-guild isolation is unaffected and still enforced structurally: the
  handler reaches `OpsPorts` through the daemon's `portsFor` seam keyed on the
  interaction's own guild id, which resolves only against the map built from
  `BANANASAURS_GUILD_ALLOWLIST`. An interaction from any other guild is dropped
  by the translation layer and again by the pipeline's allowlist gate before a
  handler sees it.
- `docs/19` §6.11's `/privacy` is not part of this or any Release 1 slice: a
  Discord privacy policy is required above 100 servers and Bananasaurs serves
  one.
