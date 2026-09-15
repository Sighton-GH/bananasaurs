# Operator access: SSH, the CLI, and Claude Code on the host

How the owner administers a running Bananasaurs from anywhere, using Claude Code on his own subscription, without any of it touching the Discord-facing AI path.

Decision and rationale: ADR 0013. Provider policy: ADR 0010.

---

## The one rule

**Requests originate at your terminal and answers return to your terminal.**

If a club member's action causes the `claude` binary to run, something is wrong. If your keystroke causes it to run, it is fine.

That is the whole compliance story. Everything below is mechanics.

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

```bash
bananasaurs automod dryrun <rule-id> [--source observed|handwritten]
                                             # replay a rule over the fixture corpus (ADR 0041 §7)
bananasaurs automod review [--rule <id>] [--limit N]
                                             # unreviewed matches, with the message and the
                                             # matched snippet — prints member message content,
                                             # see the warning below
bananasaurs automod verdict <event-id> <false_positive|true_positive|unclear> --confirm
bananasaurs account list                     # every dashboard account: owner, enabled/DISABLED, lockout
bananasaurs account disable <username> --confirm
                                             # the ADR 0045 D6 lever: every session and every OAuth
                                             # token this account approved stops verifying on the
                                             # next request. Reversible with `account enable`.
bananasaurs account enable <username> --confirm
bananasaurs account delete <username> --confirm
                                             # deletes the account AND revokes its OAuth tokens in
                                             # one transaction; guild access, capabilities and
                                             # dashboard sessions cascade. Not reversible.
bananasaurs account grant <username> <capability> --confirm
                                             # ADR 0028, guild-scoped — takes the global --guild
bananasaurs mcp clients                      # registered OAuth clients (no client holds a secret)
bananasaurs mcp tokens                       # every token row, live or revoked — ids only
bananasaurs mcp revoke <token-id> --confirm  # revokes the token's whole lineage, not one row
bananasaurs mcp revoke-client <client-id> --confirm
```

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

### If nobody can log in

`bootstrap reissue` is the recovery path (ADR 0012), and it is why the owner is
not a single point of failure for dashboard access — anyone with shell access
and membership of the ops group can re-arm the setup page.

```bash
bananasaurs bootstrap reissue --confirm     # prints a URL with a 15-minute token
sudo systemctl restart bananasaurs          # required: /bootstrap is registered at startup
ssh -L 8787:127.0.0.1:8787 <host>           # then open the printed URL
```

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
  token issuance. To reset a forgotten password, have an owner change it from
  the dashboard. If there is no owner left at all, delete the account rows
  deliberately and then run this.

### Rules every command follows

- Guild-scoped, like every other data path.
- `--json` for machine-readable output. This is what makes the CLI useful to an agent.
- Writes need `--confirm` and write an audit row: `actor_type: operator_cli`, the Unix user, `via: ssh`.
- Secrets are never printed. Not in `config get`, not in `status`, not in `--json`.
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

**`bananasaurs automod review` and `bananasaurs automod dryrun` are deliberately not on this
allowlist, and must not be added to it.** Both print whole member message content to stdout
(the matched snippet and, for `review`, the full stored message — CRITICAL-2 of the Slice 2
review). Adding either here — the natural-looking thing to do the next time this block is
edited to keep pace with the CLI surface — would route club members' messages into this
Claude session's context and, from there, to the model provider on every ordinary read. That
is a CLAUDE.md rule 5 / Discord Developer Policy (rule 21) question, not a convenience one:
member content may only reach a provider flagged `trainsOnInput: "no"` with a cited ToS clause,
and this ops session is not that path. Run both from your own terminal instead, the same way
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
