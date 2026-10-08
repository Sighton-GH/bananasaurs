# Operator access: SSH, the CLI, and Claude Code on the host

How the owner administers a running Bananasaurs from anywhere, using Claude Code on his own subscription, without any of it touching the Discord-facing AI path.

Decision and rationale: ADR 0013. Provider policy: ADR 0010.

---

## The one rule

**Requests originate at your terminal and answers return to your terminal.**

If a club member's action causes the `claude` binary to run, something is wrong. If your keystroke causes it to run, it is fine.

That is the whole compliance story. Everything below is mechanics.

The same operator surface also exists over HTTPS (ADR 0051, branch `oc/webui-overhaul`, unmerged pending owner
review): every CLI capability below is exposed through the web UI as `packages/http` `ops-read` (GET) and
`ops-write` (POST, audited, `actor_type='dashboard'`) routes behind the same dashboard scopes. Reads under
`config.read` or `audit.read`; writes confirm through a scope-quoting dialog. `bootstrap reissue` stays CLI-only
by design (ADR 0051 D4), and `list-unreadable-archive-channels` needs the Discord client, so it stays in
`doctor` rather than its own route.

---

## 1. The operator CLI

A `bananasaurs` command on the host that talks to the running daemon over a Unix socket. It never touches the database file directly — SQLite is single-writer, and a second writer behind the daemon's back is a corruption bug.

### Release 1 surface

```bash
bananasaurs status                          # gateway, db, jobs, scheduler lag, uptime
bananasaurs doctor                          # intents, permissions, role hierarchy, stale panels
bananasaurs config get <key>                # secrets return <redacted>, always
bananasaurs config set <key> <value> --confirm
bananasaurs panel list
bananasaurs panel show <id>
bananasaurs panel sync <id> --confirm       # reconcile against Discord
bananasaurs log routing list
bananasaurs log routing set <event> <channel-id> --confirm
bananasaurs audit tail -n 50 [--since 2h]
bananasaurs jobs list [--failed]
bananasaurs jobs retry <id> --confirm
bananasaurs killswitch on|off --confirm
bananasaurs bootstrap reissue --confirm     # re-arm the dashboard's first-run setup page
bananasaurs backup now --confirm            # take a backup immediately, apply retention
bananasaurs backup list                     # every backup on disk, oldest first
```

### Release 2 additions

The automod switch (Off, Watch, On — ADR 0121) lives on the dashboard's Automod
tab, not here. From the terminal, `bananasaurs killswitch on --confirm` is the
emergency stop: it halts every Discord side effect, automod's included.

```bash
bananasaurs automod review [--rule <id>] [--limit N]
                                             # unreviewed matches, with the matched snippet —
                                             # prints member message content, see the warning below
bananasaurs automod verdict <event-id> <false_positive|true_positive|unclear> --confirm
bananasaurs account list                     # every dashboard account: owner, enabled/DISABLED, lockout
bananasaurs account disable <username> --confirm
                                              # the ADR 0045 D6 lever: every session and every OAuth
                                              # token this account approved stops verifying for as
                                              # long as it stays disabled. A pause, not a rotation —
                                              # `account enable` hands every credential back intact;
                                              # `account revoke-credentials` is the rotation.
bananasaurs account enable <username> --confirm
bananasaurs account revoke-credentials <username> --confirm
                                              # ends every live dashboard session and every live
                                              # OAuth token, and deletes every unexchanged
                                              # authorization code, for the account, without
                                              # disabling it — the account keeps its password
                                              # and can sign in again for new ones.
bananasaurs account delete <username> --confirm
                                             # deletes the account AND revokes its OAuth tokens in
                                             # one transaction; guild access, capabilities and
                                             # dashboard sessions cascade. Not reversible.
bananasaurs account grant <username> <capability> --confirm
                                             # ADR 0028, guild-scoped — takes the global --guild
bananasaurs account grant-guild <username> --confirm
                                             # grants the account access to THIS guild:
                                             # the global --guild IS the guild granted,
                                             # not just the audit destination (unlike
                                             # every other account command)
bananasaurs account revoke-guild <username> --confirm
                                             # revokes the account's access to THIS guild
                                             # (same --guild rule); warns rather than
                                             # refusing your own lockout
bananasaurs account set-password <username> --confirm
                                             # generates a password, prints it once, and
                                             # revokes the account's dashboard sessions
                                             # in every guild — but not its OAuth tokens
                                             # (use `account revoke-credentials` for those)
bananasaurs mcp clients                      # registered OAuth clients (no client holds a secret)
bananasaurs mcp connections                  # one line per sign-in: account, app, what it can
                                             # do (Read/Post/Roles/Tasks), status, last use
bananasaurs mcp tokens [--connection <id>]   # the newest 100 token rows — ids only; filter
                                             # by connection to see the rest
bananasaurs mcp disconnect <connection-id> --confirm
                                             # revokes every live token of one sign-in, keeps rows
bananasaurs mcp delete-connection <connection-id> --confirm
                                             # revokes, then deletes every row of that sign-in
bananasaurs mcp delete-token <token-id> --confirm
                                             # deletes one row; its sign-in is disconnected first
                                             # if it still works
bananasaurs mcp cleanup --confirm            # deletes every sign-in that no longer works, with
                                             # all its rows, and registered apps left with none
                                             # (apps registered in the last hour are spared, so a
                                             # sign-in in progress survives). A working sign-in
                                             # keeps its old tokens 14 days: replaying one is how
                                             # a stolen token is caught
bananasaurs mcp revoke <token-id> --confirm  # revokes the token's whole lineage, not one row
bananasaurs mcp revoke-client <client-id> --confirm
bananasaurs mcp allow-channel <channel-id> --confirm
                                             # lets the connector post here. Nothing is
                                             # allowlisted by default, and the allowlist is
                                             # the only thing that decides where it can post
bananasaurs mcp disallow-channel <channel-id> --confirm
bananasaurs mcp allowlist                    # the channels the connector may post to
bananasaurs mcp sends [--since <duration>]   # every send, with channel, outcome and token id
bananasaurs provider review <provider> --confirm
                                              # records that the owner re-checked the
                                              # training-eligibility row as it stands — it
                                              # writes the review date, not the row's claims
```

**The send tool, and what bounds it (slice M5).** `send_message` posts one
message to one channel, and every bound on it is checked by the daemon, not
by the client:

- **The allowlist decides where.** Nothing is allowlisted by default, so a
  freshly connected connector can post nowhere at all until
  `mcp allow-channel` says otherwise. A channel that is not on it — including
  a DM, which can never be on it — is refused before any Discord call.
- **Mentions never ping.** The send sets `allowed_mentions` to the empty set,
  so `@everyone`, `@here`, role and user mentions in the text are inert. This
  is the one place in the tree that sets it; ordinary bot messages do not.
- **Ten per guild per rolling hour**, counted from the durable ledger rather
  than memory, so a restart does not hand out ten more.
- **The kill switch, the breaker and dry run all apply.** With dry run on the
  send is recorded and not posted, which is the safe way to rehearse one.
- **Retries are safe if the client reuses its idempotency key**, and the
  daemon guards the case where it does not: identical text to the same
  channel inside sixty seconds is refused whatever the key says.

`mcp sends` shows what was posted, with the channel and the token that did
it. The message text is not in the audit trail — it is in `mcp_sends` and in
Discord, which is where a member can see it too.

**Scopes, when you connect a client (ADR 0114, ADR 0130).** The Bananasaurs
sign-in page that opens when you click Connect lists what the app is asking to
do, from these four (the labels are the ones `mcp connections` and the
dashboard use):

- **Read** (`bananasaurs:read`) — every read tool (messages, members, cases,
  settings, tasks).
- **Post** (`bananasaurs:send`) — posts, edits, threads, forum posts, schedules,
  events, polls.
- **Roles** (`bananasaurs:roles`) — role grants and removals, role creation,
  role panels.
- **Tasks** (`bananasaurs:tasks`) — the task write tools (`create_task`,
  `update_task`, `delete_task`, `task_steps`, `task_reminders`,
  `task_progress`, `task_settings`); needs the Manage club tasks permission
  as well. `task_teams` is advertised under Read for its `list` action; its
  create, configure, delete and member actions also need Tasks, so a
  connection with Tasks but not Read does not see `task_teams` at all.

**MCP tools, by group.** Reading: message and channel history, threads and
digests, members, roles, cases, audit, jobs, resources, the server card, and
the task reads (`list_tasks`, `get_task`, `task_teams` with action `list`).
Messages and threads: `send_message`, `edit_message`, `delete_message`,
`set_pin` (pin or unpin), `react` (add or remove the bot's own reaction),
`create_thread`, `thread_members` (add or remove), `create_forum_post`, and
`set_thread_state` (archive or lock, exactly one per call).
Schedules/events/polls: `schedule_message`, `list_scheduled`,
`update_scheduled` (edit or cancel a send still waiting to go out), event
tools and `create_poll`. Roles and panels: grants and removals, role
creation and edits, bulk changes, and role panels. Tasks: the seven task
write tools above, and `task_teams` for teams and members. Actions:
`undo_action` reverses one reversible action and `list_actions` shows recent
actions with ids, never content. Message, thread, event, schedule, role and
panel writes take an idempotency key to reuse on retry, and `dryRun` to
record without changing anything. The task writes have no `dryRun`, and only
`create_task` and `task_progress` take a `requestId` for retries; `undo_action`
takes neither.

Tools are filtered at registration rather than refused on call: a token
without a scope never sees that scope's tools in `tools/list`. **A token keeps
the scopes it was first approved with for its whole refresh lineage**, so a
client connected before a scope existed (the roles and tasks scopes arrived
with MCP connector v2) keeps working but never shows those tools. To pick
them up, disconnect and reconnect the client — a standard MCP client asks for
every scope in `scopes_supported` — approve them on the sign-in page, then
disconnect the old sign-in with `bananasaurs mcp disconnect <connection-id>
--confirm` (`bananasaurs mcp connections` lists each sign-in with the scopes it
was approved with, so you can see which one is the old one). A token holding
only `bananasaurs:send` lists only the send-scope tools — none of the read-scope
tools, not even `get_server_overview` — so if a freshly connected client shows
tools but cannot look anything up, check which scopes were approved before
anything else.

The `account` commands mostly act instance-wide (ADR 0027) — a dashboard account exists before a guild is chosen, so disabling one disables it everywhere, and the account is not a member of the guild you name. But the socket still requires `--guild <id>` on an instance that serves more than one guild, because every operator command resolves a guild before it runs and every audit row is written into one (`audit_events.guild_id` is `NOT NULL`); on this instance that is two guilds, so the flag is required. What the flag selects is therefore only which guild's audit trail records the change — not what the change touches, so `account disable --guild A` still locks the account out everywhere, including guild B, and `account revoke-credentials --guild A` still revokes its sessions and tokens and deletes its authorization codes everywhere, including guild B. `account grant` is the genuine exception in the other direction: its effect really is guild-scoped, because a capability is. `disable` is reversible with `enable`; `delete` is not. Neither guards against removing the last owner, deliberately: `enable` undoes a disable, and deleting the last account is the path `bootstrap reissue` documents, so a guard would make that recovery unreachable (ADR 0045 Amendment 3, A3-3).

`account grant-guild` and `account revoke-guild` are the second exception, and the louder one: for these two the global `--guild` IS the target — it selects the guild being granted or revoked — not merely the audit destination. Say it plainly because it differs from every other account command: `account grant-guild alice --guild B` gives Alice guild B, and the row lands in B's trail because B is where the change happened. One guild id on the line, never two. `revoke-guild` joins `delete` in deliberately refusing no lockout: revoking your own last guild access signs you out with no way back in, the command warns rather than refusing, and recovery is delete + re-bootstrap.

`disable` is a pause, not a rotation: re-enabling an account restores every session and token it approved, intact. `account revoke-credentials` is the rotation: it ends every live dashboard session and every live OAuth token, and deletes every unexchanged authorization code, for the account without disabling it. It does not rotate the password, so an attacker who knows the password can sign in again and get new sessions and tokens — to stop the account signing in at all, use `account disable`; to remove it, `account delete`.

Later releases add `case`, `archive search`, `channels enable|disable`.

**Restore is deliberately not on this list.** ADR 0034: it needs the daemon
stopped, which a socket command can never guarantee about itself. It is
`npm run restore -- <backup-file> --confirm`, run on the host with the daemon
stopped — see `docs/SMOKE_TESTS.md` for the drill.

### Reaching the dashboard

The dashboard binds `127.0.0.1` and the daemon **refuses any other bind** —
`DASHBOARD_BIND` accepts `127.0.0.1`, `localhost` or `::1` and nothing else.

So from anywhere but the box itself, you need a tunnel:

```bash
ssh -L 8787:127.0.0.1:8787 <host>
# then open http://127.0.0.1:8787 in your own browser
```

Tailscale works as well. If the page "doesn't load", this is why, and the fix is
the tunnel rather than a wider bind: `0.0.0.0` would put a password form holding
the kill switch on the LAN.

**An account created by `bootstrap` reaches every guild this instance serves** — `packages/http/src/auth.ts`'s bootstrap loops over `BANANASAURS_GUILD_ALLOWLIST` granting access *and* every capability in each. What it does **not** do is let you move between them: a session's guild is chosen at sign-in, and before slice 13 nothing could change it, so an instance serving two guilds could show you only the one you happened to land in. Slice 13 adds the choice at login (when your account reaches more than one guild, the login form asks which) and a switcher in the dashboard header that re-scopes your existing session. `account grant-guild` / `account revoke-guild` exist for the opposite job — **restricting** an account to fewer guilds and restoring it afterwards — and cannot make a guild reachable that `bootstrap` did not already grant, since only one account can exist today and it holds them all. `bananasaurs doctor` — the operator-socket command, not `npm run doctor`, which connects to Discord and exits without reading the database — fails loudly on any allowlisted guild no enabled account can reach.

An account that reaches more than one guild must name one at login. The sign-in form asks for username and password first; only after the password verifies does the server answer `guild-required` with the reachable set, and the form then offers the choice and re-posts with it. Nothing about the account's guilds is revealed to a caller who cannot already log in — a wrong password answers exactly as it always did. Once in, the sidebar's guild block becomes a server-fed switcher: picking another reachable guild re-scopes the same session (same cookie, same CSRF token) without logging out, and every page reloads in the new guild. The move is CSRF-protected and writes one `session.guild_switched` audit row in the new guild naming the guild moved from and to. A guild the account cannot reach is refused with `no-guild-access` and the session stays where it was.

### If nobody can log in

**A forgotten password is `account set-password <username> --confirm`.** It generates a replacement, prints it once — copy it into a password manager immediately, it is not stored anywhere — and revokes the account's dashboard sessions in every guild. It does **not** revoke OAuth tokens: those are bound to the account, not the password, so run `account revoke-credentials <username> --confirm` as well if the password may have leaked. `account delete` plus re-bootstrap remains the recovery only when nobody can sign in at all (reissue refuses while any account exists), and it still costs every OAuth token and authorization code the deleted account approved — which is free on an instance with no connector and expensive on one with a live MCP client, so if you are going to lose the last account, lose it early.


`bootstrap reissue` is the recovery path (ADR 0012), and it is why the owner is
not a single point of failure for dashboard access — anyone with shell access
and membership of the ops group can re-arm the setup page.

```bash
sudo systemctl restart bananasaurs          # required: /bootstrap is registered at startup
journalctl -u bananasaurs --since "-5 min" | grep "bootstrap?token="
ssh -L 8787:127.0.0.1:8787 <host>           # then open THAT url, within 15 minutes
```

**Read the token from the startup banner, not from `bootstrap reissue`** — and
in this flow you do not need `reissue` at all. Two behaviours combine:
`issueBootstrapTokenIfNeeded` mints a token at **every** startup while zero
accounts exist, and `issueBootstrapToken` **deletes every earlier unconsumed
token** when it mints one (deliberately: a recovering operator must not end up
with two valid ways in and know only one). So
`reissue` → `restart` → open-the-reissued-URL always fails with `bad token`,
because the restart superseded it. Tried on 2026-09-19; that is what it cost.

`bootstrap reissue` is still the right command when the daemon is **already
running with zero accounts and no live token** and you would rather not
restart — but then do not restart afterwards, or read the banner instead. If
the fifteen minutes lapse, just restart again: while no account exists, every
start issues a fresh one.

Three things about it are deliberate:

- **The token is printed once and never stored.** The database holds only its
  SHA-256, so the printed line is the only copy. Run the command again to get a
  new one; the previous one stops working.
- **The restart is not optional.** `/bootstrap` is registered when the server is
  constructed, and only when the account table is empty *and* a live token
  exists. A running daemon has already decided the route does not exist and will
  keep answering 404 — which looks exactly like the command not having worked.
- **It refuses while any dashboard account exists.** Otherwise anyone with shell
  access could mint a second owner account, with the audit trail showing only a
  token issuance. To reset a forgotten password, run `account set-password`
  from the shell. If there is no owner left at all, delete the account rows
  deliberately and then run this.

`bootstrap reissue` refuses while any dashboard account exists, so reaching the empty state it needs is itself a deliberate act — and that act now has a supported command: `bananasaurs account delete <username> --confirm`, which revokes the account's OAuth tokens in the same transaction instead of leaving raw row deletes to the operator. That is the path the refusal message already names, so the manual and the tool agree. (To reset a forgotten password while accounts still exist, use `account set-password`, not this path — see above.)

### Task posts

Discord posts for club tasks (announcements, reminders, check-ins, weekly digests, approval
and evaluation posts) are off until someone turns them on for the server: open the dashboard,
go to **Tasks**, and use the **Task posts** switch (the owner, or anyone with Manage club tasks).
It takes effect on the next minute tick, with no restart. `BANANASAURS_DRY_RUN=1` overrides the
switch; set it to `0` in `.env` and restart to end dry run. Posts skipped while posts were off
are not sent later. The old `TASK_NUDGE_SEND_ENABLED` variable is gone (ADR 0131); a leftover
line in `.env` is ignored with a startup warning. `doctor` reports a server that has open tasks
while posts are off.

### Rules every command follows

- Guild-scoped, like every other data path.
- `--json` for machine-readable output. This is what makes the CLI useful to an agent.
- Writes need `--confirm` and write an audit row: `actor_type: operator_cli`, the Unix user, `via: ssh`.
- Secrets are never printed. Not in `config get`, not in `status`, not in `--json`. The two deliberate exceptions are the print-once secrets: the bootstrap token and `account set-password`'s generated password, each shown once in the command's text output and stored nowhere — never in `data`, never in the audit row, never in a log line.
- `BANANASAURS_READONLY=1` makes every write command refuse. Use this for ordinary inspection.

---

## 2. Host setup

SSH, git, and Claude Code are already installed on the Mint box, and development happens through VS Code Remote. What follows is the service account and socket permissions, which are still needed.

### 2.1 Users and socket permissions

```bash
# service account — no login shell, owns the data
sudo useradd --system --shell /usr/sbin/nologin --home /opt/bananasaurs bananasaurs

# ops group — your login account joins it
sudo groupadd bananasaurs-ops
sudo usermod -aG bananasaurs-ops "$USER"
```

The systemd unit creates the socket owned by `bananasaurs:bananasaurs-ops`, mode `0660`:

```ini
[Service]
User=bananasaurs
Group=bananasaurs
RuntimeDirectory=bananasaurs
RuntimeDirectoryMode=0750
UMask=0007
EnvironmentFile=/etc/bananasaurs/env      # root-owned, 0640, group bananasaurs
```

Group membership is what grants access. No `sudo`, no logging in as the service account, no shared credentials.

### 2.2 SSH — already working

You are already on the box via VS Code Remote. Worth confirming key-only auth is enforced, in `/etc/ssh/sshd_config`:

```
PasswordAuthentication no
PermitRootLogin no
```

```bash
sudo systemctl restart ssh
```

Key-only. Test that you can still get in *before* you close the other terminal.

### 2.3 Reaching it from outside the LAN

Install Tailscale on the Mint box and on your laptop. It gives you a stable hostname that works from anywhere without opening a port on your router, which is the part you do not want to get wrong.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Do not expose SSH or the dashboard to the public internet directly. `docs/07` covers this; Tailscale is the answer.

### 2.4 The public hostname: `bananasaurs.sighton.ca` (slice M6)

The owner decided on 2026-09-17 that the public hostname serves **both** the
MCP surface and the dashboard, behind Cloudflare Access (ADR 0045 Amendment
5). Everything below follows from one fact: **Access is the entire security
boundary for the dashboard paths.** The tunnel forwards the whole origin, the
bind is still loopback, and nothing in the daemon can see whether the Access
policy is there — so `doctor` checks from outside.

**The tunnel is remotely managed.** `cloudflared service install <token>`
was used, so `cloudflared` runs `tunnel run --token …` and there is **no
local `config.yml`**; the route from the hostname to `http://localhost:8787`
lives in Zero Trust → Networks → Tunnels → Public Hostname. Two things about
that route:

- The origin service is `http://localhost:8787` (or whatever
  `DASHBOARD_PORT` is). Not `https`; the origin is plain HTTP on loopback.
- **Do not set an HTTP Host header override** on the route. `originMatchesHost`
  compares the browser's `Origin` host to the `Host` header by equality, and
  `cloudflared` forwards the original `Host` by default — so the consent POST
  and every dashboard write work through the tunnel unchanged. If a rewrite
  is ever set there, they fail, and the fix is to remove the rewrite, never
  to loosen the CSRF check.

**Access: two applications.** Cloudflare matches the more specific path
first, so:

1. **The dashboard** — a Self-hosted application on `bananasaurs.sighton.ca`
   (the bare hostname), policy **Allow**, include the owner's identity. This
   covers `/`, `/api/*`, `/bootstrap` and `/oauth/authorize`. The last one
   is deliberate: the consent page is the one OAuth path a human loads in a
   browser, so it sits behind Access *and* the dashboard password.
2. **The machine endpoints** — one Self-hosted application listing exactly
   these six paths as its domains, policy **Bypass**, include **Everyone**:

   ```
   bananasaurs.sighton.ca/mcp
   bananasaurs.sighton.ca/oauth/token
   bananasaurs.sighton.ca/oauth/register
   bananasaurs.sighton.ca/oauth/revoke
   bananasaurs.sighton.ca/.well-known/oauth-authorization-server
   bananasaurs.sighton.ca/.well-known/oauth-protected-resource
   ```

   Every one of these is reached by a client with no browser and no Access
   cookie, and every one is already guarded — bearer token on `/mcp`, PKCE
   and the client id on the token paths, nothing sensitive in the two
   documents. Access in front of any of them breaks the connector with an
   error that looks nothing like its cause.

**`doctor` verifies both directions.** With `MCP_PUBLIC_URL` set, `doctor`
fetches five paths on the public hostname and reports `PROBLEMS FOUND` if
any is wrong:

| Path | Must be | If it is not |
|---|---|---|
| `/`, `/api/session`, `/oauth/authorize` | an Access redirect | **the dashboard is exposed** |
| `/.well-known/oauth-authorization-server` | the JSON document | the connector cannot work |
| `/mcp` | `401` with the bearer challenge | the connector cannot work |

Run it after any change to the Access applications. It is the only on-box
check of a configuration that lives entirely in Cloudflare's dashboard.

**The tunnel token.** `cloudflared service install` writes the token into
`ExecStart` in `/etc/systemd/system/cloudflared.service`, and unit files are
world-readable. On a single-user box that is a low risk; the fix is still
cheap and worth doing:

```bash
sudo install -m 0600 /dev/null /etc/cloudflared/tunnel.env
# put  TUNNEL_TOKEN=<the token>  in it, then in the unit:
#   EnvironmentFile=/etc/cloudflared/tunnel.env
#   ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel run --token ${TUNNEL_TOKEN}
sudo systemctl daemon-reload && sudo systemctl restart cloudflared
```

**Session cookies over the tunnel.** The dashboard session cookie is
`Secure` when the request arrived with `X-Forwarded-Proto: https` — which
the tunnel sets and a loopback client never does — so `ssh -L` and Tailscale
are unchanged (ADR 0029, amended). `trustProxy` stays off: every request
still looks like `127.0.0.1` to the daemon, which is why the session row's
IP column is not meaningful through the tunnel.

---

## 3. Claude Code on the host

### 3.1 Install

```bash
# Node 22 via nvm or nodesource, then:
npm install -g @anthropic-ai/claude-code
claude          # first run walks you through subscription login
```

Log in with your own account. This is you, using your subscription, on your machine.

### 3.2 A separate ops workspace

Keep operations away from the build repo. Different job, different context, different permissions.

```bash
mkdir -p ~/bananasaurs-ops/.claude
cd ~/bananasaurs-ops
```

`~/bananasaurs-ops/CLAUDE.md`:

```markdown
# Bananasaurs operations

You are helping the owner operate a *running* Bananasaurs instance on this host.
This is not the build repo. Do not write application code here.

Inspect state with the `bananasaurs` CLI. Prefer `--json` and parse it.
Read logs with `journalctl -u bananasaurs`.

Read-only by default. Never run a command with `--confirm` unless the owner
asks for that specific change in this conversation. Show the command and what
it will do before running it.

Never print, echo, cat, or grep secrets. /etc/bananasaurs/env is off limits.

When asked "what happened", start with `bananasaurs status`, then
`bananasaurs audit tail`, then the journal. Report what the data shows.
Say when you do not know rather than inferring.
```

`~/bananasaurs-ops/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "Bash(bananasaurs status*)",
      "Bash(bananasaurs doctor*)",
      "Bash(bananasaurs audit tail*)",
      "Bash(bananasaurs panel list*)",
      "Bash(bananasaurs panel show*)",
      "Bash(bananasaurs log routing list*)",
      "Bash(bananasaurs jobs list*)",
      "Bash(bananasaurs config get*)",
      "Bash(journalctl -u bananasaurs*)",
      "Bash(systemctl status bananasaurs*)"
    ],
    "deny": [
      "Read(/etc/bananasaurs/**)",
      "Read(/opt/bananasaurs/data/**)",
      "Bash(cat /etc/bananasaurs/*)",
      "Bash(sudo *)"
    ]
  },
  "env": { "BANANASAURS_READONLY": "1" }
}
```

Read commands run without prompting. Anything with `--confirm` is not in the allowlist, so Claude Code asks you first and you approve it deliberately. That is the posture you want for a live system.

**`bananasaurs automod review` is deliberately not on this allowlist, and must not be added
to it.** It prints member message content to stdout (the matched snippet — CRITICAL-2 of the
Slice 2 review). Adding it here — the natural-looking thing to do the next time this block is
edited to keep pace with the CLI surface — would route club members' messages into this
Claude session's context and, from there, to the model provider on every ordinary read. That
is a CLAUDE.md rule 5 / Discord Developer Policy (rule 21) question, not a convenience one:
member content may only reach a provider flagged `trainsOnInput: "no"` with a cited ToS clause,
and this ops session is not that path. Run it from your own terminal instead, the same way
you run any other write command's `--confirm` today.

To make a write, drop the readonly env for that session: `BANANASAURS_READONLY=0 claude`.

### 3.3 Using it

```bash
ssh bryan@<mint-box>
cd ~/bananasaurs-ops
claude
```

Then ask normally:

- "Is the bot healthy? Anything failing?"
- "Somebody says they lost their role about an hour ago. What happened?"
- "Show me every audit event from the last day and summarise what changed."
- "Which role panels are out of sync with Discord, and why?"
- "Draft the log routing config for a new #mod-log channel. Don't apply it."
- "Reconstruct the timeline for case 41 from the audit trail and the journal."

For a quick one-off without an interactive session:

```bash
ssh bryan@<mint-box> 'cd ~/bananasaurs-ops && claude -p "summarise bananasaurs status and any failed jobs"'
```

That is still you, at your keyboard, getting an answer in your terminal.

---

## 4. What this must never become

Concrete versions of the mistake, so they are recognisable when an agent proposes one:

- A `/ask` handler that runs `claude -p` and posts the reply to Discord.
- A "Bananasaurs is thinking..." message backed by a shell-out to the CLI.
- A dashboard button that pipes a member's question to Claude Code.
- A scheduled job that uses Claude Code to summarise the archive into memory capsules that members then read through `/ask`.
- A queue where Discord questions land, Claude Code drains it, and answers go back.

Every one of those puts subscription credentials inside a service that serves other people. The last two are the tempting ones because they feel indirect — a human is in the loop, or the output is "just data." The credential is still doing the work for members, so they are still out.

Discord-facing AI goes through the provider layer: NVIDIA NIM now, a paid key at production (ADR 0010).

**And the line ADR 0044 adds.** The MCP server is permitted *because* its
output goes to the owner's own client and its one write is owner-instructed
and allowlisted. A tool that took a member's question, asked Claude, and
posted the answer would still be the prohibited bridge — the transport
changed, the rule did not. The trigger must be the owner's keystroke in the
owner's client, and the bot cannot verify that; it is a rule the owner keeps.

---

## 5. Interim provider setup

For Releases 1 and 2 there is no AI at all, so nothing is needed.

For Release 3 development:

1. Get a key from build.nvidia.com.
2. Configure it as an OpenAI-compatible provider profile.
3. Set `trainsOnInput: "no"`, record the exact terms URL in `noTrainingEvidenceUrl`, set `termsReviewedAt` to the day you read it.
4. Set `productionUseAllowed: false` and confirm the router refuses to serve the club guild from it.
5. Point it at the test guild only.

When the bot is production-ready, add a paid profile, flip `productionUseAllowed`, and switch the club guild's routing. The provider abstraction exists so that is a config change rather than a code change — which is the whole reason for building it that way.
