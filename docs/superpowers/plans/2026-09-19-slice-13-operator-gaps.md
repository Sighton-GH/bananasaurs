# Slice 13 — three operator gaps, found by using the thing

**Status: DRAFT.** Written 2026-09-19. **Branch:** `oc/slice-13-operator-gaps`.
**ADR:** none new — ADR 0012 (bootstrap), ADR 0027 (instance-level accounts)
and ADR 0045 Amendment 4 (which *records* the password gap) already decide
the shapes. Amendment 6 to ADR 0045 records that the gaps are closed.

All three were found in one sitting on 2026-09-19, by the owner trying to log
in. None was found by a test, a review, or a plan, because each is a *missing*
thing and every existing test asserts about things that exist.

## The three

**1. No account can reach the second guild.** `bootstrap` grants guild access
to `deps.guildIds[0]` and only that (`packages/http/src/auth.ts:455`).
`hasGuildAccess` gates every session (`:105`). `grantGuildAccess` has **one**
production caller — that bootstrap line — and no CLI command, no route, no
dashboard switcher. So on this instance the owner's account reaches
`Bananasaurs dev` and the club guild (246 members, the guild the whole
Release 2 gate is written against) **has never been reachable from the
dashboard by anybody**. This is the most consequential of the three and it is
first.

**2. No password reset.** `setPasswordHash` still has no production caller
(ADR 0045 Amendment 4 records it). The recovery for a forgotten password is
`account delete` then re-bootstrap — which also revokes every OAuth token and
authorization code that account approved. That was free on 2026-09-19 because
no connector existed. It stops being free the moment M6's live run registers
one.

**3. `doctor` is silent about whether anyone can log in at all.** Zero
accounts with a live bootstrap token is a recoverable state; zero accounts
with no live token means nobody can get in without a restart, and nothing
says so. Nor does anything report an allowlisted guild that no enabled
account can reach — gap 1's symptom, which `doctor` could have shown months
ago.

## Rulings

**S13-D1 — `account grant-guild` uses the global `--guild` as its *target*,
and says so loudly, because the other account commands do not.** `docs/17`
already explains that `account disable --guild A` disables the account
everywhere and that `--guild` only picks the audit trail. Here it genuinely
selects what is granted, because `grantGuildAccess` takes a `GuildScope`. One
guild argument, not two: an `account grant-guild <username> <guildId>` with a
*separate* `--guild` for audit would be two guild ids in one command line,
which is the kind of thing an operator gets wrong at 2am on flip day. The
summary, the success text and `docs/17` all state that here `--guild` is the
guild being granted.

**S13-D2 — `revoke-guild` has no guard against locking yourself out, and the
output says exactly what you did.** This follows ADR 0045 A3-3's precedent:
`account delete` has no guard against removing the last owner either, because
`bootstrap reissue` is the documented recovery and a guard would make that
recovery unreachable. Same here — revoking your own last guild access leaves
you unable to sign in, recovery is delete + re-bootstrap, and the command
warns in its output rather than refusing.

**S13-D3 — `account set-password` generates the password and prints it once;
it does not accept one.** Bootstrap's precedent (`docs/19` §6.10 step 1): the
secret goes to *this operator's terminal* and is never stored. A password
passed as an argument lands in shell history, in `ps` output while it runs,
and in whatever scrollback the terminal keeps. Generating removes all three.
The operator pastes it into a password manager, which is what they should be
doing anyway — and on 2026-09-19 the failure to do that is what started this.

**S13-D4 — setting a password revokes that account's dashboard sessions, and
not its OAuth tokens.** A session is trust derived from the password, so a
password change must end the others. An OAuth token is bound to the account,
not to the password, and `account revoke-credentials` (M3c) already exists for
the operator who wants both. The output says which happened and names the
other command. Cost if wrong: an operator who meant "revoke everything" runs
two commands, which is A3-4's principle — each command keeps one meaning.

**S13-D5 — `doctor` gains two findings, and both count toward `ok`.**

| State | Report | `ok` |
|---|---|---|
| ≥1 enabled account, every allowlisted guild reachable by one | `dashboard access    ok` | yes |
| An allowlisted guild no enabled account can reach | names the guild and `account grant-guild` | **no** |
| 0 accounts, live bootstrap token | names the expiry: setup is pending, not broken | yes |
| 0 accounts, no live token | nobody can sign in; restart mints one | **no** |

The third row is deliberately not a problem: a fresh instance waiting for its
first account is working correctly, and a `doctor` that shouts at a correct
state teaches the operator to ignore it (the M6-D1 argument, again).

## Global constraints (copy verbatim into the brief)

1. **Do not touch** `mod_rules`, `setRuleMode`, `packages/core/src/mod/`,
   `packages/core/src/automod/`, `packages/core/src/effects/gateway.ts`,
   `packages/storage/src/schema.ts`, `drizzle/`. **No migration** — every
   repository function this slice needs already exists.
2. **The systemd unit runs the main checkout's `dist/`.** Work in the
   worktree.
3. **No secrets anywhere** (rule 4). The generated password goes to the
   command's `text` and nowhere else: **not** into `data`, not into the audit
   row, not into a log line. The audit row records that the password was
   changed and by whom, never the value.
4. **Guild scope is a mandatory partition key.**
5. **Every write is `--confirm`-gated and writes an audit row.**
6. **Break every guard and watch it fail.**
7. Gates: `npm run typecheck && npm run lint && npm run test` in the worktree.

## The one task

Three commands (`account grant-guild`, `account revoke-guild`,
`account set-password`), their `OpsInstance`/`OpsPorts` members over the
existing repository functions, the two `doctor` findings, and `docs/17`. Then
ADR 0045 Amendment 6 recording that Amendment 4's named gap is closed
(controller writes the ADR).
