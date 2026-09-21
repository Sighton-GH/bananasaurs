# 0056 — Account lifecycle needs its own capability

2026-09-20, part of the web UI overhaul (ADR 0051). Raised by the branch
review of 24a5e278 (finding O1); implemented before merge.

## Context

ADR 0051 moved the CLI's `account` commands onto the dashboard as seven
routes under `/api/accounts/:username/*` — disable/enable, delete,
revoke-credentials, set-password, grant-guild, revoke-guild and grant
capability. They were gated on `config.write`, the capability every other
configuration write uses.

Three facts about the codebase turn that into an escalation:

1. **`config.write` is a per-guild grant.** `requireCapability` authorises
   against `session.guildId`; holding it means "may change configuration in
   this guild."
2. **The account routes' effects are instance-wide.** `OpsInstance.accountDelete`,
   `accountSetPassword`, `accountSetDisabled` and `accountRevokeCredentials`
   act on any account the daemon holds, in any guild — documented and
   deliberate (ADR 0027: accounts predate any guild choice).
3. **There is no owner branch in `authorize()`, by design.** Owners hold
   every capability as real grant rows issued at bootstrap; `auth.ts`
   records why a superuser bit was rejected (ADR 0012, the same reason
   Discord Administrator grants nothing).

So a holder of `config.write` in the one guild could call
`POST /api/accounts/<owner>/password`, receive the owner's new plaintext
password in the response (S13-D3/D4, working as specified), and sign in as
the owner. Two HTTP calls from "may edit settings" to every capability.

Before ADR 0051 the same commands were CLI-only, and the CLI's authorisation
is membership of `bananasaurs-ops` on a 0660 unix socket — kernel-enforced,
requiring SSH to the host (ADR 0024). The branch moved a host-level
administrative surface onto password-authenticated HTTP without a matching
gate. The asymmetry showed it was an oversight: the capability-grant route
beside them already enforced `no-guild-access`.

## Decision

**D1 — `accounts.manage` is a new capability**, added to `CAPABILITIES`
with the meaning: may disable, delete, re-credential or re-scope dashboard
accounts. It is the grain the whole authorisation model already uses, and
it does not reintroduce the superuser bit ADR 0012 rejected.

**D2 — the seven account lifecycle routes are gated on it**, replacing
`config.write`. `GET /api/accounts` stays on `config.read`: seeing the
account list is not the risk. The existing `no-guild-access` check on the
capability-grant route is unchanged.

**D3 — existing owners receive the grant by data migration.** Bootstrap
issues only the capabilities that exist at bootstrap time, so every owner
already on an instance would otherwise lose web access to account
management the moment the routes are re-gated. Migration 0027 inserts one
`accounts.manage` row per `(guild, owner)` pair the owner can already reach
— exactly the grant bootstrap would have made — with `granted_by =
'migration-0027'` so the audit trail names its origin. `INSERT OR IGNORE`
against the primary key makes a re-run a no-op. Hand-written and data-only,
the bounded exception ADR 0049 D1 allows.

**D4 — `accounts.manage` does not re-arm TOTP (ADR 0030).** ADR 0012
requires TOTP for "provider-credential or purge capability": provider means
AI provider API keys (ADR 0002), purge means destroying server content.
Account lifecycle is neither — deleting an account cascades its own rows,
not the archive or the audit log, and no provider secret is reachable
through it. This is the same judgement ADR 0045 made for `mcp.authorize`,
which mints bearer tokens. The pinned count in `authz.test.ts` moves from
10 to 11 with this reasoning beside it, as the tripwire asks.

Stated plainly so it can be overruled: set-password does return a
credential — a dashboard password, not a provider one. If the owner wants
TOTP to cover it, the move is to add `accounts.manage` to `REQUIRES_TOTP`
in `authz.test.ts`, which fails the build until TOTP is built. That is the
mechanism ADR 0030 provides; it is not taken here.

**D5 — nothing else changes hands.** Non-owner accounts hold
`accounts.manage` only when an owner grants it, through the same
`account grant` command or the same dashboard control as any other
capability. The CLI (`bananasaurs account …` over the socket) is unaffected:
it is channel-authorised and never consulted grants.

## Consequences

- A `config.write` grant is once again what it reads as. Whoever you trust
  with it cannot become you.
- The dashboard's grant control lists `accounts.manage` automatically
  (it renders `CAPABILITIES`). No page hides controls by capability; a
  session without the grant gets the same `403 no-grant` toast every other
  page produces.
- `npm run db:migrate` is required at deploy, before the daemon starts, or
  the owner's Accounts page answers 403 until it runs.
- The route test asserts the precise shape of the fix: a session holding
  every capability except `accounts.manage` is refused on all seven routes.

## Rejected

- **An owner-only route guard.** There is no owner check in `authorize()`
  and adding one is the superuser bit ADR 0012 refused. It would also be
  the first authorisation decision in the system not expressible as a grant.
- **Keeping set-password CLI-only, like `bootstrap reissue`.** Defensible —
  it is the one route that mints working credentials for another principal
  — but it removes a real operator convenience and does not close the
  chain on its own (delete + re-create reaches the same place). A new
  capability closes it uniformly. This can still be layered on later
  without contradicting anything here.
- **Telling the operator to run `account grant … accounts.manage` after
  deploy instead of migrating.** A deploy step that must be remembered is
  a lockout waiting to happen; the migration is deterministic and audited.
