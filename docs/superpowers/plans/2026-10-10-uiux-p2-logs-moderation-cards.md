# P2 — Log, moderation, panel and assistant-meta cards; moderator buttons — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for
> tracking. Read `docs/superpowers/plans/2026-10-10-uiux-00-glm-handoff.md` first.

**Goal:** Every remaining system post the bot makes becomes a Components V2 card:
- log routes
- the `/mod` replies, previews and case history
- role panels
- assistant reminders
- the escalation post
- the AI log

Log and automod cards gain **Delete message**, **Warn** and **Timeout** buttons that run the same
deterministic code as `/mod`. Every refusal reads from one error catalogue.

**Architecture:**
- Each surface gets a pure render function next to its logic, built on the P1 card kit
  (`packages/core/src/ui/discord/`).
- The log pipeline carries a `LogCardView` instead of a string.
- The `/mod` handlers are refactored to take a normalised `ModInput`, so a slash command, a modal submit
  and a confirm click share one code path.
- Moderator buttons live in one new core subscriber, `mod/card-actions.ts`. The single-message delete
  goes through a new `ModerationActionGateway.deleteMessage` and the existing `mod_pending_actions`
  confirm handshake.

**Tech stack:** TypeScript (Node 22, strict), discord.js 14.27.0 (adapter only), Vitest. No new
dependencies. No migration.

**Spec:** `docs/superpowers/specs/2026-10-10-ui-ux-overhaul-design.md`. **Decisions:**
`docs/decisions/0141-moderator-card-actions-and-error-catalogue.md`. The ADR wins where the two differ.
**Rules:** `docs/28_UI_UX_GUIDELINES.md`.

**Base:** branch `uiux/p2-logs-moderation`, cut from `uiux/p1-task-cards` after P1 is complete. P2
assumes every P1 interface exists:
- the kit: `card`, `text`, `section`, `separator`, `button`, `actionRow`, `modal`, `label`,
  `textInput`, `radioGroup`, `escapeText`, `escapeInline`, `truncate`, `subtext`, `ts`, `jumpUrl`,
  `ICON`, `TONE_ACCENT`, `ART`
- `toOutgoingMessage`, `errorCard`, `resultCard`, `ERROR_COPY`
- `ModalSubmitEvent`, `SlashResponder.deferUpdate`, `SlashResponder.showModal`, `FakeDiscord.emitModalSubmit`

If one of them has a different name in the P1 code, use the P1 name and note it in the deviations file.

## Global Constraints

- `packages/core` must not import `discord.js`, a database, or `@bananasaurs/storage` (ADR 0014).
- Every message the bot sends sets `allowedMentions` with `parse: []`. The only exception is an
  assistant reminder whose stored row already pings `@everyone`/`@here` (ADR 0141 decision 10).
- Every member- or moderator-controlled string passes `escapeText` or `escapeInline` before it reaches a
  Text Display. That covers names, nicknames, role names, audit reasons and message content.
- Log, automod, moderation, confirmation and error cards carry **no art**.
- Members never see an error code. Moderator and owner error cards may end with `-# Ref <last 8 digits
  of the interaction id>`.
- No model call anywhere. No moderation through MCP.
- Button labels are 34 characters or fewer. Each card stays within 40 components and 4,000 text
  characters; `card()` already asserts this.
- Copy is used verbatim from this plan. New copy follows `docs/28` §2–§3: no "please", "sorry", "oops",
  "invalid" or "failed to".

## Review Focus

These are the five failure modes most likely to reach a real moderator. Each one has a test in the task
named.

1. **A non-moderator who can see a log channel presses Warn and submits the modal.** Nothing happens to
   the target, an `escalation_refused` / `unauthorized` case event is recorded exactly as `/mod warn`
   records one, and the presser gets `mod.not-allowed` privately. (Task 7)
2. **Delete is confirmed twice, or by a second moderator.** The second confirm says
   `confirm.not-yours` or `confirm.done`, and Discord's delete is called once. (Task 7)
3. **A message is deleted by someone else between the click and Confirm.** The moderator sees "That
   message was already gone", and the case event is not recorded as `deleted`. (Task 5, Task 7)
4. **Hostile text in a log card**, such as a username of `@everyone`, a role named `**x**`, or message
   content holding a 3,000-character code block. The card pings nobody, renders the text literally, and
   stays within the budget. (Task 3)
5. **The kill switch is on when a moderator confirms Delete.** No REST call is made, the case event is
   `delete_blocked_killswitch`, and the card says moderation is paused. (Task 5, Task 7)

## File structure

| File | Responsibility |
| --- | --- |
| `packages/core/src/ui/discord/tokens.ts` | modify: new icons |
| `packages/core/src/ui/discord/card.ts` | modify: `pingEveryone` |
| `packages/core/src/ui/discord/kit.ts` | modify: custom emoji by id (Task 9) |
| `packages/core/src/ui/discord/inspect.ts` | create: `cardTexts`, `cardCustomIds` for tests and the gallery |
| `packages/core/src/copy/errors.ts` | modify: `mod.*`, `confirm.*`, `panel.*` entries |
| `packages/core/src/copy/refusals.ts` | create: refusal-union → `ErrorCode` mappers, `refFor` |
| `packages/core/src/discord/port.ts` | modify: `editOriginalResponse` |
| `packages/core/src/ops/commands/slash-responder.ts` | modify: `editOriginal` |
| `packages/discord/src/rest/port.ts` | modify: `editOriginalResponse` (PATCH `@original`) |
| `packages/testkit/src/fake-discord.ts` | modify: record original edits |
| `packages/core/src/logging/cards.ts` | create: `LogCardView`, `LOG_KIND_META`, `renderLogCard`, `modActionRow` |
| `packages/core/src/logging/format.ts` | modify: formatters return `LogCardView` |
| `packages/core/src/logging/audit-items.ts` | modify: items return `LogCardView` |
| `packages/core/src/logging/member-changes.ts` | modify: changes return `LogCardView` |
| `packages/core/src/logging/subscriber.ts` | modify: `LogItem.view`, card sending |
| `packages/core/src/logging/attribute-deletion.ts` | modify: card sending |
| `packages/core/src/logging/catalog.ts` | modify: `automod_match` |
| `packages/core/src/automod/subscriber.ts` | modify: `onMatchRecorded` hook |
| `packages/core/src/effects/moderation-gateway.ts` | modify: `deleteMessage` |
| `packages/core/src/mod/custom-ids.ts` | create: `bs.mod:` ids |
| `packages/core/src/mod/cards.ts` | create: mod result, confirm and history cards; modals |
| `packages/core/src/mod/commands.ts` | modify: `ModInput`, card replies |
| `packages/core/src/mod/confirmations.ts` | modify: `delete` intent, card previews and outcomes |
| `packages/core/src/mod/history.ts` | modify: paged card |
| `packages/core/src/mod/card-actions.ts` | create: the button and modal subscriber |
| `packages/core/src/panels/components.ts`, `interactions.ts` | modify: panel card, reply cards |
| `apps/daemon/src/runtime/guild.ts` | modify: wiring |
| `apps/daemon/src/automod/wiring.ts` | modify: hook wiring |
| `apps/daemon/src/assistant/cards.ts` | create: reminder and escalation cards |
| `apps/daemon/src/assistant/reminder-delivery.ts`, `log-message.ts`, `fallback-replies.ts`, `apps/daemon/src/jobs/assistant.ts` | modify: assistant meta cards |
| `apps/daemon/src/mod-card-actions.integration.test.ts` | create: end-to-end moderator buttons |
| `scripts/card-gallery.mjs`, `docs/SMOKE_TESTS.md`, `docs/STATE.md` | modify |

---

### Task 1: Kit additions and the rest of the error catalogue

**Files:**
- Modify: `packages/core/src/ui/discord/tokens.ts`, `packages/core/src/ui/discord/card.ts`,
  `packages/core/src/ui/discord/card.test.ts`
- Modify: `packages/core/src/copy/errors.ts`
- Create: `packages/core/src/copy/refusals.ts`, `packages/core/src/copy/refusals.test.ts`
- Modify: `packages/core/src/index.ts` (export the mappers)

**Interfaces:**
- Produces:
  - `ICON` gains these keys: `message`, `member`, `channel`, `server`, `invite`, `emoji`,
    `bulkDelete`, `panel`, `history`, `escalate`, `ai`, `unban`, `note`, `gap`.
  - `card({ …, pingEveryone?: boolean })`. When it is true, `allowedMentions.parse` is
    `['everyone']`.
  - `CardMessage.allowedMentions.parse: readonly [] | readonly ['everyone']`.
  - `moderationRefusalCode(reason: ModerationRefusalReason): ErrorCode`
  - `panelRefusalCode(refusal: PanelRefusal): ErrorCode`
  - `refFor(interactionId: string): string`, which returns the last 8 characters.
  - `ERROR_COPY` gains every entry listed in Step 3.

- [ ] **Step 1: Failing tests**

Append to `packages/core/src/ui/discord/card.test.ts`:

```ts
describe('pingEveryone', () => {
  it('allows @everyone/@here only when asked', () => {
    expect(card({ tone: 'neutral', children: [text('x')] }).allowedMentions.parse).toEqual([]);
    expect(
      card({ tone: 'neutral', children: [text('x')], pingEveryone: true }).allowedMentions.parse,
    ).toEqual(['everyone']);
  });
});
```

Create `packages/core/src/copy/refusals.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ERROR_COPY } from './errors.js';
import { moderationRefusalCode, panelRefusalCode, refFor } from './refusals.js';

const MOD_REASONS = [
  'unauthorized',
  'guild-unknown',
  'killswitch',
  'breaker-open',
  'rate-cap',
  'discord-owner',
  'role-above-bot',
] as const;
const PANEL_REFUSALS = [
  'panel-disabled',
  'missing-required-role',
  'blocked-role',
  'max-roles',
  'add-only',
  'remove-only',
] as const;

describe('refusal mappers (ADR 0141 decision 11)', () => {
  it.each(MOD_REASONS)('moderation refusal %s has a moderator-facing entry', (reason) => {
    const entry = ERROR_COPY[moderationRefusalCode(reason)];
    expect(entry.audience).not.toBe('member');
  });
  it.each(PANEL_REFUSALS)('panel refusal %s has a member-facing entry', (refusal) => {
    expect(ERROR_COPY[panelRefusalCode(refusal)].audience).toBe('member');
  });
  it('a ref is the last 8 characters of the interaction id', () => {
    expect(refFor('1234567890123456789')).toBe('23456789');
  });
});
```

The `Record<…>` type in Step 4 is the real completeness check: adding a member to either union without a
mapping fails `npm run typecheck`. The lists above make the runtime test cover every member today.

Run `npx vitest run packages/core/src/copy packages/core/src/ui/discord/card.test.ts`. Expect FAIL.

- [ ] **Step 2: Icons and `pingEveryone`**

In `tokens.ts`, add these to `ICON`, before `} as const`:

```ts
  message: '💬',
  member: '👤',
  channel: '#️⃣',
  server: '🏠',
  invite: '✉️',
  emoji: '😀',
  bulkDelete: '🧹',
  panel: '🎛️',
  history: '📂',
  escalate: '🙋',
  ai: '🤖',
  unban: '🔓',
  note: '🗒️',
  gap: '⏸️',
```

In `card.ts`:
- Widen `CardMessage.allowedMentions.parse` to `readonly [] | readonly ['everyone']`.
- Add `pingEveryone?: boolean` to the options.
- Set `parse: options.pingEveryone === true ? (['everyone'] as const) : ([] as const)`.

`toOutgoingMessage` (P1 Task 2) writes `parse: []` as a literal, so on its own it would silently drop
`pingEveryone`. Change that line to `parse: [...message.allowedMentions.parse]`, and add this test to
`card.test.ts`:

```ts
it('toOutgoingMessage keeps an everyone ping the card asked for', () => {
  const out = toOutgoingMessage(card({ tone: 'neutral', children: [text('x')], pingEveryone: true }));
  expect(out.allowedMentions?.parse).toEqual(['everyone']);
  expect(toOutgoingMessage(card({ tone: 'neutral', children: [text('x')] })).allowedMentions?.parse).toEqual([]);
});
```

- [ ] **Step 3: Catalogue entries**

Append these to `ERROR_COPY` in `packages/core/src/copy/errors.ts`, inside the object and before
`} as const satisfies …`:

```ts
  'mod.not-allowed': {
    title: "You can't take moderation actions",
    detail: 'This needs the moderation permission in Bananasaurs.',
    next: 'Ask the owner if you think you should have it.',
    retryable: false,
    tone: 'hold',
    audience: 'moderator',
  },
  'mod.killswitch': {
    title: 'Moderation is paused',
    detail: 'The kill switch is on, so the bot takes no moderation actions.',
    next: 'The owner can turn it off in the dashboard under Safety.',
    retryable: false,
    tone: 'hold',
    audience: 'moderator',
  },
  'mod.breaker-open': {
    title: 'Moderation is paused for safety',
    detail: 'Too many actions went wrong in a row, so the bot stopped acting until someone checks.',
    next: 'The owner can reset it in the dashboard under Safety.',
    retryable: false,
    tone: 'hold',
    audience: 'moderator',
  },
  'mod.guild-unknown': {
    title: "This server isn't set up yet",
    detail: 'Bananasaurs has no settings for this server, so it will not act here.',
    next: 'The owner can finish setup from the dashboard.',
    retryable: false,
    tone: 'hold',
    audience: 'owner',
  },
  'mod.rate-cap': {
    title: 'Too many actions just now',
    detail: 'The bot limits how many moderation actions it takes in a short time.',
    next: 'Wait a minute, then try again.',
    retryable: true,
    tone: 'hold',
    audience: 'moderator',
  },
  'mod.discord-owner': {
    title: "The server owner can't be moderated",
    detail: "Discord doesn't let any bot act on the server owner.",
    retryable: false,
    tone: 'hold',
    audience: 'moderator',
  },
  'mod.role-above-bot': {
    title: 'That member is above the bot',
    detail: "Their highest role is at or above the bot's, so Discord won't let it act on them.",
    next: "Move the bot's role higher in Server Settings → Roles, or ask someone with a higher role.",
    retryable: false,
    tone: 'hold',
    audience: 'moderator',
  },
  'mod.discord-error': {
    title: "Discord didn't accept that",
    detail: 'The bot sent the action, but Discord answered with an error.',
    next: "Try again in a minute. If it keeps happening, check the bot's permissions here.",
    retryable: true,
    tone: 'danger',
    audience: 'moderator',
  },
  'mod.unavailable': {
    title: "Couldn't finish that",
    detail: "Something went wrong on the bot's side, and the action may not have run.",
    next: "Check the member's case history before trying again. Give the owner the Ref below.",
    retryable: true,
    tone: 'danger',
    audience: 'moderator',
  },
  'mod.over-budget': {
    title: 'Too many messages to purge at once',
    detail: 'A purge can remove a limited number of messages in one go.',
    next: 'Purge a quieter channel, or ask the owner to clear it from Discord.',
    retryable: false,
    tone: 'hold',
    audience: 'moderator',
  },
  'confirm.expired': {
    title: 'This confirmation expired',
    detail: 'A confirmation lasts 15 minutes.',
    next: 'Start again from the command or the log card.',
    retryable: false,
    tone: 'hold',
    audience: 'moderator',
  },
  'confirm.done': {
    title: 'This was already handled',
    detail: 'It was confirmed or cancelled already.',
    retryable: false,
    tone: 'hold',
    audience: 'moderator',
  },
  'confirm.not-yours': {
    title: 'Only the moderator who started this can confirm it',
    detail: 'A confirmation belongs to the person who asked for it.',
    next: 'Start your own from the command or the log card.',
    retryable: false,
    tone: 'hold',
    audience: 'moderator',
  },
  'panel.panel-disabled': {
    title: 'This panel is switched off',
    detail: 'An organiser has turned it off for now.',
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'panel.missing-required-role': {
    title: 'You need another role first',
    detail: 'This panel is only for members who already have a certain role.',
    next: 'Ask an organiser which role you need.',
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'panel.blocked-role': {
    title: "This panel isn't available to you",
    detail: "One of your roles means you can't use it.",
    next: "Ask an organiser if you think that's wrong.",
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'panel.max-roles': {
    title: "You've reached this panel's limit",
    detail: 'It allows only so many of its roles at once.',
    next: 'Remove one, then pick again.',
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'panel.add-only': {
    title: 'This panel only adds roles',
    detail: "It can't take a role away.",
    next: 'Ask an organiser to remove it for you.',
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'panel.remove-only': {
    title: 'This panel only removes roles',
    detail: "It can't hand roles out.",
    next: 'Ask an organiser how to get the role.',
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'panel.not-applied': {
    title: "Couldn't change your roles",
    detail: "The bot couldn't apply the change just now. An organiser can see why in the dashboard.",
    next: 'Try again in a minute.',
    retryable: true,
    tone: 'danger',
    audience: 'member',
  },
  'panel.unavailable': {
    title: "Couldn't handle that",
    detail: "Something went wrong on the bot's side, so your roles didn't change.",
    next: 'Try again in a minute.',
    retryable: true,
    tone: 'danger',
    audience: 'member',
  },
```

The P1 copy test now runs over these entries too. Fix any entry it rejects by rewording it, never by
loosening the test.

- [ ] **Step 4: `packages/core/src/copy/refusals.ts`**

```ts
import type { ModerationRefusalReason } from '../effects/moderation-gateway.js';
import type { PanelRefusal } from '../panels/convergence.js';
import type { ErrorCode } from './errors.js';

/** ADR 0141 decision 11: every refusal union maps to one catalogue entry; `tsc` enforces completeness. */
const MODERATION: Readonly<Record<ModerationRefusalReason, ErrorCode>> = {
  unauthorized: 'mod.not-allowed',
  'guild-unknown': 'mod.guild-unknown',
  killswitch: 'mod.killswitch',
  'breaker-open': 'mod.breaker-open',
  'rate-cap': 'mod.rate-cap',
  'discord-owner': 'mod.discord-owner',
  'role-above-bot': 'mod.role-above-bot',
};

const PANEL: Readonly<Record<PanelRefusal, ErrorCode>> = {
  'panel-disabled': 'panel.panel-disabled',
  'missing-required-role': 'panel.missing-required-role',
  'blocked-role': 'panel.blocked-role',
  'max-roles': 'panel.max-roles',
  'add-only': 'panel.add-only',
  'remove-only': 'panel.remove-only',
};

export const moderationRefusalCode = (reason: ModerationRefusalReason): ErrorCode =>
  MODERATION[reason];

export const panelRefusalCode = (refusal: PanelRefusal): ErrorCode => PANEL[refusal];

/** The short reference a moderator or owner can quote; log lines carry the full interaction id. */
export const refFor = (interactionId: string): string => interactionId.slice(-8);
```

If `PanelRefusal` has members beyond the six listed, `tsc` will name them. Add an entry and a mapping for
each, and add them to the test list.

Export `moderationRefusalCode`, `panelRefusalCode` and `refFor` from `packages/core/src/index.ts`, next to
the P1 catalogue exports.

- [ ] **Step 5: Run the tests, then gates and commit**

```bash
npx vitest run packages/core/src/copy packages/core/src/ui/discord
npm run typecheck
npm run lint
npm run test
git add packages/core
git commit -m "P2 Task 1: icons, pingEveryone, moderation and panel error copy"
```

---

### Task 2: Edit the original interaction response

**Files:**
- Modify: `packages/core/src/discord/port.ts`, `packages/core/src/ops/commands/slash-responder.ts`
- Modify: `packages/discord/src/rest/port.ts`, `packages/discord/src/rest/port.test.ts`
- Modify: `packages/testkit/src/fake-discord.ts` and its test
- Modify: every other `DiscordPort` implementer that `npm run typecheck` names (stub with the file's
  existing "not used" helper, as P1 Task 2 did)
- Modify: `apps/daemon/src/runtime/guild.ts`, wherever a `SlashResponder` object is built

**Interfaces:**
- Produces:
  - `DiscordPort.editOriginalResponse(guildId: Snowflake, ref: InteractionRef, message: OutgoingMessage): Promise<void>`
  - `SlashResponder.editOriginal(ref: InteractionRef, message: OutgoingMessage): Promise<void>`
  - `FakeDiscord.originalEdits: { interactionId: string; message: OutgoingMessage }[]`
- Consumes: P1's `toRestMessage` (with flags and attachments), the `restFiles` helper and the
  `multipartSummary` test helper.

- [ ] **Step 1: Failing REST test**

In `packages/discord/src/rest/port.test.ts`, next to the P1 `deferUpdate` tests, add a test using the
same harness. Call
`port.editOriginalResponse(GUILD, { interactionId: '111111111111111111', token: 'tok' }, { components: [{ type: 17, accent_color: 1, components: [] }], flags: 32768, allowedMentions: { parse: [] } })`.

Assert one request:
- method `PATCH`
- path `/webhooks/<APPLICATION_ID>/tok/messages/@original`
- no `Authorization` header
- a body with `flags: 32768`, `components` with one entry, `allowed_mentions: { parse: [] }`, and
  `content: null` and `embeds: null` (V2 opt-in, as P1's `editMessage` does)

Add a second test: a message with `files` is sent multipart, and `multipartSummary` lists the file.

Run `npx vitest run packages/discord/src/rest/port.test.ts`. Expect FAIL.

- [ ] **Step 2: Implement**

`packages/core/src/discord/port.ts`, in `DiscordPort` next to `respondToInteraction`:

```ts
  /**
   * Replace the message an interaction answered with, or the message a
   * component sits on after `deferUpdate` (PATCH …/messages/@original, ADR 0141
   * decision 9). Token-authenticated, like every interaction route.
   */
  editOriginalResponse(guildId: Snowflake, ref: InteractionRef, message: OutgoingMessage): Promise<void>;
```

`packages/discord/src/rest/port.ts`, next to `respondToInteraction`, in the same style P1 used for
`editMessage`:

```ts
    async editOriginalResponse(_guildId, ref, message) {
      const files = restFiles(message);
      const v2 = ((message.flags ?? 0) & IS_COMPONENTS_V2) !== 0;
      await mapErrors(() =>
        rest.patch(Routes.webhookMessage(applicationId, ref.token, '@original'), {
          body: { ...toRestMessage(message), ...(v2 ? { content: null, embeds: null } : {}) },
          ...(files.length > 0 ? { files } : {}),
          auth: false,
        }),
      );
    },
```

Use whatever constant name P1 gave the V2 flag in this file. If `Routes.webhookMessage` takes different
arguments, read its signature in `node_modules/discord-api-types/rest/v10/index.d.ts` and match it.

`slash-responder.ts`:

```ts
  /** Replace the card this interaction's component sits on (after `deferUpdate`). */
  editOriginal(ref: InteractionRef, message: OutgoingMessage): Promise<void>;
```

FakeDiscord: add `readonly originalEdits: { interactionId: string; message: OutgoingMessage }[] = [];`
and an `editOriginalResponse` that pushes to it. Add a test that it records.

In `guild.ts`, each responder object passed to a core subscriber gets
`editOriginal: (ref, message) => discord.editOriginalResponse(guildId, ref, message)`.

- [ ] **Step 3: Gates and commit**

```bash
npm run typecheck
npm run lint
npm run test
git add packages apps
git commit -m "P2 Task 2: editOriginalResponse for in-place card updates"
```

---

### Task 3: Log routes post cards

**Files:**
- Create: `packages/core/src/logging/cards.ts`, `packages/core/src/logging/cards.test.ts`
- Create: `packages/core/src/mod/custom-ids.ts`, `packages/core/src/mod/custom-ids.test.ts`
- Modify: `packages/core/src/logging/format.ts`, `format.test.ts`
- Modify: `packages/core/src/logging/audit-items.ts`, `audit-items.test.ts`
- Modify: `packages/core/src/logging/member-changes.ts`, `member-changes.test.ts`
- Modify: `packages/core/src/logging/subscriber.ts`, `subscriber.test.ts`
- Modify: `packages/core/src/logging/attribute-deletion.ts`, `attribute-deletion.test.ts`
- Modify: `apps/daemon/src/runtime/guild.ts` (the `LoggingPorts.sendMessage` binding and `formatWarn`
  use)
- Modify: `apps/daemon/src/logging.integration.test.ts`, `apps/daemon/src/logging-deletion.integration.test.ts`
  (assert cards)

**Interfaces:**
- Produces in `mod/custom-ids.ts`:

  ```ts
  export type ModCardAction =
    | { action: 'delete'; channelId: string; messageId: string; authorId: string }
    | { action: 'warn'; userId: string }
    | { action: 'timeout'; userId: string }
    | { action: 'history'; userId: string; page: number };
  export const buildModCustomId: (a: ModCardAction) => string;
  export const parseModCustomId: (raw: string) => ModCardAction | undefined;
  ```

- Produces in `logging/cards.ts`:

  ```ts
  export type LogCardKind = /* every LOG_EVENT_KINDS value, plus 'gap' */ string;
  export interface LogCardView {
    readonly kind: LogCardKind;
    /** One line of already-safe Markdown: mentions and escaped names only. */
    readonly headline: string;
    /** Further already-safe lines. */
    readonly details?: readonly string[];
    /** Untrusted text shown as a quote, escaped here. */
    readonly quote?: { readonly label: string; readonly text: string; readonly spoiler?: boolean };
    /** Audit change lines, shown in a code block. */
    readonly changes?: readonly string[];
    readonly at: number;
    /** Enables Warn/Timeout when set and the kind allows actions. */
    readonly memberId?: string;
    /** Enables Delete and the jump link when set and the kind allows it. */
    readonly message?: { readonly channelId: string; readonly messageId: string; readonly exists: boolean };
  }
  export const LOG_KIND_META: Readonly<Record<string, { icon: IconName; label: string; tone: Tone }>>;
  export const renderLogCard: (view: LogCardView, guildId: string) => CardMessage;
  export const modActionRow: (input: {
    memberId?: string;
    message?: { channelId: string; messageId: string; exists: boolean };
  }) => ActionRow | undefined;
  ```

- Changes:
  - `LogItem.render(includeContent): string` becomes `LogItem.view(includeContent): LogCardView`.
  - `AuditItem.render(): string` becomes `AuditItem.view(at: number): LogCardView`.
  - `MemberChange.render(): string` becomes `MemberChange.view(at: number): LogCardView`.
  - `LoggingPorts.sendMessage(channelId, message: OutgoingMessage)`.
  - Each `format*` function returns `LogCardView`. `formatGapMarker` keeps its name and returns a
    `LogCardView` of kind `'gap'`.

- [ ] **Step 1: Custom ids, test first**

`packages/core/src/mod/custom-ids.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildModCustomId, parseModCustomId } from './custom-ids.js';

const C = '111111111111111111';
const M = '222222222222222222';
const U = '333333333333333333';

describe('bs.mod custom ids', () => {
  it.each([
    { action: 'delete', channelId: C, messageId: M, authorId: U },
    { action: 'warn', userId: U },
    { action: 'timeout', userId: U },
    { action: 'history', userId: U, page: 3 },
  ] as const)('round-trips %o', (a) => {
    const id = buildModCustomId(a);
    expect(id.length).toBeLessThanOrEqual(100);
    expect(parseModCustomId(id)).toEqual(a);
  });
  it.each([
    'bs.mod:delete:1:2:3',
    'bs.mod:warn:abc',
    'bs.mod:history:333333333333333333:-1',
    'bs.mod:ban:333333333333333333',
    'bs.task:start:x:1',
    'modconfirm:abc',
    `bs.mod:warn:${'1'.repeat(200)}`,
  ])('ignores %s', (raw) => {
    expect(parseModCustomId(raw)).toBeUndefined();
  });
});
```

`packages/core/src/mod/custom-ids.ts`:

```ts
import { z } from 'zod';
import { snowflakeIdSchema } from '../ids.js';

/** ADR 0141 decision 5: targets travel in the id; every effect re-authorises the clicker. */
export type ModCardAction =
  | { action: 'delete'; channelId: string; messageId: string; authorId: string }
  | { action: 'warn'; userId: string }
  | { action: 'timeout'; userId: string }
  | { action: 'history'; userId: string; page: number };

const PREFIX = 'bs.mod';

export const buildModCustomId = (a: ModCardAction): string => {
  switch (a.action) {
    case 'delete':
      return `${PREFIX}:delete:${a.channelId}:${a.messageId}:${a.authorId}`;
    case 'warn':
    case 'timeout':
      return `${PREFIX}:${a.action}:${a.userId}`;
    case 'history':
      return `${PREFIX}:history:${a.userId}:${a.page}`;
  }
};

const id = snowflakeIdSchema;
const page = z.coerce.number().int().min(0).max(999);

export const parseModCustomId = (raw: string): ModCardAction | undefined => {
  if (raw.length > 100 || !raw.startsWith(`${PREFIX}:`)) return undefined;
  const parts = raw.split(':');
  const action = parts[1];
  if (action === 'delete' && parts.length === 5) {
    const parsed = z.tuple([id, id, id]).safeParse(parts.slice(2));
    return parsed.success
      ? { action, channelId: parsed.data[0], messageId: parsed.data[1], authorId: parsed.data[2] }
      : undefined;
  }
  if ((action === 'warn' || action === 'timeout') && parts.length === 3) {
    const parsed = id.safeParse(parts[2]);
    return parsed.success ? { action, userId: parsed.data } : undefined;
  }
  if (action === 'history' && parts.length === 4) {
    const parsed = z.tuple([id, page]).safeParse(parts.slice(2));
    return parsed.success ? { action, userId: parsed.data[0], page: parsed.data[1] } : undefined;
  }
  return undefined;
};
```

If `snowflakeIdSchema` yields a branded type, keep the brand in `ModCardAction` (`SnowflakeId`), or
`String()` it. Either is fine, as long as the round-trip test passes.

- [ ] **Step 2: Failing card tests** (`packages/core/src/logging/cards.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { countComponents, countText } from '../ui/discord/budget.js';
import { renderLogCard, type LogCardView } from './cards.js';

const G = '100000000000000000';
const C = '111111111111111111';
const M = '222222222222222222';
const U = '333333333333333333';
const AT = 1_760_000_000_000;

const texts = (c: { components: readonly unknown[] }): string => {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v !== 'object' || v === null) return;
    const o = v as Record<string, unknown>;
    if (o['type'] === 10 && typeof o['content'] === 'string') out.push(o['content']);
    walk(o['components']);
  };
  walk(c.components);
  return out.join('\n');
};
const customIds = (c: { components: readonly unknown[] }): string[] =>
  JSON.stringify(c.components).match(/bs\.mod:[^"]+/g) ?? [];

const edit: LogCardView = {
  kind: 'message_edit',
  headline: `<@${U}> edited a message in <#${C}>`,
  quote: { label: 'Now reads', text: 'hello **world** @everyone' },
  at: AT,
  memberId: U,
  message: { channelId: C, messageId: M, exists: true },
};

describe('renderLogCard', () => {
  it('has an eyebrow, the headline, an escaped quote, a jump link and a relative time', () => {
    const t = texts(renderLogCard(edit, G));
    expect(t).toContain('-# ✏️ MESSAGE EDITED');
    expect(t).toContain(`<@${U}> edited a message in <#${C}>`);
    expect(t).toContain('**Now reads**\n> hello \\*\\*world\\*\\* @​everyone');
    expect(t).toContain(`https://discord.com/channels/${G}/${C}/${M}`);
    expect(t).toContain(`<t:${AT / 1000}:R>`);
  });

  it('never pings and carries no art', () => {
    const c = renderLogCard(edit, G);
    expect(c.allowedMentions).toEqual({ parse: [] });
    expect(c.art).toEqual([]);
  });

  it('offers Delete, Warn and Timeout on a message that still exists', () => {
    expect(customIds(renderLogCard(edit, G))).toEqual([
      `bs.mod:delete:${C}:${M}:${U}`,
      `bs.mod:warn:${U}`,
      `bs.mod:timeout:${U}`,
    ]);
  });

  it('drops Delete when the message is gone', () => {
    const c = renderLogCard({ ...edit, kind: 'message_delete', message: { channelId: C, messageId: M, exists: false } }, G);
    expect(customIds(c)).toEqual([`bs.mod:warn:${U}`, `bs.mod:timeout:${U}`]);
  });

  it('offers nothing on kinds that are not conduct', () => {
    const c = renderLogCard({ kind: 'member_nickname_changed', headline: `<@${U}> changed nickname`, at: AT, memberId: U }, G);
    expect(customIds(c)).toEqual([]);
  });

  it('spoilers a quote when asked', () => {
    const t = texts(renderLogCard({ ...edit, kind: 'automod_match', quote: { label: 'Matched', text: 'bad', spoiler: true } }, G));
    expect(t).toContain('> ||bad||');
  });

  it('caps hostile content and stays in budget', () => {
    const c = renderLogCard({ ...edit, quote: { label: 'Now reads', text: '```'.repeat(2000) } }, G);
    expect(countText(c.components)).toBeLessThanOrEqual(4000);
    expect(countComponents(c.components)).toBeLessThanOrEqual(40);
  });

  it('shows audit changes in a code block that cannot be closed early', () => {
    const t = texts(renderLogCard({ kind: 'channel_update', headline: 'Channel changed', changes: ['name: "a" → "b```"'], at: AT }, G));
    expect(t).toContain('```\nname: "a" → "bˋˋˋ"\n```');
  });

  it('uses each kind’s tone', () => {
    const accent = (c: { components: readonly unknown[] }) =>
      (c.components[0] as { accent_color: number }).accent_color;
    expect(accent(renderLogCard({ kind: 'member_ban', headline: 'x', at: AT }, G))).toBe(0xd64545);
    expect(accent(renderLogCard({ kind: 'automod_match', headline: 'x', at: AT }, G))).toBe(0xe0a526);
    expect(accent(renderLogCard({ kind: 'member_join', headline: 'x', at: AT }, G))).toBe(0x64748b);
  });
});
```

- [ ] **Step 3: Implement `packages/core/src/logging/cards.ts`**

```ts
import { buildModCustomId } from '../mod/custom-ids.js';
import { card, type CardMessage } from '../ui/discord/card.js';
import { actionRow, button, separator, text, type ActionRow, type ContainerChild } from '../ui/discord/kit.js';
import { escapeText, jumpUrl, subtext, truncate, ts } from '../ui/discord/text.js';
import { ICON, type IconName, type Tone } from '../ui/discord/tokens.js';

export type LogCardKind = string;

export interface LogCardView {
  readonly kind: LogCardKind;
  readonly headline: string;
  readonly details?: readonly string[];
  readonly quote?: { readonly label: string; readonly text: string; readonly spoiler?: boolean };
  readonly changes?: readonly string[];
  readonly at: number;
  readonly memberId?: string;
  readonly message?: { readonly channelId: string; readonly messageId: string; readonly exists: boolean };
}

type Meta = { icon: IconName; label: string; tone: Tone };

/** One row per kind (ADR 0141 decision 1). Labels are upper-cased in the eyebrow. */
export const LOG_KIND_META: Readonly<Record<string, Meta>> = {
  message_create: { icon: 'message', label: 'Message sent', tone: 'neutral' },
  message_edit: { icon: 'edited', label: 'Message edited', tone: 'neutral' },
  message_delete: { icon: 'deleted', label: 'Message deleted', tone: 'neutral' },
  message_bulk_delete: { icon: 'bulkDelete', label: 'Messages purged', tone: 'danger' },
  member_join: { icon: 'joined', label: 'Member joined', tone: 'neutral' },
  member_leave: { icon: 'left', label: 'Member left', tone: 'neutral' },
  member_roles_changed: { icon: 'roles', label: 'Roles changed', tone: 'neutral' },
  member_nickname_changed: { icon: 'member', label: 'Nickname changed', tone: 'neutral' },
  member_username_changed: { icon: 'member', label: 'Name changed', tone: 'neutral' },
  member_avatar_changed: { icon: 'member', label: 'Avatar changed', tone: 'neutral' },
  member_warn: { icon: 'warned', label: 'Member warned', tone: 'danger' },
  member_kick: { icon: 'kick', label: 'Member kicked', tone: 'danger' },
  member_ban: { icon: 'ban', label: 'Member banned', tone: 'danger' },
  member_unban: { icon: 'unban', label: 'Member unbanned', tone: 'neutral' },
  member_timeout: { icon: 'timeout', label: 'Member timed out', tone: 'danger' },
  member_timeout_removed: { icon: 'timeout', label: 'Timeout removed', tone: 'neutral' },
  role_create: { icon: 'roles', label: 'Role created', tone: 'neutral' },
  role_update: { icon: 'roles', label: 'Role changed', tone: 'neutral' },
  role_delete: { icon: 'roles', label: 'Role deleted', tone: 'neutral' },
  channel_create: { icon: 'channel', label: 'Channel created', tone: 'neutral' },
  channel_update: { icon: 'channel', label: 'Channel changed', tone: 'neutral' },
  channel_delete: { icon: 'channel', label: 'Channel deleted', tone: 'neutral' },
  thread_create: { icon: 'channel', label: 'Thread created', tone: 'neutral' },
  thread_delete: { icon: 'channel', label: 'Thread deleted', tone: 'neutral' },
  guild_update: { icon: 'server', label: 'Server changed', tone: 'neutral' },
  guild_available: { icon: 'server', label: 'Server available', tone: 'neutral' },
  guild_unavailable: { icon: 'server', label: 'Server unavailable', tone: 'hold' },
  invite_create: { icon: 'invite', label: 'Invite created', tone: 'neutral' },
  invite_delete: { icon: 'invite', label: 'Invite deleted', tone: 'neutral' },
  emoji_create: { icon: 'emoji', label: 'Emoji added', tone: 'neutral' },
  emoji_update: { icon: 'emoji', label: 'Emoji changed', tone: 'neutral' },
  emoji_delete: { icon: 'emoji', label: 'Emoji removed', tone: 'neutral' },
  sticker_create: { icon: 'emoji', label: 'Sticker added', tone: 'neutral' },
  sticker_update: { icon: 'emoji', label: 'Sticker changed', tone: 'neutral' },
  sticker_delete: { icon: 'emoji', label: 'Sticker removed', tone: 'neutral' },
  automod_action: { icon: 'automod', label: 'Discord AutoMod', tone: 'hold' },
  automod_match: { icon: 'automod', label: 'Automod match', tone: 'hold' },
  gap: { icon: 'gap', label: 'Logging paused', tone: 'hold' },
};

const FALLBACK: Meta = { icon: 'server', label: 'Server event', tone: 'neutral' };

/** ADR 0141 decision 4: conduct kinds only. */
const ACTION_KINDS: ReadonlySet<string> = new Set([
  'message_create',
  'message_edit',
  'message_delete',
  'automod_match',
  'automod_action',
]);

const QUOTE_MAX = 1500;
const CHANGES_MAX = 1200;

/** Delete (when the message exists), Warn and Timeout. Undefined when there is nothing to offer. */
export const modActionRow = (input: {
  memberId?: string;
  message?: { channelId: string; messageId: string; exists: boolean };
}): ActionRow | undefined => {
  const buttons = [];
  if (input.message?.exists === true && input.memberId !== undefined)
    buttons.push(
      button({
        customId: buildModCustomId({
          action: 'delete',
          channelId: input.message.channelId,
          messageId: input.message.messageId,
          authorId: input.memberId,
        }),
        label: 'Delete message',
        style: 'danger',
      }),
    );
  if (input.memberId !== undefined) {
    buttons.push(button({ customId: buildModCustomId({ action: 'warn', userId: input.memberId }), label: 'Warn' }));
    buttons.push(
      button({ customId: buildModCustomId({ action: 'timeout', userId: input.memberId }), label: 'Timeout' }),
    );
  }
  return buttons.length === 0 ? undefined : actionRow(buttons);
};

const quoteBlock = (q: NonNullable<LogCardView['quote']>): string => {
  const body = escapeText(truncate(q.text.trim() === '' ? '(empty)' : q.text, QUOTE_MAX));
  const wrapped = q.spoiler === true ? `||${body}||` : body;
  return [`**${q.label}**`, ...wrapped.split('\n').map((line) => `> ${line}`)].join('\n');
};

const changesBlock = (lines: readonly string[]): string =>
  ['```', truncate(lines.join('\n').replaceAll('```', 'ˋˋˋ'), CHANGES_MAX), '```'].join('\n');

export const renderLogCard = (view: LogCardView, guildId: string): CardMessage => {
  const meta = LOG_KIND_META[view.kind] ?? FALLBACK;
  const head = [subtext(`${ICON[meta.icon]} ${meta.label.toUpperCase()}`), view.headline, ...(view.details ?? [])];
  const children: ContainerChild[] = [text(head.join('\n'))];
  if (view.quote !== undefined) children.push(text(quoteBlock(view.quote)));
  if (view.changes !== undefined && view.changes.length > 0) children.push(text(changesBlock(view.changes)));
  const row = ACTION_KINDS.has(view.kind)
    ? modActionRow({
        ...(view.memberId === undefined ? {} : { memberId: view.memberId }),
        ...(view.message === undefined ? {} : { message: view.message }),
      })
    : undefined;
  if (row !== undefined) children.push(separator(), row);
  const footer = [ts(view.at, 'R')];
  if (view.message !== undefined && view.message.exists)
    footer.push(`[Jump to message](${jumpUrl(guildId, view.message.channelId, view.message.messageId)})`);
  children.push(text(subtext(footer.join(' · '))));
  return card({ tone: meta.tone, children });
};
```

Check P1's helper signatures and adapt the calls: `jumpUrl(guildId, channelId, messageId)`,
`ts(ms, style)`, `subtext(s)`. Check whether `escapeText` already turns `@` into `@​`; the test
expects it to. Make sure the long-quote test passes: `truncate` must run before `escapeText` grows the
text. If it does not stay under 4,000, lower `QUOTE_MAX`. Run `npx vitest run packages/core/src/logging/cards.test.ts`
and expect PASS.

- [ ] **Step 4: Formatters return views — tests first**

Rewrite `packages/core/src/logging/format.test.ts`. Every formatter now returns a `LogCardView`. Assert
on its fields, not on rendered text:

| Formatter | Expected view |
| --- | --- |
| `formatMessageEdit(event, true)` | `kind 'message_edit'`, headline `<@author> edited a message in <#channel>`, `quote { label: 'Now reads', text: content }`, `memberId: author`, `message { exists: true }` |
| `formatMessageEdit(event, false)` | no `quote`; `details ['-# Content is not logged on this route.']` |
| `formatMessageEdit(event with content undefined, true)` | `details ['-# The new content was not available.']` |
| `formatMessageDelete(payload, actor)` | headline `Message by <@author> deleted in <#channel>`; `details ['Deleted by <@actor> (inferred)']`, or `['Deleted by: unknown']` with no actor; `quote { label: 'It read', text }` only when there is content; `message { exists: false }` |
| `formatMemberJoin` | `kind 'member_join'`, headline `<@user> joined` |
| `formatMemberLeave` | headline `<@user> left` (never says why — keep the docstring) |
| `formatMemberRolesChanged(u, [a], [r])` | headline `<@u>'s roles changed`, `details ['Added <@&a>', 'Removed <@&r>']`; omit an empty side |
| `formatMemberNicknameChanged(u, 'a*', undefined)` | headline `<@u> changed nickname`, `details ['a\\* → (none)']` (escaped) |
| `formatMemberUsernameChanged` | one `details` line per changed name, escaped, `Username: old → new` / `Display name: old → new` |
| `formatMemberAvatarChanged` | `details` lines `Avatar: <url>` / `Avatar: removed`, `Server avatar: …` |
| `formatRoleCreate/Update/Delete` | headline `Role **<escaped name>** created` / `changed` / `deleted`, `details ['-# <roleId>']` |
| `formatWarn` | `kind 'member_warn'`, headline `<@member> was warned by <@actor>`, `quote { label: 'Reason', text: reason }`, `details ['Case <first 8 characters of caseId> · warning <n>']` (the same short form Task 6's `caseRef` uses) |
| `formatGapMarker(a, b)` | `kind 'gap'`, headline `Bananasaurs was disconnected from <t:a:t> to <t:b:t>.`, `details ['Message, member and role events in that window were not captured.']` |

Each formatter takes `at: number` as a new last parameter (the event's `receivedAtMs`, or the caller's
`now`), and the view's `at` is that value. Names, nicknames and role names go through `escapeInline`.
Keep every existing docstring; update its wording where it says "string" or "line".

Write the new tests, run them and watch them fail. Then change each function in `format.ts` to build
the view in the table. The `message_create` render that lives inline in `subscriber.ts` moves into a new
`formatMessageCreate(event, includeContent, at)`, with headline `<@author> sent a message in <#channel>`,
the quote label `Message`, `message { exists: true }`, and `memberId`.

- [ ] **Step 5: Audit items and member changes**

`audit-items.ts`:
- `AuditItem` becomes `{ eventKind: string; view(at: number): LogCardView }`.
- `makeItem(event, kind, firstLineBase, extraLines)` builds:
  - `headline: firstLineBase + actorSuffix(event)`
  - `changes: extraLines.map((l) => l.trim())` when there are any
  - `quote: { label: 'Reason', text: truncateReason(reason) }` when there is a reason
  - `memberId: event.targetId` for member kinds only (`member_*`)
  - `at`
- Role and emoji names inside headlines go through `escapeInline`.

In `audit-items.test.ts`, replace the string assertions with view assertions of the same facts. Each
existing test keeps its intent; for example, "a kick names the target and the actor" now asserts
`headline` contains both mentions.

`member-changes.ts`:
- `MemberChange` becomes `{ eventKind; view(at: number): LogCardView }`, built from the new
  formatters.
- In `subscriber.ts`, the `memberUpdate` fingerprint hashes `JSON.stringify(change.view(0))` instead of
  the text. `at` is excluded so a replay hashes identically.

- [ ] **Step 6: Subscriber, deletion job and daemon**

`subscriber.ts`:

1. `LogItem` becomes:

   ```ts
   interface LogItem {
     eventKind: string;
     fingerprint: string;
     source: LogSource | undefined;
     view(includeContent: boolean): LogCardView;
   }
   ```

   Every `render: …` in `logItemsFor` becomes `view: (includeContent) => formatX(…, event.receivedAtMs)`.
   - `guildCreate`: `{ kind: 'guild_available', headline: 'The server became available to Bananasaurs.', at }`
   - `guildDelete`: `{ kind: 'guild_unavailable', headline: 'The server became unavailable to Bananasaurs.', at }`
   - `messageDeleteBulk`: `{ kind: 'message_bulk_delete', headline: \`${n} messages were purged in <#${channelId}>\`, at }`
   - `autoModerationAction`:

     ```ts
     {
       kind: 'automod_action',
       headline: `Discord AutoMod acted on a message by <@${userId}>`,
       details: [`Action: ${actionLabel}`, `-# Rule ${ruleId}`],
       memberId: userId,
       ...(messageId && channelId ? { message: { channelId, messageId, exists: true } } : {}),
       at,
     }
     ```

     `actionLabel` maps the action to words: `block_message` → `Blocked the message`,
     `send_alert_message` → `Sent an alert`, `timeout` → `Timed the member out`,
     `block_member_interaction` → `Blocked an interaction`, anything else → `Other`. Read
     `NativeAutoModAction` in `discord/events.ts` for the real member names.
2. `LoggingPorts.sendMessage` becomes `sendMessage(channelId: Snowflake, message: OutgoingMessage): Promise<unknown>`.
3. In `postItems` and `postGapMarkers`, send
   `toOutgoingMessage(renderLogCard(item.view(route.includeContent), ports.guildId))`. Do the same in
   `postGapMarkers` with `formatGapMarker(…, event.receivedAtMs)`.

`attribute-deletion.ts`: send
`toOutgoingMessage(renderLogCard(formatMessageDelete(…, actorId, payload.deletedAtMs), ports.guildId))`.
If the job's ports type has its own `sendMessage`, widen it the same way.

`apps/daemon/src/runtime/guild.ts`:
- `loggingPorts.sendMessage` passes the message straight to `discord.sendMessage(guildId, channelId, message)`.
- The `member_warn` poster's `render: () => formatWarn(info)` becomes
  `view: () => formatWarn(info, now())`.

Update the subscriber, attribute-deletion and daemon integration tests. They assert:
- `flags: 32768`
- `allowedMentions: { parse: [] }`
- the eyebrow (`MESSAGE EDITED`, …), the mentions, and `(inferred)`
- the absence of content when `include_content` is off

Every fact the old test asserted must still be asserted. Only the shape changes.

- [ ] **Step 7: Gates and commit**

```bash
npm run typecheck
npm run lint
npm run test
git add packages/core apps/daemon
git commit -m "P2 Task 3: log routes post cards with moderator buttons on conduct kinds"
```

---

### Task 4: Automod matches are posted to log routes

**Files:**
- Modify: `packages/core/src/automod/subscriber.ts`, `subscriber.test.ts`
- Modify: `packages/core/src/logging/subscriber.ts` (`LOG_EVENT_KINDS` gains `automod_match`)
- Modify: `packages/core/src/logging/catalog.ts`, `catalog.test.ts`
- Modify: `packages/core/src/logging/format.ts` (`formatAutomodMatch`)
- Modify: `apps/daemon/src/automod/wiring.ts`, `wiring.test.ts`
- Test: `apps/daemon/src/automod.integration.test.ts`

**Interfaces:**
- Produces:
  - `AutomodSubscriberDeps.onMatchRecorded?: (info: AutomodMatchInfo) => Promise<void>`
  - `interface AutomodMatchInfo { ruleId: string; ruleKind: string; memberId: string; channelId: string; messageId: string; snippet: string; actionTaken: AutomodActionTaken; at: number }`
  - `formatAutomodMatch(info: AutomodMatchInfo, includeContent: boolean): LogCardView`

- [ ] **Step 1: Failing tests**

In `packages/core/src/automod/subscriber.test.ts`, add:

1. On a Watch-mode match, `onMatchRecorded` is called once, **after** `recordCaseEvent`, with
   `actionTaken: 'would_delete'`, the rule's id and kind, the member, channel and message ids, and the
   matched snippet.
2. On an On-mode match whose delete succeeds, it is called with `actionTaken: 'deleted'` or
   `'deleted_and_escalated'`.
3. If `onMatchRecorded` rejects, the subscriber still resolves, logs an error with `component: 'automod'`,
   and the case event stays recorded.
4. A message that matches no rule never calls it.

In `packages/core/src/logging/format.test.ts`, add tests for `formatAutomodMatch`:

| Input | Expected view |
| --- | --- |
| `would_delete`, include content | `kind 'automod_match'`; headline `<@member> matched a **<escaped rule kind>** rule in <#channel>`; `details ['Watch only — nothing was done.']`; `quote { label: 'Matched', text: snippet, spoiler: true }`; `message { exists: true }`; `memberId` |
| `deleted` | `details ['The message was deleted.']`, `message { exists: false }` |
| `delete_blocked_killswitch` | `details ['Not deleted: the kill switch is on.']`, `message.exists` true |
| `delete_blocked_breaker` | `'Not deleted: the safety breaker is open.'` |
| `delete_blocked_dry_run` | `'Not deleted: dry run is on.'` |
| `delete_failed` | `"Not deleted: Discord didn't accept the delete."` |
| any other `actionTaken` | `'Recorded.'` |
| include content false | no `quote` |

Add to `catalog.test.ts` that `automod_match` is in `LOG_ACTION_CATALOG`, in group `Moderation`, with label
`Automod match` and `hasSourceChannel: true`.

Run the tests and expect FAIL.

- [ ] **Step 2: Implement**

1. Add `'automod_match'` to the list `LOG_EVENT_KINDS` is built from, next to `'member_warn'`.
2. Add the catalogue entry
   `{ kind: 'automod_match', group: 'Moderation', label: 'Automod match', hasSourceChannel: true }`.
3. Add `formatAutomodMatch` to `format.ts`, building the view in the table above.
4. In `automod/subscriber.ts`, every outcome of a match goes through the local `record(caseId,
   actionTaken, …)` closure inside the rule loop. It is synchronous today and is called in several
   branches, each followed by `continue`. Make it `async`, and change **every** call in the loop from
   `record(` to `await record(`. Then, at the end of its body, after `deps.recordCaseEvent({ … })`,
   add:

   ```ts
          if (deps.onMatchRecorded !== undefined) {
            try {
              await deps.onMatchRecorded({
                ruleId: rule.ruleId,
                ruleKind: rule.kind,
                memberId: authorId,
                channelId: event.channelId,
                messageId: event.messageId,
                snippet: hit.snippet,
                actionTaken,
                at: event.receivedAtMs,
              });
            } catch (err) {
              deps.logger.error(
                safeLogFields({ component: 'automod', guildId: event.guildId, ruleId: rule.ruleId, err }),
                'failed to post an automod match to the log; the match itself is recorded',
              );
            }
          }
   ```

   Each match calls `record` exactly once, so each match posts at most once. Check this by reading every
   branch. If a branch calls `record` twice for one match, for example a delete then an escalation,
   announce only the final call: pass a `final: boolean` argument.
5. In `apps/daemon/src/automod/wiring.ts`, pass the hook:

   ```ts
       onMatchRecorded: (info) =>
         logPoster.post({
           eventKind: 'automod_match',
           fingerprint: `automod:${info.messageId}:${info.ruleId}`,
           source: { channelId: info.channelId, parentChannelId: undefined, categoryId: undefined },
           view: (includeContent) => formatAutomodMatch(info, includeContent),
         }),
   ```

   `logPoster` is the `createLogPoster(loggingPorts)` instance that `guild.ts` already builds. Pass it
   into the automod wiring function as a new parameter. If the subscriber knows the event's parent and
   category, put them in `AutomodMatchInfo` and pass them through, so that excluded channels are
   respected. Add `parentChannelId` and `categoryId` to the interface in that case.
6. In `automod.integration.test.ts`, add a test with a route on `automod_match` and automod on Watch. A
   matching message produces one card in the route channel, with `AUTOMOD MATCH`, `Watch only` and a
   `bs.mod:delete:` button. A second delivery of the same message produces no second card (the claim
   fingerprint).

- [ ] **Step 3: Gates and commit**

```bash
npm run typecheck
npm run lint
npm run test
git add packages/core apps/daemon
git commit -m "P2 Task 4: automod matches post a card to log routes"
```

---

### Task 5: The gateway deletes one message

**Files:**
- Modify: `packages/core/src/effects/moderation-gateway.ts`, `moderation-gateway.test.ts`
- Modify: `packages/core/src/automod/subscriber.ts` (`ModerationGatewayPort` gains `deleteMessage`)
- Modify: every fake of `ModerationGatewayPort` that `npm run typecheck` names. Today these are in
  `automod/subscriber.test.ts`, `mod/warn.test.ts`, `mod/commands.test.ts` and
  `mod/confirmations.test.ts`. Each gets a `deleteMessage` that throws `new Error('not used in this test')`.

**Interfaces:**
- Produces, in `moderation-gateway.ts`:

  ```ts
  export interface DeleteMessageIntent {
    readonly channelId: SnowflakeId;
    readonly messageId: SnowflakeId;
    readonly dedupeKey: string;
    /** Shown in Discord's own audit log. */
    readonly reason: string;
  }
  export type DeleteRefusalReason = 'unauthorized' | 'guild-unknown' | 'killswitch' | 'breaker-open';
  export type DeleteMessageOutcome =
    | { readonly status: 'applied' }
    | { readonly status: 'dry-run' }
    | { readonly status: 'skipped'; readonly reason: 'already-applied' | 'message-gone' }
    | { readonly status: 'refused'; readonly reason: DeleteRefusalReason }
    | { readonly status: 'failed'; readonly code: string };
  ModerationActionGateway.deleteMessage(
    auth: Authorized<'moderation.act'>,
    intent: DeleteMessageIntent,
  ): Promise<DeleteMessageOutcome>;
  ```

- `ModerationGatewayPort` gains the same `deleteMessage` signature.

- [ ] **Step 1: Failing tests**

In `packages/core/src/effects/moderation-gateway.test.ts`, add a `describe('deleteMessage (ADR 0141
decision 7)')` block that uses the file's existing harness. Its intent is
`{ channelId: C, messageId: M, dedupeKey: 'mod:G:delete:intent-1', reason: 'Deleted from a log card' }`.

| # | Setup | Expect |
| --- | --- | --- |
| 1 | the authz store denies | `{ status: 'refused', reason: 'unauthorized' }`; no claim; no `deleteMessage` REST call |
| 2 | `state.read()` returns `undefined` | `refused` / `guild-unknown` |
| 3 | kill switch on | `refused` / `killswitch`; **no REST call** (Review Focus 5) |
| 4 | breaker open | `refused` / `breaker-open` |
| 5 | normal | `fetchMember`, `fetchRoles` and `fetchBotHighestRolePosition` are **never** called (no hierarchy layer) |
| 6 | the claim returns `{ claimed: false }` | `skipped` / `already-applied`; no REST call |
| 7 | dry run on | `dry-run`; the claim was taken; no REST call |
| 8 | normal | `discord.deleteMessage(GUILD, { channelId: C, messageId: M }, 'Deleted from a log card')` called once; `applied` |
| 9 | REST throws `new DiscordApiError(404, 10008, 'Unknown Message')` | `skipped` / `message-gone` (Review Focus 3) |
| 10 | REST throws `new DiscordApiError(403, 50013, 'Missing Permissions')` | `failed` with `code: 'DiscordApiError'`; an `error` log line with `component: 'moderation-effects'` |

Run `npx vitest run packages/core/src/effects/moderation-gateway.test.ts`. Expect FAIL.

- [ ] **Step 2: Implement**

In `moderation-gateway.ts`:

1. Add the types above, after `ModerationOutcome`. Import `DiscordApiError` from `'../discord/errors.js'`.
2. Move layers 1–3 of `applyAction` into a private method that both public methods call:

   ```ts
     /** Layers 1–3, shared by every action. Returns the safety state, or the refusal. */
     private preflight(
       auth: Authorized<'moderation.act'>,
       refuse: (reason: DeleteRefusalReason) => { status: 'refused'; reason: DeleteRefusalReason },
     ): ModerationSafetyState | { status: 'refused'; reason: DeleteRefusalReason } {
       const recheck = authorize(
         { store: this.deps.authz, guildId: this.deps.guildId, actor: auth.actor },
         capabilityOf(auth),
       );
       if (!recheck.ok || auth.guildId !== this.deps.guildId) return refuse('unauthorized');
       const state = this.deps.state.read();
       if (!state) return refuse('guild-unknown');
       if (state.killswitch) return refuse('killswitch');
       if (state.breakerOpen) return refuse('breaker-open');
       return state;
     }
   ```

   Rewrite `applyAction`'s first two sections to `const pre = this.preflight(auth, refuse); if ('status'
   in pre) return pre; const state = pre;`. Every existing `applyAction` test must still pass unchanged.
   If TypeScript cannot narrow the union this way, give the refusal a `refused: true` brand instead. Keep
   the behaviour identical either way.
3. Add the method, after `applyAction`. Keep the class docstring's layer list and add one line for it:
   `deleteMessage keeps 1, 2, 3, 9, 10, 11 — no hierarchy: Discord gates a delete by Manage Messages, not
   role position.`

   ```ts
     /**
      * Deletes one message for a moderator (ADR 0141 decision 7). A message
      * someone else already removed is `skipped`, not `failed`: the outcome the
      * moderator wanted exists, but this click did not cause it.
      */
     async deleteMessage(
       auth: Authorized<'moderation.act'>,
       intent: DeleteMessageIntent,
     ): Promise<DeleteMessageOutcome> {
       const { deps } = this;
       const fields = {
         component: 'moderation-effects',
         guildId: deps.guildId,
         channelId: intent.channelId,
         messageId: intent.messageId,
         action: 'delete',
       };
       const refuse = (reason: DeleteRefusalReason) => {
         deps.logger.warn(safeLogFields({ ...fields, outcome: 'refused', reason }), 'moderation action refused');
         return { status: 'refused' as const, reason };
       };

       const pre = this.preflight(auth, refuse);
       if ('status' in pre) return pre;

       if (!deps.claims.claim(intent.dedupeKey).claimed)
         return { status: 'skipped', reason: 'already-applied' };

       if (pre.dryRun) {
         deps.logger.info(
           safeLogFields({ ...fields, dryRun: true, outcome: 'dry-run' }),
           'dry run: no Discord call was made',
         );
         return { status: 'dry-run' };
       }

       try {
         await deps.discord.deleteMessage(
           deps.guildId,
           { channelId: intent.channelId, messageId: intent.messageId },
           intent.reason,
         );
       } catch (err) {
         if (err instanceof DiscordApiError && err.code === DiscordErrorCode.UnknownMessage) {
           deps.logger.info(safeLogFields({ ...fields, outcome: 'message-gone' }), 'the message was already gone');
           return { status: 'skipped', reason: 'message-gone' };
         }
         const code = err instanceof Error ? err.name : 'UnknownError';
         deps.logger.error(safeLogFields({ ...fields, outcome: 'failed', code, err }), 'the Discord call failed');
         return { status: 'failed', code };
       }
       return { status: 'applied' };
     }
   ```

   `DiscordErrorCode` comes from the same module as `DiscordApiError`. Use only `UnknownMessage`, not
   `isGone`: `isGone` also covers an unknown member or role, and neither can happen here.
4. In `automod/subscriber.ts`, add the method to `ModerationGatewayPort`:

   ```ts
     deleteMessage(
       auth: Authorized<'moderation.act'>,
       intent: DeleteMessageIntent,
     ): Promise<DeleteMessageOutcome>;
   ```

   `ModerationActionGateway` already satisfies it. Add a throwing stub to each test fake that
   `npm run typecheck` names.

- [ ] **Step 3: Gates and commit**

```bash
npx vitest run packages/core/src/effects/moderation-gateway.test.ts
npm run typecheck
npm run lint
npm run test
git add packages/core
git commit -m "P2 Task 5: ModerationActionGateway.deleteMessage"
```

---

### Task 6: `/mod` replies become cards, and a shared `ModInput`

**Files:**
- Create: `packages/core/src/ui/discord/inspect.ts`, `inspect.test.ts`
- Create: `packages/core/src/mod/cards.ts`, `packages/core/src/mod/cards.test.ts`
- Modify: `packages/core/src/mod/commands.ts`, `commands.test.ts`
- Modify: `packages/core/src/mod/confirmations.ts`, `confirmations.test.ts`
- Modify: `apps/daemon/src/mod.integration.test.ts`, or whichever daemon test drives `/mod` end to end.
  Find it with `rg -n "subcommandPath: \['(ban|warn|timeout)'" apps/daemon/src`.

**Interfaces:**
- Produces, in `ui/discord/inspect.ts`. These are pure helpers that tests and the card gallery use to
  read a card back:

  ```ts
  /** Every Text Display's content, in order, joined with newlines. */
  export const cardTexts: (components: readonly unknown[]) => string;
  /** Every button's custom_id, in order. */
  export const cardCustomIds: (components: readonly unknown[]) => string[];
  ```

- Produces, in `mod/cards.ts`:

  ```ts
  export type DirectModAction = 'timeout' | 'untimeout' | 'kick' | 'unban';
  export const caseRef: (caseId: string) => string;             // first 8 characters
  export const durationLabel: (minutes: number) => string;       // '10 minutes', '1 hour', '1 day', '90 minutes'
  export const modOutcomeCard: (input: {
    action: DirectModAction | 'ban';
    targetId: string;
    outcome: ModerationOutcome;
    reason: string;
    durationMinutes?: number;
    interactionId: string;
  }) => CardMessage;
  export const warnOutcomeCard: (input: {
    targetId: string;
    reason: string;
    caseId: string;
    violationCount: number;
    escalation: ModerationOutcome | undefined;
  }) => CardMessage;
  export const noteOutcomeCard: (input: { kind: 'note' | 'evidence'; targetId: string; content: string }) => CardMessage;
  export const confirmRow: (intentId: string, confirmLabel: string) => ActionRow;
  export const banConfirmCard: (input: { targetId: string; reason: string; intentId: string }) => CardMessage;
  export const purgeConfirmCard: (input: {
    channelId: string;
    total: number;
    fresh: number;
    old: number;
    newestAtMs: number | undefined;
    reason: string;
    intentId: string;
  }) => CardMessage;
  export const purgeQueuedCard: (channelId: string) => CardMessage;
  export const cancelledCard: () => CardMessage;
  ```

- Produces, in `mod/commands.ts`:

  ```ts
  /** One moderation request, whichever surface made it (ADR 0141 decision 6). */
  export interface ModInput {
    readonly actorId: Snowflake;
    readonly targetId: SnowflakeId;
    readonly reason: string;
    /** `timeout` only. */
    readonly durationMinutes?: number;
    /** The interaction that asked: the slash command or the modal submit. Dedupe keys bind to it. */
    readonly interactionId: Snowflake;
  }
  export const runDirectAction: (
    deps: ModCommandDeps,
    input: ModInput,
    ref: InteractionRef,
    action: DirectModAction,
  ) => Promise<void>;
  export const runWarn: (deps: ModCommandDeps, input: ModInput, ref: InteractionRef) => Promise<void>;
  ```

- Consumes: `card`, `text`, `separator`, `actionRow`, `button`, `escapeInline`, `escapeText`, `truncate`,
  `subtext`, `ts`, `resultCard`, `errorCard`, `toOutgoingMessage` (P1); `moderationRefusalCode`,
  `refFor`, `ERROR_COPY` (Task 1).

- [ ] **Step 1: `inspect.ts`, test first**

`packages/core/src/ui/discord/inspect.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { cardCustomIds, cardTexts } from './inspect.js';

const sample = [
  {
    type: 17,
    accent_color: 1,
    components: [
      { type: 10, content: 'one' },
      { type: 9, components: [{ type: 10, content: 'two' }], accessory: { type: 11 } },
      { type: 1, components: [{ type: 2, style: 2, custom_id: 'a:1', label: 'A' }, { type: 2, style: 5, url: 'https://x', label: 'L' }] },
      { type: 10, content: 'three' },
    ],
  },
];

describe('card inspection', () => {
  it('reads text displays in order, including inside sections', () => {
    expect(cardTexts(sample)).toBe('one\ntwo\nthree');
  });
  it('reads custom ids and skips link buttons', () => {
    expect(cardCustomIds(sample)).toEqual(['a:1']);
  });
});
```

`packages/core/src/ui/discord/inspect.ts`:

```ts
/** Reads a card back into text and custom ids, for tests and the card gallery. No behaviour. */
const walk = (value: unknown, visit: (node: Record<string, unknown>) => void): void => {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const node = value as Record<string, unknown>;
  visit(node);
  walk(node['components'], visit);
};

export const cardTexts = (components: readonly unknown[]): string => {
  const out: string[] = [];
  walk(components, (n) => {
    if (n['type'] === 10 && typeof n['content'] === 'string') out.push(n['content']);
  });
  return out.join('\n');
};

export const cardCustomIds = (components: readonly unknown[]): string[] => {
  const out: string[] = [];
  walk(components, (n) => {
    if (n['type'] === 2 && typeof n['custom_id'] === 'string') out.push(n['custom_id']);
  });
  return out;
};
```

Export both from `ui/discord/index.ts`.

- [ ] **Step 2: Failing card tests** (`packages/core/src/mod/cards.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { cardCustomIds, cardTexts } from '../ui/discord/inspect.js';
import {
  banConfirmCard,
  caseRef,
  durationLabel,
  modOutcomeCard,
  purgeConfirmCard,
  warnOutcomeCard,
} from './cards.js';

const U = '333333333333333333';
const C = '111111111111111111';
const I = '1234567890123456789';
const CASE = '0f3c9a2e-1111-4222-8333-444455556666';

const text = (c: { components: readonly unknown[] }) => cardTexts(c.components);

describe('durationLabel', () => {
  it.each([
    [10, '10 minutes'],
    [1, '1 minute'],
    [60, '1 hour'],
    [120, '2 hours'],
    [90, '90 minutes'],
    [1440, '1 day'],
    [10080, '7 days'],
  ])('%i → %s', (m, label) => expect(durationLabel(m)).toBe(label));
});

describe('modOutcomeCard', () => {
  const base = { targetId: U, reason: 'spam **links**', interactionId: I };

  it('says what happened, in words, with the reason escaped', () => {
    const t = text(modOutcomeCard({ ...base, action: 'timeout', durationMinutes: 60, outcome: { status: 'applied' } }));
    expect(t).toContain(`Timed out <@${U}> for 1 hour`);
    expect(t).toContain('Reason: spam \\*\\*links\\*\\*');
  });

  it.each([
    ['untimeout', `Ended <@${U}>'s timeout`],
    ['kick', `Kicked <@${U}>`],
    ['ban', `Banned <@${U}>`],
    ['unban', `Unbanned <@${U}>`],
  ] as const)('%s applied → %s', (action, words) => {
    expect(text(modOutcomeCard({ ...base, action, outcome: { status: 'applied' } }))).toContain(words);
  });

  it('dry run says nothing changed and what would have', () => {
    const t = text(modOutcomeCard({ ...base, action: 'kick', outcome: { status: 'dry-run' } }));
    expect(t).toContain('Dry run is on, so nothing changed');
    expect(t).toContain(`It would have kicked <@${U}>.`);
  });

  it('a refusal reads from the catalogue, never the raw code, and carries a Ref', () => {
    const t = text(modOutcomeCard({ ...base, action: 'kick', outcome: { status: 'refused', reason: 'role-above-bot' } }));
    expect(t).toContain('That member is above the bot');
    expect(t).not.toContain('role-above-bot');
    expect(t).toContain('-# Ref 23456789');
  });

  it('a Discord failure never shows the error name', () => {
    const t = text(modOutcomeCard({ ...base, action: 'ban', outcome: { status: 'failed', code: 'DiscordApiError' } }));
    expect(t).toContain("Discord didn't accept that");
    expect(t).not.toContain('DiscordApiError');
  });

  it('never pings the target', () => {
    expect(modOutcomeCard({ ...base, action: 'kick', outcome: { status: 'applied' } }).allowedMentions).toEqual({ parse: [] });
  });
});

describe('warnOutcomeCard', () => {
  it('names the case and the count', () => {
    const t = text(warnOutcomeCard({ targetId: U, reason: 'r', caseId: CASE, violationCount: 2, escalation: undefined }));
    expect(t).toContain(`Warned <@${U}>`);
    expect(t).toContain(`Case ${caseRef(CASE)} · warning 2`);
    expect(caseRef(CASE)).toBe('0f3c9a2e');
  });
  it('explains a refused escalation in words', () => {
    const t = text(
      warnOutcomeCard({ targetId: U, reason: 'r', caseId: CASE, violationCount: 3, escalation: { status: 'refused', reason: 'killswitch' } }),
    );
    expect(t).toContain("This reached an escalation step, but its consequence didn't run: Moderation is paused.");
  });
});

describe('confirm cards', () => {
  it('a ban preview states scope and offers a danger Confirm and a Cancel', () => {
    const c = banConfirmCard({ targetId: U, reason: 'raid', intentId: 'abc' });
    expect(text(c)).toContain(`Ban <@${U}>?`);
    expect(text(c)).toContain('Nothing has happened yet.');
    expect(cardCustomIds(c.components)).toEqual(['modconfirm:abc', 'modcancel:abc']);
    expect(JSON.stringify(c.components)).toContain('"style":4');
  });
  it('a purge preview states exact scope', () => {
    const t = text(purgeConfirmCard({ channelId: C, total: 37, fresh: 30, old: 7, newestAtMs: 1_760_000_000_000, reason: 'spam', intentId: 'abc' }));
    expect(t).toContain(`Delete 37 messages from <#${C}>?`);
    expect(t).toContain('Newest <t:1760000000:R>');
    expect(t).toContain('30 can go in bulk. 7 are older than 14 days and go one at a time.');
  });
});
```

Run `npx vitest run packages/core/src/mod/cards.test.ts packages/core/src/ui/discord/inspect.test.ts`.
Expect FAIL.

- [ ] **Step 3: Implement `packages/core/src/mod/cards.ts`**

```ts
import { ERROR_COPY } from '../copy/errors.js';
import { moderationRefusalCode, refFor } from '../copy/refusals.js';
import type { ModerationOutcome } from '../effects/moderation-gateway.js';
import { card, type CardMessage } from '../ui/discord/card.js';
import { errorCard, resultCard } from '../ui/discord/common-cards.js';
import { actionRow, button, separator, text, type ActionRow } from '../ui/discord/kit.js';
import { escapeInline, subtext, ts } from '../ui/discord/text.js';
import { ICON, type IconName } from '../ui/discord/tokens.js';
import { buildModCancelCustomId, buildModConfirmCustomId } from './confirmations.js';

export type DirectModAction = 'timeout' | 'untimeout' | 'kick' | 'unban';

export const caseRef = (caseId: string): string => caseId.slice(0, 8);

export const durationLabel = (minutes: number): string => {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (minutes >= 1440 && minutes % 1440 === 0) return plural(minutes / 1440, 'day');
  if (minutes >= 60 && minutes % 60 === 0) return plural(minutes / 60, 'hour');
  return plural(minutes, 'minute');
};

const ICON_FOR: Record<DirectModAction | 'ban', IconName> = {
  timeout: 'timeout',
  untimeout: 'timeout',
  kick: 'kick',
  ban: 'ban',
  unban: 'unban',
};

/** What was done, as a sentence fragment that starts lower-case. */
const didPhrase = (action: DirectModAction | 'ban', who: string, minutes: number | undefined): string => {
  switch (action) {
    case 'timeout':
      return `timed out ${who} for ${durationLabel(minutes ?? 0)}`;
    case 'untimeout':
      return `ended ${who}'s timeout`;
    case 'kick':
      return `kicked ${who}`;
    case 'ban':
      return `banned ${who}`;
    case 'unban':
      return `unbanned ${who}`;
  }
};

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const reasonLine = (reason: string): string[] =>
  reason.trim() === '' ? [] : [`Reason: ${escapeInline(reason)}`];

export const modOutcomeCard = (input: {
  action: DirectModAction | 'ban';
  targetId: string;
  outcome: ModerationOutcome;
  reason: string;
  durationMinutes?: number;
  interactionId: string;
}): CardMessage => {
  const did = didPhrase(input.action, `<@${input.targetId}>`, input.durationMinutes);
  const ref = refFor(input.interactionId);
  switch (input.outcome.status) {
    case 'applied':
      return resultCard({
        icon: ICON_FOR[input.action],
        title: capitalise(did),
        detail: reasonLine(input.reason).join('\n') || undefined,
        tone: 'ok',
      });
    case 'dry-run':
      return resultCard({
        icon: 'stop',
        title: 'Dry run is on, so nothing changed',
        detail: [`It would have ${did}.`, ...reasonLine(input.reason)].join('\n'),
        tone: 'hold',
      });
    case 'skipped':
      return resultCard({
        icon: 'done',
        title: 'Already done',
        detail: 'This exact action already ran, so it did not run twice.',
        tone: 'hold',
      });
    case 'refused':
      return errorCard(moderationRefusalCode(input.outcome.reason), { ref });
    case 'failed':
      return errorCard('mod.discord-error', { ref });
  }
};
```

`resultCard`'s `detail` is optional. If `exactOptionalPropertyTypes` rejects `detail: string | undefined`,
spread it conditionally instead.

```ts
const escalationLine = (o: ModerationOutcome): string => {
  switch (o.status) {
    case 'applied':
      return 'This reached an escalation step, and its consequence was applied.';
    case 'dry-run':
      return "This reached an escalation step. Dry run is on, so its consequence didn't run.";
    case 'skipped':
      return 'This reached an escalation step that had already run.';
    case 'refused':
      return `This reached an escalation step, but its consequence didn't run: ${ERROR_COPY[moderationRefusalCode(o.reason)].title}.`;
    case 'failed':
      return "This reached an escalation step, but Discord didn't accept its consequence.";
  }
};

export const warnOutcomeCard = (input: {
  targetId: string;
  reason: string;
  caseId: string;
  violationCount: number;
  escalation: ModerationOutcome | undefined;
}): CardMessage => {
  const lines = [
    ...reasonLine(input.reason),
    subtext(`Case ${caseRef(input.caseId)} · warning ${input.violationCount}`),
  ];
  if (input.escalation !== undefined) lines.push(escalationLine(input.escalation));
  const calm = input.escalation === undefined || input.escalation.status === 'applied';
  return resultCard({
    icon: 'warned',
    title: `Warned <@${input.targetId}>`,
    detail: lines.join('\n'),
    tone: calm ? 'ok' : 'hold',
  });
};

export const noteOutcomeCard = (input: {
  kind: 'note' | 'evidence';
  targetId: string;
  content: string;
}): CardMessage =>
  resultCard({
    icon: 'note',
    title:
      input.kind === 'note'
        ? `Added a note to <@${input.targetId}>'s case`
        : `Added an evidence link to <@${input.targetId}>'s case`,
    detail: escapeInline(input.content),
    tone: 'ok',
  });

export const confirmRow = (intentId: string, confirmLabel: string): ActionRow =>
  actionRow([
    button({ customId: buildModConfirmCustomId(intentId), label: confirmLabel, style: 'danger' }),
    button({ customId: buildModCancelCustomId(intentId), label: 'Cancel' }),
  ]);

const NOTHING_YET = subtext('Nothing has happened yet. The confirmation lasts 15 minutes.');

export const banConfirmCard = (input: { targetId: string; reason: string; intentId: string }): CardMessage =>
  card({
    tone: 'danger',
    children: [
      text([`**${ICON.ban} Ban <@${input.targetId}>?**`, ...reasonLine(input.reason), NOTHING_YET].join('\n')),
      separator(),
      confirmRow(input.intentId, 'Ban member'),
    ],
  });

export const purgeConfirmCard = (input: {
  channelId: string;
  total: number;
  fresh: number;
  old: number;
  newestAtMs: number | undefined;
  reason: string;
  intentId: string;
}): CardMessage => {
  const lines = [`**${ICON.bulkDelete} Delete ${input.total} messages from <#${input.channelId}>?**`];
  if (input.newestAtMs !== undefined) lines.push(`Newest ${ts(input.newestAtMs, 'R')}.`);
  lines.push(
    input.old === 0
      ? `All ${input.fresh} can go in bulk.`
      : `${input.fresh} can go in bulk. ${input.old} are older than 14 days and go one at a time.`,
  );
  lines.push(...reasonLine(input.reason), NOTHING_YET);
  return card({
    tone: 'danger',
    children: [text(lines.join('\n')), separator(), confirmRow(input.intentId, `Delete ${input.total} messages`)],
  });
};

export const purgeQueuedCard = (channelId: string): CardMessage =>
  resultCard({
    icon: 'bulkDelete',
    title: `Purging <#${channelId}>`,
    detail: 'It runs in the background. A large channel can take a few minutes.',
    tone: 'progress',
  });

export const cancelledCard = (): CardMessage =>
  resultCard({ icon: 'done', title: 'Cancelled', detail: 'Nothing was done.', tone: 'neutral' });
```

Some notes on this code:
- `ts(ms, 'R')` must produce `<t:1760000000:R>`. Check P1's `ts` rounds milliseconds down to seconds.
- The purge test expects `Newest <t:1760000000:R>` without the full stop, and the test uses `toContain`,
  so the full stop is fine.
- `cards.ts` imports from `confirmations.ts` and `confirmations.ts` will import from `cards.ts`. That
  cycle is safe here, because only functions are used and none is called during module load. If ESLint's
  `import/no-cycle` is enabled and complains, move `buildModConfirmCustomId`, `buildModCancelCustomId` and
  `parseModConfirmCustomId` into `mod/custom-ids.ts` (Task 3), re-export them from `confirmations.ts`,
  and record the move as a deviation.

Run the card tests. Expect PASS.

- [ ] **Step 4: `ModInput` and card replies in `commands.ts` — tests first**

In `commands.test.ts`:

1. Add `deferUpdate`, `showModal` and `editOriginal` stubs to the harness responder, and a
   `deleteMessage` stub to its gateway (Task 5).
2. Change every assertion on `respond[n].message.content` into an assertion on
   `cardTexts(respond[n].message.components ?? [])`. Add `expect(message.flags).toBe(32768)` once per
   subcommand. Wording changes like this:

   | Old assertion | New assertion |
   | --- | --- |
   | `timeout applied to <@T>.` | `Timed out <@T> for <n> minutes` (or hours, from `durationLabel`) |
   | `kick applied …` / `unban applied …` / `untimeout applied …` | `Kicked <@T>` / `Unbanned <@T>` / `Ended <@T>'s timeout` |
   | `… dry run is on …` | `Dry run is on, so nothing changed` |
   | `… refused for <@T>: role-above-bot.` | `That member is above the bot`, and **not** `role-above-bot` |
   | `… failed for <@T>: DiscordApiError.` | `Discord didn't accept that`, and **not** `DiscordApiError` |
   | `You do not have permission to …` | `You can't take moderation actions`, plus `-# Ref` |
   | `Warning recorded … Violation count: 2.` | `Warned <@T>` and `warning 2` |
   | `Note recorded for <@T>.` / `Evidence link recorded …` | `Added a note to <@T>'s case` / `Added an evidence link to <@T>'s case` |
   | `Something went wrong running that command …` | `Couldn't finish that` |

   Keep every assertion about case events, dedupe keys, gateway intents and logs exactly as it is. Only
   the reply wording changes.
3. Add one new test: `runDirectAction` called directly with a `ModInput` whose `interactionId` is
   `'modal-1'` uses dedupe key `mod:<guild>:timeout:modal-1` and the same case event as the slash path.
   This is the proof that both surfaces share one code path.
4. Add one more: `runWarn` with an unauthorized actor records `escalation_refused` / `unauthorized` and
   never calls `issueWarn` (assert no `warnRecordCaseEvent` call). Review Focus 1 rests on it.

Run `npx vitest run packages/core/src/mod/commands.test.ts`. Expect FAIL.

- [ ] **Step 5: Implement the refactor**

In `commands.ts`:

1. Add `ModInput` (as in Interfaces) and a converter:

   ```ts
   const modInputFromSlash = (event: SlashCommandEvent): ModInput => {
     const durationRaw = optionValue(event.options, 'duration_minutes');
     return {
       actorId: event.userId,
       targetId: parseSnowflakeId(optionValue(event.options, 'target')),
       reason: stringOption(event.options, 'reason'),
       ...(typeof durationRaw === 'number' ? { durationMinutes: durationRaw } : {}),
       interactionId: event.interactionId,
     };
   };
   ```

2. Rename `handleDirectAction(deps, event, ref, action)` to the exported
   `runDirectAction(deps, input, ref, action)`.
   - Replace `event.userId` with `input.actorId`.
   - Replace the parsed `targetId` and `reason` with `input.targetId` and `input.reason`.
   - Compute `timeoutMs` from `input.durationMinutes ?? 0`.
   - Build the dedupe key from `input.interactionId`.
   - Keep every case-event write and log line exactly as it is.
   - Keep the `DirectAction` type and `ESCALATION_ACTION_FOR_DIRECT`. Re-type them on `DirectModAction`
     from `cards.ts`, or alias one to the other.
3. Rename `handleWarn` to the exported `runWarn(deps, input, ref)` in the same way. `warnId` is
   `input.interactionId`, and `onWarned` gets `actorId: input.actorId`.
4. Send each reply as a card through one local helper:

   ```ts
   const reply = (deps: ModCommandDeps, ref: InteractionRef, message: CardMessage): Promise<void> =>
     deps.responder.respond(ref, toOutgoingMessage(message));
   ```

   - unauthorized: `errorCard('mod.not-allowed', { ref: refFor(input.interactionId) })`
   - direct outcome: `modOutcomeCard({ action, targetId, outcome, reason, durationMinutes, interactionId })`
   - warn: `warnOutcomeCard({ targetId, reason, caseId: result.caseId, violationCount: result.violationCount, escalation: result.escalation })`
   - note and evidence: `noteOutcomeCard({ kind, targetId, content })`, and
     `errorCard('mod.not-allowed', { ref })` when refused
   - the subscriber's catch-all: `errorCard('mod.unavailable', { ref: refFor(event.interactionId) })`
5. Delete `describeOutcome` and `describeEscalation`; `mod/cards.ts` replaces them.
6. In the subscriber, call `runWarn(deps, modInputFromSlash(event), ref)` and
   `runDirectAction(deps, modInputFromSlash(event), ref, subcommand)`. `note`/`evidence` keep reading
   their own options.

The slash command's dedupe key is unchanged, because `input.interactionId` is `event.interactionId`.

- [ ] **Step 6: Confirmation cards — tests first, then code**

In `confirmations.test.ts`:
- Swap content assertions for `cardTexts` assertions, in the same way as Step 4.
- The ban preview shows `Ban <@T>?` and the custom ids `modconfirm:<id>` and `modcancel:<id>`.
- The purge preview shows `Delete <n> messages from <#C>?`.
- An over-budget purge shows `Too many messages to purge at once`.
- Expired, not found and wrong moderator show `This confirmation expired`, `This was already handled` and
  `Only the moderator who started this can confirm it`.
- Cancel shows `Cancelled`.
- A confirmed ban reads like `modOutcomeCard`, and a confirmed purge shows `Purging <#C>`.
- Unauthorized shows `You can't take moderation actions`.
- The catch-all shows `Couldn't finish that`.

Then, in `confirmations.ts`:
- Every `respond(ref, { content … })` becomes `respond(ref, toOutgoingMessage(<card>))`.
- `RESOLUTION_MESSAGE` becomes a map to catalogue codes:

  ```ts
  const RESOLUTION_CODE = {
    expired: 'confirm.expired',
    'not-found': 'confirm.done',
    'wrong-moderator': 'confirm.not-yours',
  } as const satisfies Record<string, ErrorCode>;
  ```

  Each is answered with `errorCard(RESOLUTION_CODE[kind], { ref: refFor(event.interactionId) })`.
- `handlePurgePreview` keeps the newest `createdAtMs` from the messages it already fetched, as
  `newestAtMs`. The pages come newest first, so that is `messages[0]?.createdAtMs`. Confirm the order in
  `fetchRecentMessages`' docstring; if it is not newest first, use `Math.max`.
- Delete `buildConfirmCancelComponents` and `describeBanOutcome`, and fix their imports. If something
  outside `mod/` imports `buildConfirmCancelComponents` (check with
  `rg -n buildConfirmCancelComponents packages apps`), point it at `confirmRow` instead.

- [ ] **Step 7: Daemon test, gates and commit**

Update the daemon `/mod` integration test's reply assertions in the same way: `flags: 32768`, the words,
and no raw codes.

```bash
npx vitest run packages/core/src/mod
npm run typecheck
npm run lint
npm run test
git add packages/core apps/daemon
git commit -m "P2 Task 6: /mod replies and confirmations are cards; ModInput shared path"
```

---

### Task 7: Moderator buttons on log cards

**Files:**
- Create: `packages/core/src/mod/card-actions.ts`, `packages/core/src/mod/card-actions.test.ts`
- Modify: `packages/core/src/mod/cards.ts` (`deleteConfirmCard`, `warnModal`, `timeoutModal`,
  `deleteOutcomeCard`)
- Modify: `packages/core/src/mod/confirmations.ts` (the `delete` intent, `executeConfirmedDelete`,
  `ModConfirmationCasePorts` vocabulary)
- Modify: `packages/core/src/index.ts` (export `createModCardActionSubscriber`)
- Modify: `apps/daemon/src/runtime/guild.ts` (wire the subscriber; widen the confirmation case-port binding)
- Create: `apps/daemon/src/mod-card-actions.integration.test.ts`

**Interfaces:**
- Produces:

  ```ts
  // mod/card-actions.ts
  export interface ModCardActionDeps {
    readonly guildId: GuildId;
    readonly commands: ModCommandDeps;        // the same object /mod uses
    readonly confirmations: ModConfirmationDeps;
    readonly responder: SlashResponder;
    readonly now: () => number;
    readonly logger: Logger;
  }
  export const createModCardActionSubscriber: (deps: ModCardActionDeps) => Subscriber;

  // mod/cards.ts
  export const TIMEOUT_CHOICES: readonly { minutes: number; label: string }[]; // 10 min, 1 hour (default), 1 day
  export const warnModal: (userId: string) => Modal;
  export const timeoutModal: (userId: string) => Modal;
  export const deleteConfirmCard: (input: {
    guildId: string; channelId: string; messageId: string; authorId: string; intentId: string;
  }) => CardMessage;
  export const deleteOutcomeCard: (outcome: DeleteMessageOutcome, interactionId: string) => CardMessage;

  // mod/confirmations.ts
  modPendingActionPayload gains { kind: 'delete'; channelId; messageId; authorId }
  export const deleteConfirmDedupeKey: (guildId: string, intentId: string) => string; // mod:<g>:delete:<intent>
  export const writeDeleteIntent: (
    deps: ModConfirmationDeps,
    input: { actorId: Snowflake; channelId: SnowflakeId; messageId: SnowflakeId; authorId: SnowflakeId },
  ) => string; // the new intentId
  ```

- Consumes: `parseModCustomId` (Task 3), `deleteMessage` (Task 5), `runWarn`, `runDirectAction`, the
  cards and `cardTexts` (Task 6), `SlashResponder.showModal`/`defer`, `ModalSubmitEvent` (P1).

**Flow, for the reviewer:**

| Click | First response | Then |
| --- | --- | --- |
| Warn | `showModal(warnModal(userId))`, with no defer and no check (a modal must come first) | submit → defer ephemeral → `runWarn` (authorises, records, replies) |
| Timeout | `showModal(timeoutModal(userId))` | submit → defer ephemeral → `runDirectAction(…, 'timeout')` |
| Delete | defer ephemeral → authorise → `writeDeleteIntent` → `deleteConfirmCard` | the existing `createModConfirmationSubscriber` handles Confirm/Cancel |
| History page | handled in Task 8 | |

- [ ] **Step 1: Modals and cards — tests first**

Append to `packages/core/src/mod/cards.test.ts`:

```ts
describe('moderator modals', () => {
  it('Warn asks for a required reason, up to 500 characters', () => {
    const m = warnModal(U);
    expect(m.custom_id).toBe(`bs.mod:warn:${U}`);
    expect(m.title).toBe('Warn member');
    const json = JSON.stringify(m.components);
    expect(json).toContain('"custom_id":"reason"');
    expect(json).toContain('"required":true');
    expect(json).toContain('"max_length":500');
  });
  it('Timeout offers 10 minutes, 1 hour and 1 day, with 1 hour chosen', () => {
    const m = timeoutModal(U);
    expect(m.custom_id).toBe(`bs.mod:timeout:${U}`);
    const radio = JSON.stringify(m.components);
    expect(radio).toContain('"value":"10"');
    expect(radio).toContain('"value":"60","label":"1 hour","default":true');
    expect(radio).toContain('"value":"1440"');
  });
});

describe('delete cards', () => {
  it('the confirm card names the author and channel and links the message', () => {
    const c = deleteConfirmCard({ guildId: '9', channelId: C, messageId: '2', authorId: U, intentId: 'abc' });
    expect(cardTexts(c.components)).toContain(`Delete this message by <@${U}> in <#${C}>?`);
    expect(cardTexts(c.components)).toContain(`https://discord.com/channels/9/${C}/2`);
    expect(cardCustomIds(c.components)).toEqual(['modconfirm:abc', 'modcancel:abc']);
  });
  it.each([
    [{ status: 'applied' } as const, 'Deleted the message'],
    [{ status: 'skipped', reason: 'message-gone' } as const, 'That message was already gone'],
    [{ status: 'skipped', reason: 'already-applied' } as const, 'Already done'],
    [{ status: 'dry-run' } as const, 'Dry run is on, so nothing changed'],
    [{ status: 'refused', reason: 'killswitch' } as const, 'Moderation is paused'],
    [{ status: 'failed', code: 'DiscordApiError' } as const, "Discord didn't accept that"],
  ])('%o → %s', (outcome, words) => {
    expect(cardTexts(deleteOutcomeCard(outcome, I).components)).toContain(words);
  });
});
```

Implement them in `cards.ts`:

```ts
export const TIMEOUT_CHOICES = [
  { minutes: 10, label: '10 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 1440, label: '1 day' },
] as const;
const DEFAULT_TIMEOUT_MINUTES = 60;

const reasonField = () =>
  label({
    label: 'Reason',
    description: 'Shown in case history and in Discord’s audit log.',
    component: textInput({ customId: 'reason', style: 'paragraph', required: true, minLength: 1, maxLength: 500 }),
  });

export const warnModal = (userId: string): Modal =>
  modal({ customId: buildModCustomId({ action: 'warn', userId }), title: 'Warn member', components: [reasonField()] });

export const timeoutModal = (userId: string): Modal =>
  modal({
    customId: buildModCustomId({ action: 'timeout', userId }),
    title: 'Time out member',
    components: [
      label({
        label: 'How long',
        component: radioGroup({
          customId: 'minutes',
          required: true,
          options: TIMEOUT_CHOICES.map((c) => ({
            value: String(c.minutes),
            label: c.label,
            ...(c.minutes === DEFAULT_TIMEOUT_MINUTES ? { default: true } : {}),
          })),
        }),
      }),
      reasonField(),
    ],
  });

export const deleteConfirmCard = (input: {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  intentId: string;
}): CardMessage =>
  card({
    tone: 'danger',
    children: [
      text(
        [
          `**${ICON.deleted} Delete this message by <@${input.authorId}> in <#${input.channelId}>?**`,
          `[Open the message](${jumpUrl(input.guildId, input.channelId, input.messageId)})`,
          NOTHING_YET,
        ].join('\n'),
      ),
      separator(),
      confirmRow(input.intentId, 'Delete message'),
    ],
  });

export const deleteOutcomeCard = (outcome: DeleteMessageOutcome, interactionId: string): CardMessage => {
  const ref = refFor(interactionId);
  switch (outcome.status) {
    case 'applied':
      return resultCard({ icon: 'deleted', title: 'Deleted the message', tone: 'ok' });
    case 'dry-run':
      return resultCard({ icon: 'stop', title: 'Dry run is on, so nothing changed', detail: 'It would have deleted the message.', tone: 'hold' });
    case 'skipped':
      return outcome.reason === 'message-gone'
        ? resultCard({ icon: 'done', title: 'That message was already gone', detail: 'Someone removed it before you confirmed. Nothing else changed.', tone: 'hold' })
        : resultCard({ icon: 'done', title: 'Already done', detail: 'This exact action already ran, so it did not run twice.', tone: 'hold' });
    case 'refused':
      return errorCard(moderationRefusalCode(outcome.reason), { ref });
    case 'failed':
      return errorCard('mod.discord-error', { ref });
  }
};
```

Add the imports this needs to `cards.ts`: `label`, `modal`, `radioGroup`, `textInput` and `type Modal`
from the kit, `jumpUrl` from `text.ts`, `buildModCustomId` from `./custom-ids.js`, and
`type DeleteMessageOutcome` from the gateway.

`moderationRefusalCode` takes `ModerationRefusalReason`, and `DeleteRefusalReason` is a subset of it, so
this type-checks. If the P1 `label` type does not accept a `RadioGroup`, check the P1 kit: Task 1 typed
`Label.component` as `TextInput | RadioGroup`.

- [ ] **Step 2: The delete intent in `confirmations.ts` — tests first**

In `confirmations.test.ts`, add:

1. `writeDeleteIntent` puts a row whose payload parses as `{ kind: 'delete', channelId, messageId,
   authorId }`, `createdBy` is the actor, and `expiresAt` is `now + PENDING_ACTION_TTL_MS`.
2. Confirming a delete intent calls `moderationGateway.deleteMessage` once, with
   `{ channelId, messageId, dedupeKey: 'mod:<guild>:delete:<intentId>', reason: 'Deleted from a log card' }`.
   - On `applied`, it records one case event on the **author's** case: `ruleId 'manual'`,
     `matchedCategory 'delete'`, `matchedSnippet 'Deleted from a log card'`, `actionTaken 'deleted'`,
     `actorId` the moderator.
   - It replies `Deleted the message`.
3. Each outcome records the matching `actionTaken`, and two outcomes record nothing:

   | Gateway outcome | `actionTaken` |
   | --- | --- |
   | `applied` | `deleted` |
   | `dry-run` | `delete_blocked_dry_run` |
   | `refused` / `killswitch` | `delete_blocked_killswitch` |
   | `refused` / `breaker-open` | `delete_blocked_breaker` |
   | `refused` / `guild-unknown` | `delete_blocked_guild_unknown` |
   | `refused` / `unauthorized` | `escalation_refused`, `refusalReason: 'unauthorized'` |
   | `failed` | `delete_failed` |
   | `skipped` / `message-gone` | **no case event** (this moderator deleted nothing) |
   | `skipped` / `already-applied` | **no case event** (the first confirm already recorded one) |

4. A second Confirm on the same intent answers `This was already handled`, and `deleteMessage` was
   called once in total (Review Focus 2).
5. A Confirm from a different moderator answers `Only the moderator who started this can confirm it`,
   calls nothing, and leaves the intent in place.

Then implement:

1. Add to the union:

   ```ts
   const deletePendingPayload = z.object({
     kind: z.literal('delete'),
     channelId: snowflakeIdSchema,
     messageId: snowflakeIdSchema,
     authorId: snowflakeIdSchema,
   });
   export const modPendingActionPayload = z.discriminatedUnion('kind', [
     banPendingPayload,
     purgePendingPayload,
     deletePendingPayload,
   ]);
   ```

2. Widen `ModConfirmationCasePorts.recordCaseEvent`'s `actionTaken` with `'deleted' | 'delete_failed' |
   'delete_blocked_killswitch' | 'delete_blocked_breaker' | 'delete_blocked_dry_run' |
   'delete_blocked_guild_unknown'`. Check that the storage repo's `recordCaseEvent` accepts each of them
   (`rg -n "delete_blocked_guild_unknown" packages/storage/src`). If one is missing from the repo's
   type, stop: that is a schema change, and this plan assumes none. Write it in the deviations file.
3. Add `deleteConfirmDedupeKey`, `writeDeleteIntent`, and an `executeConfirmedDelete`. The latter mirrors
   `executeConfirmedBan`: call the gateway, record by the table above, log with
   `component: 'mod-confirmations'` and `action: 'delete'`, and reply
   `toOutgoingMessage(deleteOutcomeCard(outcome, event.interactionId))`. Pass `event.interactionId` down;
   `executeConfirmedBan` gains the same parameter, so its card's Ref is right.
4. In the subscriber's confirm branch:
   - A `delete` payload goes to `executeConfirmedDelete`.
   - In the unauthorized branch, a `delete` records `escalation_refused` on the **author's** case, with
     category `delete`. Extend `recordUnauthorizedRefusal`'s `category` to `'ban' | 'purge' | 'delete'`.

- [ ] **Step 3: The subscriber — tests first** (`packages/core/src/mod/card-actions.test.ts`)

Build a harness the way `commands.test.ts` does: fake gateway, case ports, pending ports, and a
responder that records `defer`, `respond`, `showModal` and `deferUpdate`. Reuse
`buildModCustomId`, `cardTexts` and `cardCustomIds`. The tests:

| # | Event | Expect |
| --- | --- | --- |
| 1 | interaction `bs.mod:warn:U` | `showModal` once with `custom_id` `bs.mod:warn:U`; **no** `defer`; no authz lookup; no case write |
| 2 | interaction `bs.mod:timeout:U` | `showModal` with the timeout modal; no `defer` |
| 3 | modal submit `bs.mod:warn:U`, `fields { reason: 'spam' }`, moderator authorised | `defer` ephemeral; `issueWarn` path ran (a `warned` event via `warnRepo`); the reply contains `Warned <@U>` |
| 4 | the same, actor **not** authorised | case event `escalation_refused` / `unauthorized` / category `warn` on U's case; **no** `warned` event; reply `You can't take moderation actions` (Review Focus 1) |
| 5 | modal submit `bs.mod:timeout:U`, `{ minutes: '1440', reason: 'raid' }` | gateway `applyAction` with `action 'timeout'`, `timeoutMs 86_400_000`, dedupe `mod:<g>:timeout:<submit interaction id>`; reply `Timed out <@U> for 1 day` |
| 6 | timeout submit with `minutes: '999'` (not a listed choice) | treated as 60; the intent has `timeoutMs 3_600_000` |
| 7 | warn submit with `reason: '   '` | no gateway call, no case event; reply `errorCard('mod.reason-required')` (add the entry below) |
| 8 | interaction `bs.mod:delete:C:M:U`, authorised | `defer` ephemeral; one pending intent of kind `delete` created by the clicker; the reply has `Delete this message by <@U>` and `modconfirm:<intent>` |
| 9 | the same, **not** authorised | no intent; `escalation_refused` / `unauthorized` / `delete` on U's case; reply `You can't take moderation actions` |
| 10 | interaction `bs.task:start:x:1`, or `modconfirm:abc` | ignored: no defer, no modal |
| 11 | modal submit `bs.task:update:x` | ignored |
| 12 | the gateway throws during a timeout submit | reply `Couldn't finish that`, with a Ref |

Add the catalogue entry used in row 7 to `ERROR_COPY` (Task 1's list):

```ts
  'mod.reason-required': {
    title: 'Add a reason',
    detail: 'Every warning and timeout needs a reason. It goes in case history and Discord’s audit log.',
    next: 'Open the form again and write one.',
    retryable: true,
    tone: 'hold',
    audience: 'moderator',
  },
```

Run `npx vitest run packages/core/src/mod/card-actions.test.ts`. Expect FAIL.

- [ ] **Step 4: Implement `packages/core/src/mod/card-actions.ts`**

```ts
import { refFor } from '../copy/refusals.js';
import type { InteractionRef } from '../discord/port.js';
import type { GuildId } from '../ids.js';
import { parseSnowflakeId } from '../ids.js';
import { safeLogFields, type Logger } from '../obs/logger.js';
import type { SlashResponder } from '../ops/commands/slash-responder.js';
import type { Subscriber } from '../pipeline/pipeline.js';
import { toOutgoingMessage } from '../ui/discord/card.js';
import { errorCard } from '../ui/discord/common-cards.js';
import { deleteConfirmCard, TIMEOUT_CHOICES, timeoutModal, warnModal } from './cards.js';
import { runDirectAction, runWarn, type ModCommandDeps } from './commands.js';
import { authorizeForCard, recordCardRefusal, writeDeleteIntent, type ModConfirmationDeps } from './confirmations.js';
import { parseModCustomId } from './custom-ids.js';

/**
 * Delete, Warn and Timeout on log cards (ADR 0141 decisions 4–7). A shortcut
 * into the same deterministic code `/mod` runs; nothing here decides anything
 * a slash command would not. No model is involved, and there is no MCP
 * equivalent (spec §3).
 */
export interface ModCardActionDeps {
  readonly guildId: GuildId;
  readonly commands: ModCommandDeps;
  readonly confirmations: ModConfirmationDeps;
  readonly responder: SlashResponder;
  readonly now: () => number;
  readonly logger: Logger;
}

const DEFAULT_MINUTES = 60;
const ALLOWED_MINUTES: ReadonlySet<number> = new Set(TIMEOUT_CHOICES.map((c) => c.minutes));

export const createModCardActionSubscriber = (deps: ModCardActionDeps): Subscriber => ({
  name: 'mod-card-actions',
  async handle(event) {
    if (event.kind === 'interaction') {
      const parsed = parseModCustomId(event.customId);
      if (parsed === undefined || parsed.action === 'history') return; // history: Task 8
      const ref: InteractionRef = { interactionId: event.interactionId, token: event.token };

      if (parsed.action === 'warn' || parsed.action === 'timeout') {
        try {
          // A modal must be the first response. Authority is checked on submit (ADR 0141 decision 6).
          await deps.responder.showModal(
            ref,
            parsed.action === 'warn' ? warnModal(parsed.userId) : timeoutModal(parsed.userId),
          );
        } catch {
          // Expired or already answered; the moderator can press the button again.
        }
        return;
      }

      // Delete: defer, authorise, write the intent, show the confirm card.
      await deps.responder.defer(ref, { ephemeral: true });
      try {
        const auth = await authorizeForCard(deps.confirmations, event.userId);
        if (!auth.ok) {
          recordCardRefusal(deps.confirmations, {
            memberId: parseSnowflakeId(parsed.authorId),
            actorId: event.userId,
            now: deps.now(),
          });
          await deps.responder.respond(
            ref,
            toOutgoingMessage(errorCard('mod.not-allowed', { ref: refFor(event.interactionId) })),
          );
          return;
        }
        const intentId = writeDeleteIntent(deps.confirmations, {
          actorId: event.userId,
          channelId: parseSnowflakeId(parsed.channelId),
          messageId: parseSnowflakeId(parsed.messageId),
          authorId: parseSnowflakeId(parsed.authorId),
        });
        await deps.responder.respond(
          ref,
          toOutgoingMessage(
            deleteConfirmCard({
              guildId: deps.guildId,
              channelId: parsed.channelId,
              messageId: parsed.messageId,
              authorId: parsed.authorId,
              intentId,
            }),
          ),
        );
      } catch (err) {
        deps.logger.error(
          safeLogFields({ component: 'mod-card-actions', guildId: deps.guildId, action: 'delete', err }),
          'a log-card delete click failed',
        );
        await deps.responder.respond(
          ref,
          toOutgoingMessage(errorCard('mod.unavailable', { ref: refFor(event.interactionId) })),
        );
      }
      return;
    }

    if (event.kind === 'modalSubmit') {
      const parsed = parseModCustomId(event.customId);
      if (parsed === undefined || (parsed.action !== 'warn' && parsed.action !== 'timeout')) return;
      const ref: InteractionRef = { interactionId: event.interactionId, token: event.token };
      try {
        await deps.responder.defer(ref, { ephemeral: true });
      } catch {
        return;
      }
      const reason = (event.fields['reason'] ?? '').trim();
      try {
        if (reason === '') {
          await deps.responder.respond(ref, toOutgoingMessage(errorCard('mod.reason-required')));
          return;
        }
        const base = {
          actorId: event.userId,
          targetId: parseSnowflakeId(parsed.userId),
          reason,
          interactionId: event.interactionId,
        };
        if (parsed.action === 'warn') {
          await runWarn(deps.commands, base, ref);
          return;
        }
        const chosen = Number(event.fields['minutes']);
        const durationMinutes = ALLOWED_MINUTES.has(chosen) ? chosen : DEFAULT_MINUTES;
        await runDirectAction(deps.commands, { ...base, durationMinutes }, ref, 'timeout');
      } catch (err) {
        deps.logger.error(
          safeLogFields({ component: 'mod-card-actions', guildId: deps.guildId, action: parsed.action, err }),
          'a log-card moderation form failed',
        );
        await deps.responder.respond(
          ref,
          toOutgoingMessage(errorCard('mod.unavailable', { ref: refFor(event.interactionId) })),
        );
      }
    }
  },
});
```

`authorizeForCard` and `recordCardRefusal` are small exports from `confirmations.ts`:
- `authorizeForCard` is the existing private `authorizeInvoker`, exported under that name.
- `recordCardRefusal` is
  `recordUnauthorizedRefusal(deps, { memberId, category: 'delete', reason: 'Deleted from a log card', actorId, now })`.

Export both rather than duplicating them. `runWarn` and `runDirectAction` already authorise, record
refusals and reply, so nothing is duplicated for Warn or Timeout.

`ModCommandDeps.responder` and `ModCardActionDeps.responder` are the same object in the daemon, so
`runWarn`'s reply lands on the modal-submit interaction that was just deferred.

- [ ] **Step 5: Wire it in the daemon**

In `apps/daemon/src/runtime/guild.ts`:
1. Widen `modConfirmationDeps.cases.recordCaseEvent` so the new `actionTaken` values pass through. The
   binding already forwards `input.actionTaken`, so this should be a type-only change.
2. Register the subscriber next to the other two:

   ```ts
       createModCommandSubscriber(modCommandDeps),
       createModConfirmationSubscriber(modConfirmationDeps),
       createModCardActionSubscriber({
         guildId,
         commands: modCommandDeps,
         confirmations: modConfirmationDeps,
         responder: modCommandDeps.responder,
         now,
         logger,
       }),
   ```

3. The modal-submit event must reach this subscriber. P1 Task 3 made the gateway emit `modalSubmit`;
   check that the pipeline passes it to every subscriber, as it does for `interaction`.

- [ ] **Step 6: Daemon integration test** (`apps/daemon/src/mod-card-actions.integration.test.ts`)

Use the same daemon test harness the logging integration tests use: a real in-memory database,
`FakeDiscord`, and `guild.ts` wiring. Grant the moderator `moderation.act` the way `mod.integration.test.ts`
does. Then:

1. **Delete, end to end.**
   - Post a message as member U in channel C, with a route on `message_create` and its log card posted.
   - Click the card's `bs.mod:delete:` button as the moderator. A private confirm card arrives.
   - Click its `modconfirm:` button. `FakeDiscord` shows the message deleted once.
   - `mod_case_events` has one `deleted` row on U's case with `actor_id` the moderator.
   - Click Confirm again. The reply is `This was already handled`, and the delete count is still one.
2. **Kill switch.** Set `guilds.killswitch = 1` before Confirm. The message is not deleted, the row is
   `delete_blocked_killswitch`, and the reply contains `Moderation is paused` (Review Focus 5).
3. **Already gone.** Delete the message through `FakeDiscord` between the click and Confirm. The reply is
   `That message was already gone`, and no `deleted` row exists (Review Focus 3).
4. **Warn from a non-moderator.** A member without `moderation.act` submits the Warn modal. There is no
   `warned` row, one `escalation_refused` row, and the reply is `You can't take moderation actions`
   (Review Focus 1).
5. **Timeout through the modal.** Submit `minutes: '10'`. `FakeDiscord` shows a 600,000 ms timeout on U,
   and the reply is `Timed out <@U> for 10 minutes`.

- [ ] **Step 7: Gates and commit**

```bash
npx vitest run packages/core/src/mod apps/daemon/src/mod-card-actions.integration.test.ts
npm run typecheck
npm run lint
npm run test
git add packages/core apps/daemon
git commit -m "P2 Task 7: Delete, Warn and Timeout buttons on log cards"
```

---

### Task 8: Case history as a paged card

**Files:**
- Modify: `packages/core/src/mod/history.ts`, `history.test.ts`
- Modify: `packages/core/src/mod/cards.ts` (`historyCard`)
- Modify: `packages/core/src/mod/card-actions.ts` (the `history` page click)
- Modify: `packages/core/src/mod/commands.ts` (pass the interaction id into `handleHistory` if needed)

**Interfaces:**
- Produces:

  ```ts
  // mod/history.ts
  export const HISTORY_PAGE_SIZE = 8;
  export interface HistoryPage {
    readonly targetId: string;
    readonly cases: readonly HistoryCase[];
    /** Newest first, across every case. */
    readonly events: readonly HistoryCaseEvent[];
    readonly page: number;
    readonly pageCount: number;
    readonly countsByKind: Readonly<Record<string, number>>;
  }
  export const buildHistoryPage: (
    targetId: string,
    cases: readonly HistoryCase[],
    eventsByCase: ReadonlyMap<string, readonly HistoryCaseEvent[]>,
    page: number,
  ) => HistoryPage;
  export const showHistoryPage: (
    deps: HistoryDeps,
    input: { actorId: Snowflake; targetId: SnowflakeId; page: number; interactionId: string },
    ref: InteractionRef,
    mode: 'reply' | 'edit',
  ) => Promise<void>;

  // mod/cards.ts
  export const historyCard: (page: HistoryPage) => CardMessage;
  export const describeCaseEvent: (event: HistoryCaseEvent, caseMemberId: string) => string;
  ```

- Removes: `buildTruncatedContent`, `renderContent`, `caseWithOldestRemainingEvent`, `MAX_CONTENT_LENGTH`.
  Paging replaces truncation.

**What the card shows** (ADR 0141 decision 9):

```
┃ -# 📂 CASE HISTORY
┃ **<@U>** · 2 cases · 14 events
┃ 3 warnings · 1 timeout · 2 automod deletes · 1 note
┃ ───────────────
┃ <t:…:d> **Warned** by <@mod> — "spam links"
┃ <t:…:d> **Timed out** by <@mod> — "raid"
┃ <t:…:d> **Timeout refused**: That member is above the bot — by <@mod>
┃ <t:…:d> **Ran a purge** (as a moderator) in this case
┃ … (up to 8)
┃ ───────────────
┃ [ ← Newer ] [ Older → ]          (buttons absent when there is one page)
┃ -# Page 1 of 2 · Case 0f3c9a2e (open, 3 violations, tier 1) · Case 8a1b… (closed)
```

- [ ] **Step 1: Failing tests**

Rewrite `history.test.ts`'s rendering assertions around `buildHistoryPage` and `historyCard`, keeping
every fact the old tests checked:

1. **Order and paging.** 20 events across two cases make `pageCount` 3. Page 0 holds the 8 newest, newest
   first, and page 2 holds the oldest 4. `page` is clamped: `-1` → 0 and `99` → the last page.
2. **Counts by kind.** The header line counts by readable kind, with plural forms, in a fixed order:
   warnings, timeouts, kicks, bans, unbans, automod deletes, Discord AutoMod actions, notes, evidence links,
   refused actions.
   Kinds with a zero count are left out.
3. **Self-authored events.** The `isSelfAuthored` rule is kept. An event by the case's own member as
   moderator renders with the prefix `(as a moderator)`. The old test "purge on a moderator's own case is
   not shown as being purged" keeps its intent.
4. **Readable events, never raw codes.** `describeCaseEvent` maps `actionTaken` to words:

   | `actionTaken` (+ category / escalation) | Words |
   | --- | --- |
   | `warned` | `Warned` |
   | `manual_applied` + `timeout`/`kick`/`ban`/`unban` | `Timed out` / `Kicked` / `Banned` / `Unbanned` |
   | `manual_applied` + category `untimeout` | `Timeout ended` |
   | `deleted` / `deleted_and_escalated` | `Message deleted` (+ ` by automod` when `ruleId !== 'manual'`) |
   | `would_delete` | `Automod match (watch only)` |
   | `delete_blocked_*` | `Delete blocked: <reason in words>` |
   | `delete_failed` | `Delete didn't go through` |
   | `escalation_refused` | `<Action> refused: <catalogue title>`, where `unauthorized` reads `Not allowed` |
   | `escalation_failed` / `escalation_dry_run` / `escalation_skipped` | `<Action> didn't go through` / `<Action> (dry run)` / `<Action> (already done)` |
   | `note` / `evidence_added` | `Note` / `Evidence` |
   | `purged` / `purge_refused` / `purge_failed` | `Ran a purge` / `Purge refused` / `Purge didn't go through` |
   | `native_blocked` / `native_alerted` / `native_timeout` / `native_blocked_interaction` | `Discord AutoMod blocked a message` / `Discord AutoMod sent an alert` / `Discord AutoMod timed them out` / `Discord AutoMod blocked an interaction` |
   | anything else | the `actionTaken` value with `_` replaced by spaces, capitalised |

   The full vocabulary is `ModCaseActionTaken` in `packages/storage/src/repos/mod-cases.ts`. There are 23
   values on 2026-10-10. Cover every one in a test table. `core` cannot import that type, so copy the list
   into the test as a literal array. The snippet is escaped through `escapeInline` and capped at 120 characters.
5. **Budget.** A page of 8 events, each with a 500-character snippet, stays under 4,000 characters and 40
   components.
6. **Buttons.** Page 0 of 3 has only `Older →` (`bs.mod:history:U:1`). Page 1 has `← Newer`
   (`bs.mod:history:U:0`) and `Older →` (`bs.mod:history:U:2`). The last page has only `← Newer`. A single
   page has no action row.
7. **No history.** It replies with `resultCard({ icon: 'history', title: 'No case history for <@U>',
   tone: 'neutral' })`.
8. **Unauthorized.** It still records `escalation_refused` / `unauthorized` / `history`. The reply becomes
   `You can't take moderation actions`.
9. **A page click.**
   - `bs.mod:history:U:1` from an authorised moderator calls `deferUpdate`, then
     `editOriginal(ref, <page 1 card>)`.
   - It writes no case event.
   - From a moderator who has lost `moderation.act`, it calls `deferUpdate`, then `respond` with
     `You can't take moderation actions`, and records the refusal. The original card is not edited.

Run `npx vitest run packages/core/src/mod/history.test.ts`. Expect FAIL.

- [ ] **Step 2: Implement**

`history.ts`:
1. Add `buildHistoryPage`:
   - Flatten every case's events, and sort them by `at` descending, with `eventId` as the tie-break.
   - Compute `pageCount = max(1, ceil(n / 8))`, clamp `page`, and slice.
   - Count kinds with a local `kindOf(event)` helper that returns the counting bucket used in Step 1.2.
2. Add `showHistoryPage`. It runs `authorizeInvoker`.
   - Refused: `recordUnauthorizedRefusal`, then reply with the error card. Use `respond` in both modes:
     after `deferUpdate`, `respond` is a private follow-up.
   - Allowed: list the cases. With none, send the "No case history" card. Otherwise build the page and
     send `historyCard(page)`, through `respond` when `mode` is `'reply'` and through
     `deps.responder.editOriginal(ref, …)` when it is `'edit'`.
   - Keep the existing info log, and add `page`.
3. `handleHistory(deps, event, ref)` becomes
   `showHistoryPage(deps, { actorId: event.userId, targetId, page: 0, interactionId: event.interactionId }, ref, 'reply')`.
4. Delete the truncation helpers and their docstrings. Keep the module docstring's explanation of why a
   refused read is recorded, and of `isSelfAuthored`.

`cards.ts`: add `describeCaseEvent` and `historyCard`, following the sketch above.
- The eyebrow is `subtext(\`${ICON.history} CASE HISTORY\`)`.
- The case list goes in the footer as `Case <caseRef> (<status>, <n> violations, tier <t>)`, joined with
  ` · `. If it is too long, it ends `· and N more cases`.
- The buttons use `button({ customId: buildModCustomId({ action: 'history', userId, page }), label: '← Newer' })`.
  Both are secondary style.
- Tone is `neutral`.

`card-actions.ts`: the interaction branch handles `parsed.action === 'history'` before Warn and Timeout:

```ts
      if (parsed.action === 'history') {
        await deps.responder.deferUpdate(ref);
        try {
          await showHistoryPage(
            deps.commands.history,
            { actorId: event.userId, targetId: parseSnowflakeId(parsed.userId), page: parsed.page, interactionId: event.interactionId },
            ref,
            'edit',
          );
        } catch (err) {
          deps.logger.error(
            safeLogFields({ component: 'mod-card-actions', guildId: deps.guildId, action: 'history', err }),
            'a case-history page click failed',
          );
          await deps.responder.respond(ref, toOutgoingMessage(errorCard('mod.unavailable', { ref: refFor(event.interactionId) })));
        }
        return;
      }
```

`HistoryDeps.responder` is the same responder object, so it has `editOriginal` from Task 2.

- [ ] **Step 3: Gates and commit**

```bash
npx vitest run packages/core/src/mod
npm run typecheck
npm run lint
npm run test
git add packages/core apps/daemon
git commit -m "P2 Task 8: case history is a paged card"
```

---

### Task 9: Role panels post a card

**Files:**
- Modify: `packages/core/src/ui/discord/kit.ts`, `kit.test.ts` (custom emoji on buttons and select options)
- Modify: `packages/core/src/panels/components.ts`, `components.test.ts`
- Modify: `packages/core/src/panels/publish.ts`, `publish.test.ts`
- Modify: `packages/core/src/panels/interactions.ts`, `interactions.test.ts`
- Modify: `packages/core/src/index.ts` (exports: `renderPanelCard`, `panelResultCard`; remove
  `renderPanelMessage`, `describeResult`)
- Modify: `apps/daemon/src/runtime/guild.ts` (`publishDeps.toMessage`)
- Modify: the daemon panel integration test (`rg -ln "publishPanel|postManagedPanel" apps/daemon/src --glob '*.test.ts'`)

**Interfaces:**
- Kit: `Button.emoji` and `SelectOption.emoji` become `{ readonly name: string } | { readonly id: string }`.
  `button({ emoji })` accepts `string | { id: string }`, where a string means a Unicode emoji.
- `renderPanelCard(panel: PanelConfig): CardMessage`. It replaces `renderPanelMessage`.
- `PublishDeps.toMessage(card: CardMessage): OutgoingMessage`. The daemon passes P1's `cardOut`, so the
  banner is attached.
- `panelResultCard(result: ConvergeMemberResult): CardMessage`. It replaces `describeResult`.

**The card:**

```
┃ [banner-panel strip]
┃ <the panel's own text, as the owner wrote it>     (default: **Pick your roles**)
┃ -# Press a role to add it. Press it again to remove it.
┃ ───────────────
┃ [ 🔧 Mechanical ] [ ⚡ Electrical ] [ 💻 Software ] …     (or one select menu)
```

| Behaviour + component | Hint line |
| --- | --- |
| `toggle`, buttons | `Press a role to add it. Press it again to remove it.` |
| `add_only`, buttons | `Press a role to add it. This panel doesn't remove roles.` |
| `remove_only`, buttons | `Press a role to remove it.` |
| `single_choice`, buttons | `Pick one. Picking another swaps it.` |
| any behaviour, `select` | `Choose from the menu. Clear your choice to remove the role.` (for `add_only`: `Choose from the menu.`) |

- [ ] **Step 1: Kit emoji — test first**

In `kit.test.ts`:

```ts
it('takes a custom emoji by id', () => {
  expect(button({ customId: 'a', label: 'A', emoji: { id: '123' } }).emoji).toEqual({ id: '123' });
  expect(button({ customId: 'a', label: 'A', emoji: '🔧' }).emoji).toEqual({ name: '🔧' });
});
```

Widen the two interfaces and `button`'s option:

```ts
  ...(options.emoji === undefined
    ? {}
    : { emoji: typeof options.emoji === 'string' ? { name: options.emoji } : { id: options.emoji.id } }),
```

- [ ] **Step 2: Panel card — tests first**

In `components.test.ts`, replace the `renderPanelMessage` tests with:

1. A button panel with 3 options renders one container. Its first child is a media gallery whose item URL
   is `attachment://banner-panel.png`, and `card.art` is `['bannerPanel']` (use P1's real art key name).
2. With `content` set, the text is the content exactly as written. Markdown is **not** escaped, because
   the owner wrote it: `**Bold** <@&123>` stays as it is. `allowedMentions` is still `{ parse: [] }`, so
   nothing pings.
3. With `content` undefined, the text starts `**Pick your roles**`.
4. One test per row of the hint table above.
5. 25 button options make 5 action rows inside the container, each with 5 buttons, carrying the same
   custom ids `buildCustomId` produced before. The card stays within budget, because `card()` asserts it.
6. A select panel has one action row holding one string select, with `min_values: 0`, and `max_values`
   1 for `single_choice` or the option count otherwise, exactly as before.
7. A custom emoji `c:123` renders `{ id: '123' }`, and a Unicode `u:1f527` renders `{ name: '🔧' }`.

In `interactions.test.ts`, change each `describeResult` assertion into a `panelResultCard` assertion:

| Result | Card |
| --- | --- |
| a refusal (`plan.refusedBecause`) | `errorCard(panelRefusalCode(refusal))`. Assert the title, for example `This panel is switched off`. No Ref. |
| roles granted and revoked | `ok` tone, title `Roles updated`, detail `You now have <@&a>.` / `Removed <@&r>.` |
| granted, but a choice was clamped by `max-roles` | as above, plus the line `💡 You've reached this panel's limit, so not every choice was added.` |
| nothing applied, with a declined reason | the matching panel error card |
| nothing applied, with `refused > 0` | `errorCard('panel.not-applied')` |
| no change | `neutral` tone, title `No change`, detail `Your roles already match.` |
| the subscriber's catch | `errorCard('panel.unavailable')` |

Every reply is sent as `toOutgoingMessage(card)`, so assert `flags: 32768`.

Run `npx vitest run packages/core/src/panels`. Expect FAIL.

- [ ] **Step 3: Implement**

`components.ts`:
1. Rewrite `buildComponents` on the kit. It returns `readonly ActionRow[]`:
   - Buttons use `actionRow(options.slice(i, i + 5).map((o) => button({ customId: buildCustomId(…), label: o.label ?? o.optionId, ...emojiFor(o) })))`.
   - The select uses `selectRow(stringSelect({ customId: buildSelectCustomId(panel.panelId), minValues: 0, maxValues, options: … }))`.
   - `emojiFor(o)` returns `{}`, `{ emoji: { id } }` or `{ emoji: '<chars>' }` from `option.emojiKey`, with
     the decoding the current `emojiForComponent` does.
   - If the kit's `stringSelect` rejects `minValues: 0`, check its guard. Discord allows 0, so adjust the
     guard if it forbids it.
2. Add:

   ```ts
   const PANEL_HINT = (panel: PanelConfig): string => {
     if (panel.component === 'select')
       return panel.behaviour === 'add_only'
         ? 'Choose from the menu.'
         : 'Choose from the menu. Clear your choice to remove the role.';
     switch (panel.behaviour) {
       case 'toggle':
         return 'Press a role to add it. Press it again to remove it.';
       case 'add_only':
         return "Press a role to add it. This panel doesn't remove roles.";
       case 'remove_only':
         return 'Press a role to remove it.';
       case 'single_choice':
         return 'Pick one. Picking another swaps it.';
     }
   };

   /**
    * A managed panel as a card (ADR 0141 decision 10). The owner's text is
    * posted as written: it is their Markdown, and `allowedMentions` stops any
    * mention in it from pinging.
    */
   export const renderPanelCard = (panel: PanelConfig): CardMessage =>
     card({
       tone: 'accent',
       art: ['bannerPanel'],
       children: [
         gallery([{ media: { url: artUrl('bannerPanel') }, description: ART.bannerPanel.alt }]),
         text(panel.content ?? '**Pick your roles**'),
         text(subtext(PANEL_HINT(panel))),
         separator(),
         ...buildComponents(panel),
       ],
     });
   ```

   `artUrl` and `ART` come from P1's `ui/discord/art.ts`. The digest card builds its banner the same way.
3. Delete `renderPanelMessage` and the old raw constants.

`publish.ts`: add `toMessage(card: CardMessage): OutgoingMessage` to `PublishDeps`. Both the post and the
edit send `deps.toMessage(renderPanelCard(panel))`. Republishing a panel posted before P2 edits it into a
card. P0 spike question 3 confirmed that an edit can add the V2 flag. If the P0 notes say it cannot, stop
and record it: the plan would need "delete and repost" instead, which is the owner's decision.

`interactions.ts`:
- Replace `REFUSAL_TEXT` and `describeResult` with `panelResultCard`, following the table in Step 2.
- `PanelResponder.respond` already takes an `OutgoingMessage`. Send `toOutgoingMessage(panelResultCard(result))`.
- Send the catch-all as `toOutgoingMessage(errorCard('panel.unavailable'))`.

`apps/daemon/src/runtime/guild.ts`: `publishDeps` gains `toMessage: cardOut`.

- [ ] **Step 4: Gates and commit**

Update the daemon panel integration test. A published panel is sent with `flags: 32768` and one file
named `banner-panel.png`. Its custom ids are unchanged, so a click still converges.

```bash
npx vitest run packages/core/src/panels packages/core/src/ui/discord
npm run typecheck
npm run lint
npm run test
git add packages/core apps/daemon
git commit -m "P2 Task 9: role panels post a card with the panel banner"
```

---

### Task 10: Assistant reminders and the escalation post

**Files:**
- Create: `apps/daemon/src/assistant/cards.ts`, `apps/daemon/src/assistant/cards.test.ts`
- Modify: `apps/daemon/src/assistant/reminder-delivery.ts`, `reminder-delivery.test.ts`
- Modify: `apps/daemon/src/jobs/assistant.ts` (stage 3) and its test

**Interfaces:**
- Produces, in `assistant/cards.ts`. These are pure functions over `@bananasaurs/core`'s kit:

  ```ts
  export const renderAssistantReminderCard: (reminder: DeliverableReminder) => CardMessage;
  export const renderEscalationCard: (input: {
    guildId: string;
    ticketId: string;
    reviewerRoleIds: readonly string[];
    userId: string;
    channelId: string;
    messageId: string | undefined;
    question: string;
    answer: string;
    at: number;
  }) => CardMessage;
  ```

- `renderReminder` is deleted. `DeliverableReminder` is exported from `reminder-delivery.ts` so the card
  module can name it.
- Consumes: `card({ pingEveryone })` (Task 1), `toOutgoingMessage`, `escapeText`, `truncate`, `subtext`,
  `ts`, `jumpUrl`, `ICON`.

**The reminder card** (no art; ADR 0141 decision 10 overrides the spec's thumbnail):

```
┃ -# ⏰ REMINDER
┃ <@&role> <@user>                         (only when the row has pings; @everyone/@here first)
┃ <the reminder text, mass mentions neutralised>
┃ -# <context, one line>                   (when present)
┃ -# Set by <@creator>
```

**The escalation card** (`hold` tone):

```
┃ -# 🙋 NEEDS A PERSON · IT request <ticketId>
┃ <@&reviewer> <@&reviewer>
┃ <@user> asked in <#channel>:
┃ > <question, escaped, ≤ 500 characters>
┃ **The assistant replied**
┃ > <answer, ≤ 1,500 characters>
┃ -# [Jump to the question](…) · <t:R>
```

- [ ] **Step 1: Failing tests** (`apps/daemon/src/assistant/cards.test.ts`)

Move every behaviour that `reminder-delivery.test.ts` asserts about `renderReminder` into tests of
`renderAssistantReminderCard`. Read the text back with `cardTexts` from `@bananasaurs/core`.

1. Pings and mentions:
   - `allowedMentions` lists exactly the stored `roles` and `users`.
   - `parse` is `['everyone']` only when the row stores `everyone` or `here`, and `[]` otherwise.
   - The card has `flags: 32768` once it goes through `toOutgoingMessage`.
2. The pings line comes first, in the order `@everyone`, `@here`, roles, then users. It is absent when
   the row has no pings.
3. `@everyone` typed into the text or the context is neutralised by `neutraliseMassMentions`, so it
   cannot ping, even when the row's own pings allow `@everyone`.
4. The context collapses to one `-# ` line. A context of only whitespace is left out.
5. `-# Set by <@creator>` is present. The creator's id is in `users` only when the row's `userIds` holds
   it.
6. An `origin: 'mcp'` row with `everyone: true` throws, as `renderReminder` does today.
7. A 5,000-character text is truncated with `…`. The card stays within budget, and the pings line is
   never cut.

Escalation tests:
1. The roles in `reviewerRoleIds` are pinged and nothing else is: `allowedMentions` is
   `{ parse: [], roles: [...] }`.
2. The question is escaped: `**x**` shows as `\*\*x\*\*`.
3. The answer is shown as Markdown in a quote, capped at 1,500 characters.
4. The jump link appears only when `messageId` is defined.
5. The tone is `hold` (accent `0xe0a526`), and the card has no art.

Run `npx vitest run apps/daemon/src/assistant/cards.test.ts`. Expect FAIL.

- [ ] **Step 2: Implement `apps/daemon/src/assistant/cards.ts`**

```ts
import {
  card,
  escapeText,
  ICON,
  jumpUrl,
  subtext,
  text,
  truncate,
  ts,
  type CardMessage,
} from '@bananasaurs/core';
import type { DeliverableReminder } from './reminder-delivery.js';
import { neutraliseMassMentions } from './reminder-summary.js';

const REMINDER_TEXT_MAX = 3_000;

/**
 * An assistant reminder as a card (ADR 0141 decision 10). Only the code-built
 * pings line carries live ping tokens. The member-written text and context
 * have `@everyone`/`@here` neutralised, exactly as the plain-text renderer did
 * (ADR 0086 decision 6).
 */
export const renderAssistantReminderCard = (reminder: DeliverableReminder): CardMessage => {
  if (reminder.origin === 'mcp' && (reminder.mentions.everyone || reminder.mentions.here))
    throw new Error('mcp reminders cannot ping everyone or here');
  const pings: string[] = [];
  if (reminder.mentions.everyone) pings.push('@everyone');
  if (reminder.mentions.here) pings.push('@here');
  for (const roleId of reminder.mentions.roleIds) pings.push(`<@&${roleId}>`);
  for (const userId of reminder.mentions.userIds) pings.push(`<@${userId}>`);
  const context = reminder.context?.replace(/\s+/g, ' ').trim();
  const lines = [
    subtext(`${ICON.due} REMINDER`),
    ...(pings.length === 0 ? [] : [pings.join(' ')]),
    neutraliseMassMentions(truncate(reminder.text, REMINDER_TEXT_MAX)),
    ...(context === undefined || context === '' ? [] : [subtext(neutraliseMassMentions(context))]),
    subtext(`Set by <@${reminder.creatorId}>`),
  ];
  return card({
    tone: 'accent',
    children: [text(lines.join('\n'))],
    pingEveryone: reminder.mentions.everyone || reminder.mentions.here,
    pingRoles: reminder.mentions.roleIds,
    pingUsers: reminder.mentions.userIds,
  });
};

const quote = (body: string): string =>
  body
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

export const renderEscalationCard = (input: {
  guildId: string;
  ticketId: string;
  reviewerRoleIds: readonly string[];
  userId: string;
  channelId: string;
  messageId: string | undefined;
  question: string;
  answer: string;
  at: number;
}): CardMessage => {
  const head = [
    subtext(`${ICON.escalate} NEEDS A PERSON · IT request ${escapeText(input.ticketId)}`),
    ...(input.reviewerRoleIds.length === 0
      ? []
      : [input.reviewerRoleIds.map((id) => `<@&${id}>`).join(' ')]),
    `<@${input.userId}> asked in <#${input.channelId}>:`,
    quote(escapeText(truncate(input.question.trim() || '(empty)', 500))),
  ];
  const footer = [
    ...(input.messageId === undefined
      ? []
      : [`[Jump to the question](${jumpUrl(input.guildId, input.channelId, input.messageId)})`]),
    ts(input.at, 'R'),
  ];
  return card({
    tone: 'hold',
    children: [
      text(head.join('\n')),
      text(`**The assistant replied**\n${quote(truncate(input.answer.trim() || '(empty)', 1_500))}`),
      text(subtext(footer.join(' · '))),
    ],
    pingRoles: input.reviewerRoleIds,
  });
};
```

The answer is model output. It is shown, never acted on, and `allowedMentions` stops any mention in it
from pinging. It keeps its Markdown, because reviewers read it as an answer.

Check that `@bananasaurs/core` exports the kit names imported above (P1 Task 1 added
`export * from './ui/discord/index.js'`). Add any that are missing.

- [ ] **Step 3: Use the cards**

`reminder-delivery.ts`:
- Delete `renderReminder` and its docstring, but move the docstring's ADR 0086 reasoning to
  `renderAssistantReminderCard`.
- Export `DeliverableReminder`.
- In the `origin === 'assistant'` branch, send
  `toOutgoingMessage(renderAssistantReminderCard(row))` from `@bananasaurs/core`. The card has no art, so
  no loader is needed.

`jobs/assistant.ts` stage 3: send

```ts
      await deps.send(
        result.escalation.channelId,
        toOutgoingMessage(
          renderEscalationCard({
            guildId: deps.guildId,
            ticketId: result.escalation.ticketId,
            reviewerRoleIds: result.escalation.reviewerRoleIds,
            userId: payload.userId,
            channelId: payload.channelId,
            messageId: payload.messageId,
            question: Object.values(payload.input).join('\n'),
            answer: result.content,
            at: deps.now(),
          }),
        ),
      );
```

If `deps` has no `guildId`, use the field the job already uses to build its scope. Read the deps
interface to find it.

Update `reminder-delivery.test.ts` and the assistant job test so they assert on the sent message's
`flags`, its `allowedMentions` and `cardTexts(components)`, in place of `content`. Every fact they
asserted before stays asserted.

- [ ] **Step 4: Gates and commit**

```bash
npx vitest run apps/daemon/src/assistant apps/daemon/src/jobs/assistant.test.ts
npm run typecheck
npm run lint
npm run test
git add apps/daemon packages/core
git commit -m "P2 Task 10: assistant reminders and the escalation post are cards"
```

---

### Task 11: The AI log card and the assistant's fallback replies

**Files:**
- Modify: `apps/daemon/src/assistant/log-message.ts`, `log-message.test.ts`
- Modify: `apps/daemon/src/assistant/fallback-replies.ts`
- Modify: `apps/daemon/src/jobs/assistant.ts` (the two inline fallback strings)
- Modify: every test that asserts the old wording. Find them with
  `rg -ln "No action was taken" apps/daemon/src packages`.

**Interfaces:**
- `assistantLogMessage(input: AssistantLogInput): OutgoingMessage` keeps its signature, but returns a
  card message instead of an embed.

**The AI log card:**

```
┃ -# 🤖 MENTION · ANSWERED                 (or /<command> · REFUSED / FAILED)
┃ <@user> in <#channel> · Behaviour: <name>
┃ **Question**
┃ > …
┃ **Answer**
┃ > …
┃ **Reason**                                 (only when present)
┃ > …
┃ -# Tools: search ✓, read_thread ✗ · Model: x (backup model) · 2.3 s
┃ -# Sources: [Title](url), [Title](url)    (links only — ADR 0066)
┃ -# <t:R>
```

| Outcome | Tone |
| --- | --- |
| `answered` | `ok` |
| `refused` | `hold` |
| `failed` | `danger` |

- [ ] **Step 1: Failing tests**

Rewrite `log-message.test.ts` around `cardTexts`, keeping every fact the embed tests checked:
- The question and answer are both present in full, up to the caps.
- Sources are links only, never their text, and `[` and `]` are stripped from titles.
- `allowedMentions` is `{ parse: [] }`.
- The model line shows `(backup model)` only when it was used.
- Reason appears only when given.
- Each outcome maps to its tone.

New facts to assert:
- The message has `flags: 32768` and no `embeds`.
- The question and the reason are escaped, because a member typed them.
- The answer keeps its Markdown.
- Question, answer and reason are each capped at 1,000 characters. The sources line is capped at 1,000
  characters on whole links, as `clipLines` does today.
- The whole card stays within budget.

Wording for fallback replies, asserted wherever the old wording was:

| Constant / site | New text |
| --- | --- |
| `BUSY_REPLY` | `The AI is busy right now, so nothing was done. Try again in a minute.` |
| `dailyQuotaReply` | `Today's free AI allowance is used up, so nothing was done. It resets <t:…:t>.` |
| `jobs/assistant.ts`, the generic failure | `I couldn't finish that answer, so nothing was done. Try again in a minute.` |
| `jobs/assistant.ts`, the behaviour that is gone | `That assistant behaviour was switched off or removed, so nothing was done.` |

These stay plain text, because they are part of the conversation (ADR 0141 decision 10).

Run the tests. Expect FAIL.

- [ ] **Step 2: Implement**

In `log-message.ts`:
- Keep `AssistantLogInput`, `clip` and `clipLines`.
- Drop `COLOURS` and `FIELD_MAX`, and add `const TONE = { answered: 'ok', refused: 'hold', failed: 'danger' } as const;`.
- Build the card from `card`, `text`, `subtext`, `escapeText`, `truncate` and `ts`, in the layout above,
  and return `toOutgoingMessage(card)`.
- The eyebrow label is `MENTION` or `/${command}`, then ` · `, then the outcome upper-cased.
- Escape the behaviour name with `escapeInline`.

Then change the four strings in the table above.

- [ ] **Step 3: Gates and commit**

```bash
npx vitest run apps/daemon/src/assistant apps/daemon/src/jobs/assistant.test.ts
npm run typecheck
npm run lint
npm run test
git add apps/daemon
git commit -m "P2 Task 11: the AI log is a card; fallback replies reworded"
```

---

### Task 12: Gallery, docs and the final sweep

**Files:**
- Modify: `scripts/card-gallery.mjs` (P1 Task 14)
- Modify: `docs/SMOKE_TESTS.md`, `docs/STATE.md`
- Modify: `docs/28_UI_UX_GUIDELINES.md` (only if the error-copy section lists codes; add the P2 ones)

- [ ] **Step 1: Extend the gallery**

Add a `--p2` flag. With it, after the P1 cards, the script posts one of each P2 card from the built core:
- `renderLogCard` for `message_edit` (with buttons), `message_delete`, `member_ban` and `gap`
- `formatAutomodMatch` for `would_delete`, rendered through `renderLogCard`
- `modOutcomeCard` for timeout `applied`, `dry-run` and refused `role-above-bot`
- `warnOutcomeCard` with a refused escalation
- `banConfirmCard`, `purgeConfirmCard` and `deleteConfirmCard`
- `historyCard` built from `buildHistoryPage` with 12 sample events, so that it has two pages
- `renderPanelCard` for a 6-option toggle button panel
- `errorCard('mod.not-allowed', { ref: '23456789' })` and `errorCard('panel.max-roles')`

Use the sample guild's own ids for every mention. Mentions of the bot's application id are fine, because
`allowedMentions` stops them pinging. Its buttons point at nothing real, so pressing them gives a refusal
or an "already handled".

The log, mod and history renderers are pure, so the gallery calls them directly. It never runs a
moderation action.

Run `node --check scripts/card-gallery.mjs` and Prettier on it. Do not run the script itself.

- [ ] **Step 2: Docs**

`docs/SMOKE_TESTS.md`: under the P1 "Card gallery" section, add:

```markdown
### P2 cards (ADR 0141)

    npm run build && npm run smoke:cards -- --channel <test channel id> --p2

- [ ] Log cards are compact: one eyebrow, one line, at most one quote. Buttons only on the message cards.
- [ ] The case-history card's Older/Newer buttons answer privately (sample data is not real).
- [ ] Live, in the test guild with a log route on message_create: press **Delete message** on a real
      log card, confirm, and check the message is gone and `/mod history` shows "Message deleted".
- [ ] Live: press **Timeout**, choose 10 minutes, submit; the member is timed out and the reply says so.
- [ ] Live, as a member without the moderation permission: press **Warn**, submit; the reply says you
      can't, and nothing happened to the target.
- [ ] Republish a role panel posted before this release: it becomes a card with the banner, and its
      buttons still work.
```

`docs/STATE.md`, at the top:

```markdown
**Log, moderation and panel cards (ADR 0141), 2026-10-xx.** Log routes, automod matches, /mod replies,
confirmations, case history, role panels, assistant reminders, escalations and the AI log are all
Components V2 cards. Log cards for messages and automod carry Delete / Warn / Timeout buttons that run
the /mod code path (no MCP equivalent). One error catalogue; refusals never show raw codes. No migration.
Owner check: npm run smoke:cards -- --p2.
```

- [ ] **Step 3: Final sweep**

Each of these must find nothing, or only the lines noted:

```bash
rg -n "content: \`" packages/core/src/mod packages/core/src/logging packages/core/src/panels
rg -n "describeOutcome|describeResult|renderPanelMessage|buildConfirmCancelComponents|renderReminder\b" packages apps
rg -n "embeds:" apps/daemon/src/assistant
rg -n "refused for <@|failed for <@" packages apps
```

The first search may still find text-only log lines in `logger.*` calls. Those are fine; only
`respond`, `sendMessage` and `send` payloads count. The fourth must find nothing.

Then run the gates fresh:

```bash
npm run typecheck
npm run lint
npm run test
git add scripts docs packages apps
git commit -m "P2 Task 12: card gallery for P2, smoke checklist and state"
```

---

## Self-check before handing back

- [ ] Every Review Focus item has a passing test, in the task named.
- [ ] `ModerationGatewayPort` has `deleteMessage`, and every call to it is reached only after
      `authorize(…, 'moderation.act')`.
- [ ] No file under `packages/mcp` changed in this phase, except the guide text if P1 left a sentence to
      fix.
- [ ] No `discord.js` import under `packages/core`.
- [ ] `npm run typecheck`, `npm run lint` and `npm run test` all pass, run fresh.
- [ ] `docs/superpowers/plans/notes/P2-deviations.md` lists every deviation, or does not exist.
