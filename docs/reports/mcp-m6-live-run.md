# Slice M6 — the MCP connector over the tunnel — live run — 2026-09-20

Ran `docs/SMOKE_TESTS.md` Section D against the real daemon, the real
Cloudflare tunnel and the real Access applications, with the Claude desktop
app as the connector client. Guilds in scope: **dev `1540816150026518620`**
(the send target) and **club `1430056096722194577`** (reads only — 269
members, live, inside an observe window).

Division of labour: the owner drove Discord and the desktop app; this
session drove the terminal and verified every step from the database, the
CLI and the loopback wire rather than from the client's own UI.

All times UTC. The daemon was pid 4000976 throughout, up since 2026-09-19
14:46 PDT on a `dist` built one minute earlier; working tree clean at
`f6c02df`. No build, no migration and no restart happened during this run.

---

## 0. The instrument, and a mistake in it worth recording

Nothing in the application logs request headers — `packages/http/src/server.ts:244`
constructs Fastify with `logger: false` — so Section D's requirement to record
what `Host` and `Origin` actually arrived as could only be met off the wire.
A filtered `tcpdump` on loopback `:8787` (the daemon's only bind) supplied it.

**The first version of that filter was wrong in a way this project has a hard
rule about.** Its pattern included `^Cf-[A-Za-z-]+:` — a wildcard — and so it
captured `Cf-Access-Jwt-Assertion` in full: a live Cloudflare Access identity
JWT, written to a root-owned file on disk. Hard rule 4 says Pino redaction is
an allowlist, not a denylist; the same discipline applies to an ad-hoc
diagnostic, and it was not applied. Impact was low — the assertion is scoped
to an origin that only listens on loopback, and the file never left the box —
but it was a secret in a diagnostic artefact, which is precisely the category
the rule names.

Corrected before any further traffic: the capture was stopped, the two
recorded assertions replaced with `<redacted>` (verified: zero `eyJhbGciOi`
strings remain), and the capture restarted with a **named allowlist** —
request line, `Host`, `Origin`, `X-Forwarded-Proto`, `Cf-Ray`,
`Cf-Access-Authenticated-User-Email`. `Cf-Access-Jwt-Assertion`, `Cookie` and
`Authorization` are excluded by construction rather than by remembering to
exclude them.

The filter is anchored to request lines and header *names* throughout, so the
dashboard password in the consent POST body could never match and was never
written to disk. That property held in both versions.

---

## 1. Step 1 — `doctor` (16:55:06Z)

`bananasaurs doctor --guild 1430056096722194577`. The `public surface` block
is `ok` on all five rows:

| Path | Expected | Observed |
|---|---|---|
| `/` | Access | 302 → `sighton.cloudflareaccess.com` |
| `/api/session` | Access | 302 → `sighton.cloudflareaccess.com` |
| `/oauth/authorize` | Access | 302 → `sighton.cloudflareaccess.com` |
| `/.well-known/oauth-authorization-server` | the app | 200 `application/json` |
| `/mcp` | the app | 401 `application/json` |

The command's overall verdict is `doctor: PROBLEMS FOUND`, for a reason
unrelated to Section D and already on record at `docs/STATE.md:111`: the
bot's role is missing `BanMembers` and `ManageMessages` on both guilds and
`UseApplicationCommands` on the club. Pre-existing, unchanged by this run.

**Pass.**

## 2. Step 2 — allowlist one dev channel (16:56:23Z)

```
bananasaurs mcp allow-channel 1543797994124742838 \
  --guild 1540816150026518620 --confirm
→ channel 1543797994124742838 may now receive MCP sends

bananasaurs mcp allowlist --guild 1540816150026518620
→ 1543797994124742838  allowed by bryan  2026-09-20T16:56:23.998Z
```

Exactly one row, dev guild only. The club guild's allowlist was not touched
and remains empty, which is what makes step 6's refusal meaningful.

**Pass.**

## 3. Step 3 — add the connector (17:09:07Z … 17:10:18Z)

The desktop app was pointed at `https://bananasaurs.sighton.ca/mcp`. Access
challenged for identity first, then the Bananasaurs consent page asked for
the dashboard password; both scopes were approved.

### 3a. What `Host` and `Origin` actually arrived as

Section D asks for this specifically. From the loopback capture, the consent
POST:

```
POST /oauth/authorize HTTP/1.1
Host:   bananasaurs.sighton.ca
Origin: https://bananasaurs.sighton.ca
```

`originMatchesHost` (`packages/http/src/server.ts:183-193`) compares
`new URL(origin).host` against `host` by equality. Both are
`bananasaurs.sighton.ca`, so it passed. **No HTTP Host header override is set
on the tunnel's public-hostname route**, which is the condition `docs/17`
§2.4 warns about — had it been set, this POST would have failed 403 and the
fix would have been removing the rewrite, never loosening the check.

### 3b. Both Access applications are configured correctly, proved from the wire

Two independent confirmations that did not come from the Cloudflare UI:

- `GET /oauth/authorize` arrived carrying `Cf-Access-Authenticated-User-Email`
  and `Referer: https://accounts.google.com/` — so the identity policy really
  does sit in front of the consent page.
- `/mcp`, `/oauth/register`, `/oauth/token`,
  `/.well-known/oauth-protected-resource` and
  `/.well-known/oauth-authorization-server` all arrived with **no `Cf-Access-*`
  headers at all** — so the Bypass application covers exactly the six machine
  paths and nothing wider.

Every request in the capture carried `X-Forwarded-Proto: https`, which is what
makes the session cookie `Secure` through the tunnel (ADR 0029 as amended).

### 3c. The tokens that resulted

```
tok_3dfc797f50ebef843ebe95965c187a37  access   expires 2026-09-20T18:10:09.051Z  live
tok_7ca6c67093d0057f2c033faddaa5a14d  refresh  expires 2026-10-20T17:10:09.051Z  live
```

Both bound to client `cli_f80ad9322a9d5a06d16fe06a8abe63c3` and account
`acct_3e25067a91465f49e3997de9e1b0c1d2`, both carrying
`["bananasaurs:read","bananasaurs:send"]` — read from `oauth_tokens`
directly, since the CLI listing does not show scopes.

**Two clients registered, not one**: `cli_4800d67392c8660947f166eb7522db65`
at 17:09:07Z and `cli_f80ad93…` at 17:09:12Z, five seconds apart. The wire
capture shows two `POST /oauth/register` calls, so the desktop app really did
register twice; only the second was ever used. Harmless, but it means
`mcp clients` accumulates an orphan row per connection attempt.

**Pass.**

## 4. What had to change mid-run, and why

Two configuration facts discovered during step 4 blocked the run. Both are
recorded here because neither is visible from the code.

### 4a. The archive subsystem was entirely inert (`BANANASAURS_ARCHIVE_GUILDS=[]`)

`bananasaurs archive enable-channel` refused both dev channels with

```
guild 1540816150026518620 is not in BANANASAURS_ARCHIVE_GUILDS,
so no channel here can be archived
```

and `config get` confirmed the variable was **empty — no guild in archive
scope, including the club**.

This reframes what step 4's first pass showed. `search_messages` and
`read_channel_history` returned empty not because a guild happened to have no
enabled channels, but because the whole subsystem was off by configuration.
Empty results were correct-by-construction and demonstrated nothing about
FTS5, the visibility set, or tombstones. Three of M6's tools had never been
exercised against real Discord data.

**This is config drift against a recorded decision, not a bug.**
`docs/STATE.md` and the schema comment at
`packages/core/src/config/schema.ts:55-62` both record ADR 0046 Amendment 2 —
the owner's 2026-09-14 direction that the club guild is in archive scope. The
decision is real; it was never applied to the running environment. Exactly the
trap STATE's own closing note warns about: a merged decision read as a live
state.

**A contributing cause, now fixed in this branch:**
`BANANASAURS_ARCHIVE_GUILDS` **appeared nowhere in `.env.example`**, despite
gating the archive, its FTS5 index and three MCP tools, and despite defaulting
to `''` — so the subsystem is silently off and nothing tells an operator it
exists. This branch adds a documented block for it.

**Resolution (owner decision, in-session):** dev guild only added to archive
scope; the club deliberately **not** added, since that ingests 269 real
members' messages and is a privacy decision that should be its own act rather
than a side effect of a smoke test. Both dev channels were then enabled and
backfilled — 52 messages in `general`, 22 in the log channel, `backfill:done`
within ten seconds, `archive_messages` and `archive_messages_fts` both at 74
and in sync.

### 4b. `BANANASAURS_DRY_RUN=1` would have made steps 5–7 meaningless

`packages/core/src/effects/message-gateway.ts:299` short-circuits on
`state.dryRun` and returns before any Discord call, recording
`outcome: 'dry_run'` (line 285). With dry run on, steps 5–7 would have written
`mcp_sends` rows and posted nothing — and the central question of this run,
whether `allowedMentions` survives the REST adapter, is unanswerable without a
real message.

Dry run is a **global** env var, not per-guild, so switching it off arms the
club guild too. The mitigation used was the per-guild killswitch:

| Time | Action |
|---|---|
| 17:35:59Z | `killswitch on` for the club — `KILL SWITCH ON` there, `killswitch off` on dev, confirming per-guild scope |
| 17:36:31Z | restart with `DRY_RUN=0`; killswitch **survived** (it is database-backed) |
| 17:57:09Z | `killswitch off` for the club, after Section D completed |

Automod on the club was never at risk either way — observe mode records
`would_delete` and never calls Discord — but panel and role effects are not
similarly bounded, which is what the killswitch covered.

Both restarts recorded gateway gaps that were handled correctly: gaps 407/408
and 409/410, `resumed=0` (Discord did not resume the session), each with
`reconciled_at` set within ~2 s. Rule modes were checked before and after and
never moved: both guilds `mode=observe`, `cutover_state=observing`.

## 5. Step 4 — every read tool (17:15Z, completed 17:39Z)

13 `POST /mcp` in the first pass, no requests to any other path, token
`last_used_at` advancing — every call authorized.

**A limit on this step worth stating.** MCP read tools write nothing to the
audit trail and emit no log line; the MCP modules contain no `logger.info` or
`logger.warn` at all. What is verifiable server-side is the call count and
that each was authorized. *Which* tool returned *what* rests on the client's
report, checked against the database wherever a claim was checkable.

Results, with the independent check in the right column:

| Tool | Client reported | Verified here |
|---|---|---|
| `get_health` | gateway connected, 2 guilds, both paused | matches `status` |
| `list_channels` / `list_roles` | 5 channels, 4 roles (dev) | consistent with `doctor` |
| `list_members` | 100 → 100 → 69 → 0, 269 total (club) | `doctor` reports 269 members; **no truncation at the 50-entry cache** |
| `search_messages` | 3 hits for "bot" (dev) | FTS5 index at 74/74; CLI search returns the same corpus |
| `read_channel_history` | 20 newest, one no-text placeholder | row `1543812070536118294` confirmed `content=NULL` |
| `get_message` | quoted text, author, timestamp | **exact match** on content, `author_id` and `created_at` |
| `list_mod_cases` / `get_mod_case` | 4 open cases (club) | `mod_cases` holds exactly 4 open for the club |
| `list_audit_events` | **1 row** (club) | see below |
| overview resource | 269 members, 99 channels, 22 roles, 1 rule | consistent |

### 5a. Guild scope, proved on the live path

`list_audit_events` called with the club's id returned **one** row. The
database holds **48 rows for the dev guild and 1 for the club**. None of dev's
48 leaked into a club-scoped call. That is hard rule 2 holding through a real
tunnel, on a real two-guild instance — a property no unit test can demonstrate
end to end.

### 5b. A no-text message is not a tombstone — the tool is right

The client's summary called row `1543812070536118294` a tombstone. It is not:
`content=NULL`, `content_purged_at=NULL`, `deleted_at=NULL` — a message that
never had text. **The tool renders these differently and correctly.**
`packages/mcp/src/tools/archive.ts:231` selects `ARCHIVE_PURGED_MARKER` only
when `contentPurgedAt` is present and `ARCHIVE_NO_TEXT_MARKER`
(`'[no text content was archived for this message]'`) otherwise. Ruling M4-D8
is implemented as written; the mislabel was the client's, not the server's.

**Pass**, after 4a.

## 6. Step 5 — one send that works (17:40:42Z) — the headline result

Called with `idempotencyKey: m6-section-d-step5`, content containing a literal
`@everyone`. The tool returned message `1551287001830006996`.

**The client asserted suppression "per the tool's spec." That is exactly the
assumption that was wrong pre-merge**, when `allowedMentions` was set on the
port object and silently dropped by the REST adapter — the spec said it was
suppressed then too. So the message object was fetched from Discord directly,
read-only, printing only the mention fields:

```json
{
  "id": "1551287001830006996",
  "author_is_bot": true,
  "content": "Section D step 5 live test @everyone — this must not ping anyone.",
  "mention_everyone": false,
  "mentions": [],
  "mention_roles": []
}
```

`mention_everyone` is the flag **Discord itself** sets when a message carries
an everyone-ping. The content contains a literal `@everyone` and Discord
parsed it into nothing. **The `allowedMentions` fix survives the REST adapter
on the live path.** The Critical is genuinely closed, verified at the source
rather than by rendering.

`mcp_sends` holds one row: key `m6-section-d-step5`, `outcome: 'sent'`,
message id recorded, bound to the issuing token.

**Gateway ingestion proved in the same stroke**: because the send channel is
archive-enabled and `packages/core/src/archive/subscriber.ts:18` archives
bot-authored messages too, the message appeared in `archive_messages` within
milliseconds — 75 rows, FTS at 75.

**Pass.**

## 7. Step 6 — one send that is refused (17:42Z)

Same call against `#general` (`1540816151137878028`), not allowlisted. Refused,
naming the allowlist. Verified: `mcp_sends` still **one** row, **no** row under
the step-6 key, and **nothing archived in `#general`** — the archive being an
independent witness to "nothing was posted," rather than the tool's own claim.

**Pass**, with one Minor.

### 7a. Minor — the refusal suggests a command that fails on a two-guild instance

`packages/mcp/src/tools/send.ts:171` builds its remediation text as

```ts
`\`bananasaurs mcp allow-channel ${channelId} --confirm\``
```

interpolating the channel id but not the guild id. Run verbatim here it fails:

```
this instance serves 2 guilds, so the command must say which: pass --guild <id>
```

`guildId` is already in scope as the function's first parameter. The fix is one
interpolation — `--guild ${guildId} --confirm`. Slice 13 made this a
multi-guild instance and this text did not follow. Not fixed in this branch: it
is in `packages/mcp`, and on this box a rebuild is a deployment.

## 8. Step 7 — the retry (17:44Z)

Replayed step 5's call with the identical key and content. The tool answered as
a replay, naming `1551287001830006996`.

Verified: `mcp_sends` still one row with its **original** `sent_at`
(1789926042623) — no new row, no re-send; exactly **one** archived message
matching that content; `archive_messages` still **75**. A duplicate would have
been ingested by the gateway and taken that count to 76.

**Pass.**

## 9. Step 8 — revoke, then 401 (17:44:45Z → 17:45:25Z)

`mcp revoke tok_3dfc797f…` reported *"revoked token … and 2 token(s) in its
lineage"* — **both the access token and its refresh sibling**, at
17:44:45.443Z. That matters: had the refresh survived, the client could have
silently exchanged it and handed back a pass that was not one.

The next tool call produced the daemon's own log line:

```
[17:45:25] INFO: oauth bearer refused
    component: "http"
    oauthTokenId: "tok_3dfc797f50ebef843ebe95965c187a37"
    reason: "revoked"
```

and `packages/http/src/oauth/bearer.ts:30-32` answers that path `401` with the
RFC 9728 challenge. Corroborating: the revoked token's `last_used_at` stayed
frozen at 17:44:00.325Z — **before** the revoke — so the guard ran before the
token was accepted, not after; and the refresh token still reads
`last used never`.

Not inferred from the client's re-authentication prompt. The server named the
token and the reason.

**Pass.**

## 10. Step 9 — the other clients (17:49Z, 17:50Z)

Claude Code registered as a genuinely distinct client:
`cli_c2c03a6e…`, **"Claude Code (bananasaurs)"**, 17:50:12Z, its own token
pair, first used 17:50:51Z. One read tool succeeded.

**claude.ai is not an independent third client.** It shares the connector
configuration with the desktop app through the same account, so the 17:44
revoke logged both out. Re-authorizing minted a **new** dynamic registration
(`cli_704f9d…`, 17:49:07Z) rather than resurrecting the revoked one; the old
tokens stayed revoked. Section D's wording implies three clients were
exercised; two distinct ones were.

Both clients reported the club's killswitch unprompted — the health tool doing
its job.

**Pass**, with the above qualification.

### 10a. Client registrations accumulate with nothing to prune them

Four registrations now exist for two or three real clients:

| Client | Registered | Note |
|---|---|---|
| `cli_4800d673…` | 17:09:07Z | orphan — the desktop app registered twice, 5 s apart |
| `cli_f80ad93…` | 17:09:12Z | used for steps 3–8; tokens revoked |
| `cli_704f9d5…` | 17:49:07Z | the re-authorization |
| `cli_c2c03a6…` | 17:50:12Z | Claude Code |

`mcp clients` grows monotonically; `mcp revoke-client` is the only prune. All
three Claude registrations are named just `Claude`, so desktop, web and the
orphan are indistinguishable in that listing — only Claude Code sends a
descriptive name.

## 11. Step 10 — `doctor` again (17:51:38Z)

Public surface `ok` on all five rows, unchanged from step 1.
`training eligibility — every provider verified` (next review due 2026-12-13).
Two rows that were vacuous in the morning now carry meaning:
`archive — every enabled archive channel is readable` and
`every archived message is indexed`.

`doctor: PROBLEMS FOUND` remains the pre-existing permissions gap.

**Pass.**

---

## 12. Verdict

**All ten steps of Section D pass.** The connector works end to end over the
real tunnel, through real Cloudflare Access, from three Claude clients (two
distinct registrations — see §10).

The four properties this run existed to check, each confirmed from the server
side rather than from a client's rendering:

1. **`@everyone` did not ping.** Discord's own message object reports
   `mention_everyone: false` and empty `mentions`/`mention_roles` for content
   containing a literal `@everyone`. The `allowedMentions` fix survives the
   REST adapter on the live path (§6).
2. **`Host` and `Origin` arrived matching** — both `bananasaurs.sighton.ca`,
   so `originMatchesHost` passed and no Host rewrite is set on the tunnel
   route (§3a). Both Access applications were additionally proved correct
   from the wire (§3b).
3. **The same idempotency key produced exactly one Discord message**,
   confirmed against the archive as an independent witness (§8).
4. **The call after `mcp revoke` was refused**, with the daemon naming the
   token id and `reason: "revoked"` (§9).

### Findings, in fix order

| # | Severity | Finding | Where |
|---|---|---|---|
| 1 | Config drift | `BANANASAURS_ARCHIVE_GUILDS` empty, against ADR 0046 Amendment 2 as recorded in `docs/STATE.md` and the schema comment. Three MCP tools were dark and untested until this run. | §4a |
| 2 | Doc gap | `BANANASAURS_ARCHIVE_GUILDS` absent from `.env.example` despite gating a whole subsystem. **Fixed in this branch.** | §4a |
| 3 | Minor | Send refusal suggests `mcp allow-channel` without `--guild`; fails verbatim on a two-guild instance. One interpolation. | §7a, `packages/mcp/src/tools/send.ts:171` |
| 4 | Needs a ruling | MCP read tools write no audit row and emit no log line. This connector can read archived member messages, moderation cases and the audit trail, leaving no server-side trace of what was read. No ruling found either way in ADR 0045, the M6 design spec or `docs/reports/`. | §5 |
| 5 | Operational | OAuth client registrations accumulate — four for two or three real clients — with only `mcp revoke-client` to prune, and three named identically `Claude`. | §10a |
| 6 | Process | The header-capture filter used for this run initially recorded `Cf-Access-Jwt-Assertion` in full: a denylist where hard rule 4 requires an allowlist. Caught and corrected mid-run; no assertion left on disk. | §0 |

Finding 4 is the one worth a decision rather than a patch. The others are
small.

### State at close

| | |
|---|---|
| `BANANASAURS_DRY_RUN` | back to `1`, confirmed on both guilds |
| club killswitch | lifted 17:57:09Z, `killswitch off` |
| rule modes | unchanged throughout — both guilds `observe` / `observing` |
| `BANANASAURS_ARCHIVE_GUILDS` | `1540816150026518620` — **kept**, by owner decision |
| dev archive channels | 2 enabled, 75 messages, FTS in sync |
| club archive | **not** enabled — deliberately not taken here |
| dev send allowlist | `1543797994124742838` |
| club send allowlist | empty |
| live tokens | `cli_704f9d…` and `cli_c2c03a6…`, one access + one refresh each |
| revoked tokens | `tok_3dfc797f…`, `tok_7ca6c670…`, both 17:44:45.443Z |

No build, no migration and no daemon code change happened during this run.
Two restarts, both to re-read `.env`, both with gaps reconciled.
