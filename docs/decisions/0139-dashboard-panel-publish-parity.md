# ADR 0139: dashboard panel publish matches `panel sync`, and says what it did

Status: accepted 2026-10-10.

## Context

The owner created a reaction role in the dashboard, clicked Publish, and saw "Panel not managed — Discord
refused the edit". Nothing was refused. A reaction role is an adopted panel: it attaches to a message someone
else posted, which the bot may not edit. `publishPanel` therefore answers `not-managed` by design, after it has
added the panel's emoji (`apps/daemon/src/runtime/guild.ts`). The dashboard rendered that normal answer as a failure.

Comparing the route with the CLI's `panel sync` (`packages/core/src/ops/commands/effects.ts`) found two gaps:

1. `panel sync` refuses a panel whose status is not `enabled`. The dashboard route published it anyway, putting a
   panel that `doctor` had taken out of service back in front of members.
2. `panel sync` queues a reconcile after publishing an adopted panel, so members who reacted before the panel
   existed get their roles. The dashboard did not. Those members waited for the next gateway reconnect, or for
   the owner to press a button labelled "Enqueue reconcile" that nothing explained.

The "Enqueue reconcile" button was also shown on button and dropdown panels. `reconcileGuild` walks adopted
panels only, so there it did nothing.

## Decision

- `POST /api/panels/:id/publish` answers 409 `panel-not-enabled` for a panel that is not `enabled`, before any
  Discord call. Its title, message and hint say why (ADR 0078: the server words the error).
- After publishing an adopted panel the route enqueues the same per-panel `operator` reconcile `panel sync`
  enqueues. It returns and audits `reconcileJobId` (null for managed panels).
- The dashboard reports an adopted publish as **"Reaction role is live"** (ok tone). It explains that the
  message text is unchanged and that existing reactors get their role shortly. Only refused emoji turn the toast
  to hold.
- The button becomes **Re-check reactions**. It appears only on adopted panels, with one sentence on what it is
  for. The publish confirmation describes what an adopted publish does.

Nothing re-enables a disabled panel today. The hint says to build a new one rather than naming a command that
does not exist.
