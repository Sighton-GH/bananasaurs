# Safety and blast radius

How Bananasaurs is prevented from damaging a server, including on its first run and including when it has a bug.

A test server is a good idea and you should use one. But it is not the control that protects you, because the bug that matters is the one that only appears against real data — a member who left mid-operation, a role that got reordered, a panel message someone deleted. The controls below are the ones that hold in production.

Reaction panels carry a failure mode buttons do not: a reaction added while the bot is offline produces no event on reconnect, so reaction state and role state drift apart silently. Periodic reconciliation is the answer, and it is bounded by the reconciliation budget in Layer 3 so a repair pass can never turn into a mass role change.

The design principle: **assume the code is wrong and bound what wrong can do.**

---

## Layer 1 — Discord permissions are the outer wall

This is the only limit that cannot be defeated by a bug in Bananasaurs, because Discord enforces it. Everything else in this document is software, and software has bugs.

**Release 1 bot permissions, and nothing more:**

| Permission | Bit | Why |
|---|---|---|
| View Channels | 1024 | See panels and events |
| Read Message History | 65536 | Read panel messages and reaction state |
| Add Reactions | 64 | Seed the mapped emoji on an adopted panel |
| Manage Roles | 268435456 | The one thing it actually does |
| Send Messages | 2048 | Post `/privacy` output and managed panels |
| Embed Links | 16384 | Formatting for log output |
| Use Application Commands | 2147483648 | Slash commands |
| View Audit Log | 128 | Attribute deletions in the log module |

Total: **2416004288**. Invite URL:

```
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot%20applications.commands&permissions=2416004288
```

**Deliberately absent:** Manage Messages, Manage Channels, Manage Server, Kick, Ban, Moderate Members, Manage Webhooks, Mention Everyone, Administrator.

A Release 1 Bananasaurs that goes completely haywire **cannot delete a message, kick anyone, ban anyone, or alter a channel.** It is not restraint — it is incapacity. Grant new permissions only when the release that needs them arrives, and never grant Administrator to save time.

Place the bot's role high enough to manage the panel roles and no higher. Discord will not let it touch anything above itself.

---

## Layer 2 — Role allowlist

Bananasaurs may only assign or remove a role that is **explicitly registered in a panel configuration**. Not "any role below mine" — a specific, enumerated list.

So if your panels cover five roles, a runaway reconciliation loop can only touch those five. It cannot invent a role assignment, cannot grant a moderator role, cannot strip anything it was not told about. Any attempt to mutate an unregistered role is refused and logged as a bug, not as a permission error.

Protected principals sit on top: the guild owner, any role at or above the bot's own position, and any role or member the owner marks protected are refused regardless of what a panel says.

---

## Layer 3 — Rate limits and a circuit breaker

This is the control that specifically stops "goes haywire."

- **Global cap on role mutations:** a configurable ceiling per minute, defaulting low — 20 is plenty for a 30-member club where roles change a few times a week.
- **Exceeding it trips a circuit breaker**: the module stops acting entirely, keeps recording what it *would* have done, writes a loud log line, and raises a dashboard and `bananasaurs status` alert. It does not resume on its own. A human clears it.
- **Consecutive-error breaker:** N failed Discord calls in a row trips the same way, so a permission change or an outage produces one alert rather than a thousand retries.
- **Reconciliation budget:** any reconciliation pass computes its full change list *before* acting. If the list exceeds a threshold, it refuses and asks for confirmation instead of proceeding. A correct reconciliation after a 30-minute outage touches a handful of members; one touching 200 is a bug, and the right response is to stop.

The bias throughout: **when something looks wrong, do nothing and tell someone.** A bot that stops is an inconvenience. A bot that keeps going is an incident.

---

## Layer 4 — Dry-run mode

`BANANASAURS_DRY_RUN=1` makes every Discord side effect a log line instead of an API call. Everything else runs normally — events are processed, decisions are made, audit rows are written and marked `dry_run: true`.

**Run the real server this way for the first week.** Carl-bot keeps working, Bananasaurs watches alongside it, and you compare: did Bananasaurs decide to grant exactly the roles Carl-bot granted? Any divergence is a bug found for free, with no member affected.

This is worth more than the test server, because it is the real server with real members doing real things, at zero risk. The test server proves the code runs; dry-run against production proves the code is *right*.

---

## Layer 5 — Undo

Every role mutation records the member's prior role state. Mutations performed in one operation share a batch ID.

```bash
bananasaurs audit tail -n 50
bananasaurs undo <batch-id> --confirm     # restores prior state for that batch
```

If something does go wrong, the recovery is one command, not an afternoon of manually re-adding roles from memory. Test this on the test server before you trust it — an untested undo is not an undo.

---

## Layer 6 — Kill switch

```bash
bananasaurs killswitch on --confirm
```

Stops all Discord side effects immediately while leaving the process running, so logs, health, and diagnostics stay available. Reachable from the dashboard and from SSH on your phone.

Separate from dry-run (which is a startup mode) and separate from stopping the service (which loses observability at the moment you most want it).

---

## Layer 7 — Startup refusal

On boot and on config change, `doctor` verifies:

- Every configured guild is in the allowlist. Any other guild: log and leave.
- Every panel message still exists and is reachable.
- Every mapped role still exists and sits below the bot's highest role.
- Every mapped emoji is still available to the bot.
- Required intents and permissions are actually granted.
- `partials` are configured, without which reactions on uncached messages vanish silently.

Failures **disable the affected panel** rather than the whole bot, and surface in `status` and the dashboard. Partial function with a loud warning beats confident wrong behaviour.

---

## What this adds up to

On its first run against your real server, with these in place, Bananasaurs:

- lacks the Discord permissions to delete, kick, ban, or reconfigure anything;
- can only touch the specific roles you registered;
- stops itself after 20 role changes in a minute;
- is in dry-run and therefore performing no writes at all;
- can be fully reversed with one command;
- can be stopped from your phone;
- and refuses to start any panel whose preconditions are not met.

That is the answer to "make sure it won't break my server." Not one guarantee — seven layers, each of which independently bounds the damage, arranged so the outermost one is enforced by Discord rather than by code we wrote.

---

## Rollout sequence

1. **Test guild, dry-run off.** Prove the mechanics: panels, reactions, logging, reconciliation, undo. Break things deliberately — reorder roles, delete a panel message, take the bot offline mid-reaction, react 30 times in 10 seconds.
2. **Test guild, deliberate abuse.** Confirm the circuit breaker trips, the reconciliation budget refuses, and `doctor` catches a missing role.
3. **Real server, dry-run on, Carl-bot still running.** One week minimum. Compare decisions daily via `bananasaurs audit tail`.
4. **Real server, dry-run off, Carl-bot's role module off.** One panel first, not all of them. Verify against `docs/RELEASE1_CONFIG.md`.
5. **Remaining panels**, one at a time.
6. **Logging cutover** once role panels have been stable for a week.

Nothing about this sequence is slow in a way that costs you anything. Carl-bot keeps working the whole time.
