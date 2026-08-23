# ADR 0013: Operator CLI, and how Claude Code may drive it

Status: accepted (2026-08-22)

## Context

The owner wants to administer and query Bananasaurs using Claude Code on his own subscription, over SSH to the Mint host. This is legitimate — he is a human using Claude Code to operate his own system, which is what the product is for — but it sits one small design mistake away from the pattern ADR 0010 rules out, where subscription credentials end up serving Discord members through another product.

The difference is not automation. `claude -p` on a cron job is fine. The difference is **who the request comes from and where the answer goes**.

Separately, an operator CLI is worth building regardless of Claude. It gives the project a scriptable surface, a debugging path that does not require the dashboard, and something an agent can drive to verify its own work against a running system.

## Decision

### 1. Build a first-class operator CLI

A `bananasaurs` command, installed on the host, that talks to the **running daemon over a Unix domain socket** at `/run/bananasaurs/admin.sock`.

It does not open the database directly. SQLite is single-writer (ADR 0008), and a CLI that writes to the file behind the daemon's back is a corruption bug waiting to happen. The socket keeps one writer, reuses the daemon's validation, authorization, and audit paths, and means the CLI cannot do anything the application itself cannot do.

Socket ownership: the service user owns it; group `bananasaurs-ops` has read/write; the owner's login account is in that group. No `sudo`, no shared service account login.

### 2. The bright line

**The operator CLI is invoked by a human at a terminal, and its output returns to that terminal.**

Prohibited, permanently:

- Any Discord command, interaction handler, scheduled job, event handler, or HTTP route that spawns the `claude` binary.
- Any code path that reads Claude subscription credentials or OAuth tokens.
- Any bridge that takes a Discord message, sends it to Claude Code, and returns the result to Discord — regardless of how many hops sit in between, and regardless of whether a human approves each one.

Permitted:

- The owner SSHes in, runs Claude Code, and asks it to inspect state, explain an incident, draft a config change, or run operator commands. The owner reads the answer in his terminal.
- The owner acts on that answer by making a change — through the CLI, the dashboard, or Discord — as himself.

The test to apply when unsure: **if a club member's action causes the `claude` binary to run, it is wrong.** If the owner's keystroke causes it to run, it is fine.

This is a rule about credentials and beneficiaries, not about convenience. A `/ask` that shells out to Claude Code and posts back to Discord would be genuinely useful and is exactly the thing that must not exist.

### 3. Runtime AI stays on the provider layer

Discord-facing AI features go through the provider abstraction and its eligibility gate (ADR 0010): NVIDIA NIM for development and testing, a paid key at production. The Claude subscription is not part of that path and is not a fallback for it.

### 4. Guardrails on the CLI

- Every command is guild-scoped, like every other data path.
- Writes require an explicit `--confirm` and record an audit event with `actor_type: operator_cli`, the invoking Unix user, and `via: ssh`.
- `--json` output mode so an agent can parse results instead of screen-scraping.
- Secrets are never printed: `config get` on a secret key returns `<redacted>`, always.
- `BANANASAURS_READONLY=1` produces a session where every write command refuses. This is the mode to use for ordinary Claude Code inspection.
- The kill switch is reachable from the CLI. Being able to stop the bot from a phone over SSH is a feature.

## Consequences

- The owner gets real value from his subscription — incident triage, log reading, config drafting, "what changed yesterday" — without any of it touching member requests.
- The project gets a scriptable admin surface, which makes the dashboard less urgent and makes agent-driven verification against a live system possible.
- The socket design preserves single-writer discipline instead of quietly undermining it.
- One more hard rule for `CLAUDE.md`, because this is exactly the kind of shortcut an implementing agent would take while trying to be helpful.
- If the Claude subscription ever formally permits serving third parties, this decision can be revisited. It should not be revisited on the basis of a forum post.
