# Web UI ↔ CLI capability map

Owner acceptance standard (2026-09-20): every operator action and every piece
of operator information available from the `bananasaurs` CLI is also available
in the dashboard — no drop-to-terminal gaps. This file is the checklist that
claim is held to; every row was verified against the code, not memory.

Pages live under `packages/dashboard/src/pages`, routes under
`packages/http/src/routes`, commands under `packages/core/src/ops/commands`.

## Reads

| CLI command | Web surface | HTTP route |
| --- | --- | --- |
| `status` | Overview page (guild, gateway, jobs, lag, safety, limits) | `GET /api/health` + `GET /api/jobs` |
| `doctor` | Doctor page, incl. public-surface probe | `GET /api/doctor`, `POST /api/doctor/public-surface` |
| `config get <key>` | Configuration page (secrets stay `<redacted>`) | `GET /api/config` |
| `panel list` / `panel show` | Role panels page with per-panel detail (options, limits) | `GET /api/panels`, `GET /api/panels/:id` |
| `log routing list` | Logging page (routes + excluded channels) | `GET /api/log-routes` |
| `audit tail` | Audit page | `GET /api/audit` |
| `jobs list` | Jobs page | `GET /api/jobs` |
| `backup list` | Backups page | `GET /api/backups` |
| `automod dryrun <rule>` | Automod rule page: replay over the fixture corpus, with the attachment-awareness and windowed-corpus caveats | `POST /api/automod/rules/:ruleId/dry-run` |
| `automod review` | Review queue page (matches, native hits, evidence) | `GET /api/automod/review` |
| `archive status` | Archive page | `GET /api/archive/status` |
| `archive search <query>` | Search page (channel/author filters; a hit's Open link lands on that message in the Archive browse view) | `GET /api/archive/search` |
| MCP `read_channel_history` / `get_message` | Archive page, Browse card (paged history, message detail, purged tombstones) | `GET /api/archive/channels/:channelId/messages`, `GET /api/archive/messages/:messageId` |
| `mcp allowlist` / `mcp sends` | Connector page | `GET /api/send-allowlist`, `GET /api/mcp/sends` |
| `mcp clients` / `mcp tokens` | Connector page | `GET /api/mcp/clients`, `GET /api/mcp/tokens` |
| `account list` | Accounts page — **plus** the capabilities each account holds in this guild (the read half of `account grant`, which the CLI list does not show) | `GET /api/accounts` |

## Writes (all confirmed in-app, all audited `actor_type='dashboard', via='http'`)

| CLI command | Web surface | HTTP route |
| --- | --- | --- |
| `config set` | Configuration page | `POST /api/settings` |
| `automod verdict` | Review queue page | `POST /api/automod/review/:eventId/verdict` |
| `automod ready` / `automod signoff` | Automod rule page (cutover) | `POST /api/automod/rules/:ruleId/ready`, `…/signoff` |
| `automod invite-allow` / `invite-deny` | Automod rule page | `POST/DELETE /api/automod/rules/:ruleId/invite-allowlist[/:code]` |
| `automod domain-add` / `domain-rm` | Automod rule page | `POST/DELETE /api/automod/rules/:ruleId/link-domains[/:domain]` |
| `log routing set` / `off` | Logging page | `POST /api/log-routes/:eventKind/enabled` |
| `log routing exclude` / `unexclude` | Logging page | `POST/DELETE /api/log-exclusions[/:channelId]` |
| `jobs retry` | Jobs page | `POST /api/jobs/:id/retry` |
| `backup now` | Backups page | `POST /api/backup-now` |
| `archive enable-channel` / `disable-channel` | Archive page (backfill state visible) | `POST/DELETE /api/archive/channels[/:channelId]` |
| `archive enable-category` / `disable-category` | Archive page (category scope, derived coverage marked) | `POST/DELETE /api/archive/categories[/:channelId]` |
| `archive set-threads` / `archive threads` | Archive page (per-channel threads toggle and done/found progress) | `POST /api/archive/channels/:channelId/threads`, `GET /api/archive/status` |
| `archive preserve` | Search page, per hit | `POST /api/archive/messages/:messageId/preserve` |
| `archive link-case` | Search page, per hit | `POST /api/archive/link-case` |
| `archive reindex` | Archive page | `POST /api/archive/reindex` |
| `mcp revoke` / `mcp revoke-client` | Connector page | `POST /api/mcp/tokens/:tokenId/revoke`, `POST /api/mcp/clients/:clientId/revoke` |
| `mcp allow-channel` / `disallow-channel` | Connector page | `POST/DELETE /api/send-allowlist[/:channelId]` |
| `mcp allow-category` / `disallow-category` | Connector page (category rows show live coverage) | `POST/DELETE /api/send-allowlist/categories[/:channelId]` |
| `panel sync` | Role panels page (publish + reconcile, dry-run preview) | `POST /api/panels/:id/publish`, `…/reconcile` |
| `adoption allow` | Cutover page | `POST /api/adoption-allowance` |
| `undo` | Audit page (reverse one batch) | `POST /api/undo` |
| `killswitch` | Safety page | killswitch toggle (write routes) |
| `account disable` / `enable` | Accounts page | `POST /api/accounts/:username/disabled` |
| `account delete` | Accounts page (danger confirm, cascade stated) | `DELETE /api/accounts/:username` |
| `account set-password` | Accounts page (print-once dialog) | `POST /api/accounts/:username/password` |
| `account revoke-credentials` | Accounts page | `POST /api/accounts/:username/revoke-credentials` |
| `account grant-guild` / `revoke-guild` | Accounts page | `POST /api/accounts/:username/grant-guild`, `…/revoke-guild` |
| `account grant <capability>` | Accounts page (per-account capability chips + grant) | `POST /api/accounts/:username/capabilities` |

The seven `account …` write routes above are gated on `accounts.manage`, not
`config.write` (ADR 0056): their effects are instance-wide and set-password
returns working credentials, so a guild-level configuration grant must not
reach them. Owners hold `accounts.manage` from bootstrap (or migration 0027
on an instance that predates it).
| provider review | Providers page | `POST /api/providers/:provider/review` |

## Safe boundary: restores

`backup list` and `backup now` are in the web UI; **restore is not, and no
button should pretend the live daemon can restore itself.** A restore replaces
the database under a running process. The safe runbook is a host procedure:
stop the daemon, run `scripts/restore.mjs` (npm `restore`) against the chosen
backup, start the daemon, then confirm `doctor` is clean. The Backups page
links this runbook rather than offering a restore control.

## Terminal-only, by design

- `bootstrap reissue` re-arms the first-account setup page when **no**
  dashboard account exists — a state in which nobody can sign in to click a
  web button. It stays a host command; the Accounts page's empty state says
  so, and the lockout-recovery toasts point at it.
- `account list`/`account grant` against guilds the caller cannot reach: the
  CLI's `--guild` flag; the web scopes every action to the signed-in guild,
  which is the dashboard's existing guild-scope model (ADR 0028).

## Assistant harness v2 — web-first, no CLI equivalent

Assistant harness v2 (ADRs 0069–0077) has no CLI equivalent: every row below
is a dashboard page verified against `packages/dashboard/src/app/Shell.tsx`
and `packages/http/src/routes/assistant-*.ts`.

| Web surface | HTTP route | Capability it needs |
| --- | --- | --- |
| AI setup page (`/assistant/setup`, `/providers` alias): model order, provider keys, Brave web search, GitHub token, setup checklist | `GET /api/assistant/providers`, `POST /api/assistant/keys`, `PATCH`/`DELETE /api/assistant/keys/:keyId`, `PUT /api/assistant/model-chain`, `POST /api/assistant/model-chain/test`, `PUT /api/assistant/github-token`, `POST /api/providers/:provider/review` | Owner only (`403 owner-only` for anyone else) |
| Behaviours page (`/assistant`): behaviours, resources, safety suffix, prompt preview, Try it | `GET /api/assistant`, `PUT /api/assistant/behaviours/:id`, `GET /api/assistant/behaviours/:id/preview`, `GET /api/assistant/safety-suffix`, `PUT /api/assistant/resources/:id` | Reads `config.read`; writes `config.write` |
| Try it (on the Behaviours page) | `POST /api/assistant/behaviours/:id/try` | `config.write`; 20 tries per account per hour, in memory |
| Prompt wizard (`/assistant/behaviours/:id/wizard`) | `PUT /api/assistant/behaviours/:id` (wizard answers), `GET /api/assistant/behaviours/:id/preview` | Writes `config.write`; reads `config.read` |
| Skill detail (`/assistant/skills/:skillId`): instruction, tools, behaviour allowlist, recent runs | `GET /api/assistant/skills/:skillId` | `config.read` |
| History (`/assistant/history`, `/assistant/history/:traceId`, `/assistant/activity` alias): trace list, detail, 14-day usage strip | `GET /api/assistant/traces`, `GET /api/assistant/traces/:traceId`, `GET /api/assistant/usage` | `audit.read`; prompt text additionally needs `config.read` (withheld, never 403, without it) |
| Conversations list and transcript (`/assistant/conversations`, `/assistant/conversations/:id`): filters, title search, End and Delete, retention setting | `GET /api/assistant/conversations`, `GET /api/assistant/conversations/:id`, `GET /api/assistant/conversation-retention` | `audit.read` |
| Conversation End and Delete, retention save | `POST /api/assistant/conversations/:id/end`, `DELETE /api/assistant/conversations/:id`, `PUT /api/assistant/conversation-retention` | `config.write` |
| Resources "Add from GitHub" (on the Resources page): org/repo preview and import | `POST /api/assistant/github/preview`, `POST /api/assistant/github/import` | `config.write` |
| Resources freshness, "Update now", "Update all" (on the Resources page) | `GET /api/assistant/resources/freshness`, `POST /api/assistant/resources/:id/refresh`, `POST /api/assistant/resources/refresh` | Freshness `config.read`; both refresh routes `config.write` |
| Accounts list (`/accounts`) with role badges | `GET /api/accounts` | `accounts.manage` |
| Accounts add (`/accounts/new`) with role presets and chosen-or-generated password | `POST /api/accounts` | `accounts.manage` |
| Accounts edit (`/accounts/:username`): Summary, Permissions, Password, Sessions, Danger zone | Per-field routes (`…/disabled`, `…/password`, `…/revoke-credentials`, `…/grant-guild`, `…/revoke-guild`, `…/capabilities[/:capability]`) | `accounts.manage`; every route refuses an owner row with `403 owner-protected` |
| Password reveal (on the Accounts edit page) | `POST /api/accounts/:username/reveal-password` | Owner only plus `accounts.manage`, re-authentication required; owner passwords are never sealed |

## Web-first, no CLI equivalent

Automod rule creation and configuration, exemptions, per-rule review
evidence, guild switcher, session management, and the observe/enforce cutover
screens are dashboard surfaces that predate or exceed the CLI.

*2026-09-20 parity pass: the accounts capabilities read map and the
`POST /api/accounts/:username/capabilities` grant route were the two gaps
this audit found; both are now covered with route and page tests. The
Configuration page no longer sends anyone to the terminal: runtime values
have confirmed, audited controls and process values are labelled with source
and restart requirement. `packages/dashboard/src/app/cli-parity.test.ts`
generates the command list from OPERATOR_COMMANDS, so a future CLI command
without a mapped web surface (or a reasoned exception) fails the build.*
