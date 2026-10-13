# P2 deviations

Task 2: plan snippet reads `const files = restFiles(message)` then `...(files.length > 0 ? { files } : {})`, but current `restFiles` returns `undefined` when there are no files (not `[]`); the adapter uses `...(files === undefined ? {} : { files })`, matching `sendMessage`/`editMessage`. Same wire behaviour.
Task 2: plan V2 check is `((message.flags ?? 0) & IS_COMPONENTS_V2) !== 0`; the adapter uses `editMessage`'s `becomesCard` form (`message.flags !== undefined && (message.flags & IS_COMPONENTS_V2) !== 0`). Behaviourally identical.
Task 2: `@` in the `@original` route is percent-encoded as `%40` by the transport (`new URL().pathname` keeps the encoding), so the REST tests assert on `decodeURIComponent(path)`, following the existing reaction-route tests' decoded-path precedent.
Task 2: `editOriginal` was added to the four `SlashResponder` literals in `apps/daemon/src/runtime/guild.ts` only; the panel `InteractionSubscriberDeps` responder (`PanelResponder`: defer/respond only) is a separate interface and was left unchanged, as P1 Task 2 did.
Task 2: compiler-forced harness changes (every other implementer `npm run typecheck` named): `editOriginalResponse` not-used stubs in `packages/core/src/effects/message-gateway.test.ts` and `packages/core/src/effects/moderation-gateway.test.ts` (via each file's `notUsed` helper, next to `respondToInteraction`); `editOriginal` stubs in the `SlashResponder` literals of `packages/core/src/mod/commands.test.ts`, `packages/core/src/mod/confirmations.test.ts`, `packages/core/src/mod/history.test.ts`, `packages/core/src/task/commands.test.ts` (mock, also returned from `baseDeps`), and `apps/daemon/src/mod.integration.test.ts` (three literals wired to `discord.editOriginalResponse`, mirroring `guild.ts`).
Task 3: plan `actionLabel` maps `block_message` / `send_alert_message` / `block_member_interaction`; the real `NativeAutoModAction` in `discord/events.ts` is `block` / `alert` / `timeout` / `block_interaction`, so the subscriber maps those four words (`Blocked the message`, `Sent an alert`, `Timed the member out`, `Blocked an interaction`, else `Other`). Same behaviour.
Task 3: plan `ModCardAction` keeps the `SnowflakeId` brand or `String()`s it; the implementation `String()`s parsed ids so the interface stays plain `string` and the round-trip test passes with string literals.
Task 3: one assertion outside the Files list consumed the old string shape (`apps/daemon/src/daemon.integration.test.ts` role-create log line read `args[2].content`); it now reads the card components for the same role name. Same fact, new shape.
Task 4: plan makes `parentChannelId`/`categoryId` conditional ("if the subscriber knows them"); the message event carries both, so `AutomodMatchInfo` includes them as `string | undefined` and the daemon hook passes them through instead of `undefined`, keeping excluded-channel routing honest.
Task 4: plan table pins `message.exists` only for the listed rows; `escalation_*` outcomes (only reachable after the deletion succeeded) map to `exists: false`, everything else unlisted to `exists: true`; unlisted details are `'Recorded.'` exactly as the table's catch-all says.
Task 5: plan passes `applyAction`'s own `refuse` straight into `preflight`; its declared return (`ModerationOutcome`) is wider than the `preflight` parameter, so `applyAction` passes a narrowing wrapper (`(reason) => refuse(reason) as { status: 'refused'; reason: DeleteRefusalReason }`) instead of the brand alternative. Same behaviour.
Task 4: `automodPortsFor` takes the hook as an optional 7th parameter (`onMatchRecorded?`), so existing callers compile unchanged; `guild.ts` builds `logPoster` just above it and passes the `automod:<messageId>:<ruleId>` closure. `formatAutomodMatch`, `AutomodMatchInfo` and `AutomodActionTaken` are newly exported from `packages/core/src/index.ts` for the daemon wiring.
Task 6: plan builds `modOutcomeCard`/`warnOutcomeCard`/`noteOutcomeCard`/`purgeQueuedCard` on `resultCard`, but `resultCard` escapes its title (pinned by `common-cards.test.ts`), which would mangle the `<@id>`/`<#id>` mentions the plan's own tests require verbatim. `mod/cards.ts` uses a local `outcomeCard` with the identical `**ICON title**` shape, leaving the caller-built title raw and escaping only the reason/content lines. Same words, same tones, same `parse: []`.
Task 7: plan says `executeConfirmedBan` "gains the same parameter" (`interactionId`) for its card Ref; it already takes `interactionId: Snowflake`, so no change was needed there.
Task 7: plan's Step 5 item 1 expected a type-only widening of `modConfirmationDeps.cases.recordCaseEvent` in `guild.ts`; the binding forwards `input.actionTaken` untouched and the storage union already accepts all six delete values plus `escalation_refused` (verified against `schema.ts` CHECK and `ModCaseActionTaken`), so `guild.ts` needed only the subscriber registration. No schema change.
Task 7: plan-mandated test additions live in `packages/core/src/mod/cards.test.ts` and `packages/core/src/mod/confirmations.test.ts` (outside the task's Files list, covered by its forced-harness clause); `confirmations.test.ts`'s `deleteMessage` fake now records instead of throwing.
Task 7: `npx prettier --write` on this task's files also reflowed pre-existing long lines in `cards.ts`/`cards.test.ts` that were already non-conformant at HEAD (verified via `prettier --check` on the HEAD blobs); assertions untouched.
Task 7: the integration test hand-assembles the `guild.ts` port blocks (as `mod.integration.test.ts` does) because `guild.ts` needs a real discord.js `Client`; `modalSubmit` needed no wiring change since `Pipeline.dispatch` delivers every event to every subscriber.

## Task 6 fix round 1: assertion mapping

`git diff 6e1eada2..b076aee1` removed reply-text (`content`, `toMatch`, `toContain`) assertions when `/mod` replies became cards. Every removed line maps to a card-text assertion below (via `cardTexts`, `cardCustomIds` from `ui/discord/inspect.ts`). Line numbers are as of the fix-round commits; test names are the stable reference. Gaps closed in the round are marked `(added this round)`; intentional copy changes are marked `(by design)`.

`apps/daemon/src/mod.integration.test.ts`:
- `replies[0]?.content` `do not have permission` (unauthorized kick) → `mod.integration.test.ts:525` (`You can't take moderation actions`, unauthorized-kick test).
- `replies[0]?.content` `refused` (owner timeout) → `:552` (`The server owner can't be moderated`, owner-target test).
- `replies[0]?.content` `refused` (role-above-bot kick) → `:578` (`That member is above the bot`, high-role test).
- `preview?.content` `Ban preview` → `:602` (`Ban <@T>?`, ban preview test).
- `reply1?.content` `Ban applied` → `:630` (`Banned <@T>`, ban double-tap test).
- `reply2?.content` `already executed` → `:632` (`This was already handled`, same test).
- `preview?.content` `Purge preview` → `:721` (`Delete 5 messages from <#…>?`, purge test).

`packages/core/src/mod/commands.test.ts`:
- `/ban preview/i` → `commands.test.ts:291` (`Ban <@T>?`); `/purge preview/i` → `:310` (`Delete 0 messages` — the "Nothing to purge" empty-channel fact).
- `/do not have permission/i` (kick, warn, note, evidence unauthorized) → `:328`, `:353`, `:703`, `:729` (`You can't take moderation actions`).
- `/applied/` (timeout) → `:406` (`Timed out <@T> for 10 minutes`); (untimeout) → `:458` (`Ended <@T>'s timeout`); unban had no pre-Task-6 reply assertion, new applied coverage at `:477` (`Unbanned <@T>`).
- `/refused/` (kick hierarchy) → `:432` (`That member is above the bot`, plus `not.toContain('role-above-bot')`).
- `/Violation count: 1/` → `:503` (`warning 1`); `not /escalation tier/` kept verbatim at `:504`.
- `/Violation count: 3/` + `/escalation tier/i` + `/applied/` (tier escalation) → `:519`–`:520` (`warning 3`, `its consequence was applied`).
- `/Warning recorded/` (×2 onWarned tests) → `:574`, `:585` (`Warned <@T>`).
- `/note recorded/i` → `:616` (`Added a note to <@T>'s case`); `/evidence.*recorded/i` → `:665` (`Added an evidence link to <@T>'s case`); detail lines (`:617`, `:666`) `(added this round)`.
- `/something went wrong/i` (outer catch) → `:909` (`Couldn't finish that` + Ref).

`packages/core/src/mod/confirmations.test.ts`:
- Confirm (`style: 3`) / Cancel (`style: 4`) button-shape test → replaced by the custom-id test at `:267`–`:278`; Confirm is danger (`style: 4`) `(by design, plan copy)` and both styles in order (`[4, 2]`) are now asserted in `cards.test.ts` (fix task 4).
- `message.content /raiding/` + `components toBeDefined` (ban preview) → `:308`–`:309` (`Ban <@T>?` + `raiding`).
- `/do not have permission/i` (ban preview) → `:329`; (ban confirm re-auth) → `:523`; (purge preview) → `:642`; (purge confirm re-auth) → `:741`.
- `/applied/i` (ban confirm) → `:375` (`Banned <@T>`).
- `/already executed/i` (ban replay) → `:411`; (purge double-tap) → `:725` (`This was already handled`).
- `/only the moderator who ran this command/i` → `:426` (`Only the moderator who started this can confirm it`).
- `/cancelled/i` on `Cancelled. Nothing was done.` → `:449` (`Cancelled`) + `:450` (`Nothing was done`) `(added this round)`.
- `/expired/i` → `:470` (`This confirmation expired`).
- `/something went wrong/i` → `:504` (`Couldn't finish that`).
- Over-budget: old asserted the raw `PURGE_MAX_MESSAGES` number in `content` and `components toBeUndefined` → `:581` (`Too many messages to purge at once`). The number itself is gone `(by design: ERROR_COPY mod.over-budget carries no count)`.
- `/5 message/`, `/3 in the last 14 days/`, `/2 older/` → `:611`, `:613` (`Delete 5 messages from <#…>?`, `3 can go in bulk. 2 are older than 14 days…`).
- `/confirmed/i` on `Purge of <#> confirmed — …background…` → `:699` (`Purging <#>`) + `:700` (`It runs in the background`) `(added this round)`.

Checklist spot-checks: "Purging…" → `:699`–`:700`; "Cancelled" → `:449`–`:450`; "Nothing to purge" → `commands.test.ts:310`; "Cannot purge" (over-budget) → `:581` (number dropped by design, see above); "Cannot unban" → no pre-Task-6 test ever asserted an unban refusal reply, so nothing to restore — the refusal path is shared with kick (`commands.test.ts:432`) and unit-covered for every action via the `modOutcomeCard` refused/failed tests in `cards.test.ts`, with unban-applied at `commands.test.ts:477`; "already executed" → `:411`, `:725`; "Violation count: 3" → `commands.test.ts:519`; "escalation tier" → `:504` + `:520`; "do not have permission" → all `You can't take moderation actions` sites listed above.

## Fix wave (budget by construction, history self-authorship, cycle removal)

- Fix wave task 1: `logging/cards.ts` caps final rendered strings — head text ≤1,000 chars, quote block (label + quoted lines) ≤1,500, changes block ≤1,300 including fences (content truncated, closing fence re-added). A cut spoiler is closed with `||` within budget, and a cut landing right after `> ` (whose space `truncate`'s trimEnd eats) rolls back to a `> …` line, so every quoted line keeps its prefix.
- Fix wave task 3: shared `fitText` caps formatted task titles/team names/quotes at their renderer limits, so escaping cannot exceed the intended field budgets.
- Fix wave task 3: moderation reason lines are capped at 700 final characters and note/evidence details at 900 final characters after escaping.
- Fix wave task 3: case-history event lines are capped at 600 final characters after snippet escaping.
- Fix wave task 3: managed-panel owner content is capped at 1,500 final characters before it reaches the card.
- Fix wave task 3: common result-card titles/details use final-length fitting, preserving the 4,000-character card budget after escaping.

## Task 8

- Task 8: plan-mandated test additions live in `packages/core/src/mod/cards.test.ts` (`describeCaseEvent` 23-value table, `historyCard` render/budget/buttons) and `packages/core/src/mod/card-actions.test.ts` (history page-click branch), outside the task Files list under its forced-harness clause (Task 7 precedent). `commands.test.ts` history assertions moved from `content` to `cardTexts` the same way.
- Task 8: `HistoryPage` carries one field beyond the plan shape, `totalEvents` (every event across every case). The header's event total cannot come from `countsByKind` (only the 10 counted buckets) or from the 8-event page slice. Additive only; every plan-named field exists unchanged.
- Task 8: `isSelfAuthored` is now exported from `mod/history.ts` (`cards.ts`'s `describeCaseEvent` imports it). `commands.ts` needed no change: `handleHistory` already receives the interaction id via the slash event. `packages/testkit/src` needed no change: the fake records `editOriginal` since Task 2.
- Task 8: the opened-at timestamp the old text history rendered per case is gone, per the plan sketch — the footer carries `Case <ref> (<status>, <n> violations, tier <t>)` only. Event times render as Discord `<t:d>` timestamps, not ISO strings.
- Task 8: the no-history reply uses `resultCard` verbatim as specified, whose title escaping turns the `<@U>` mention into ZWSP-escaped text (no ping either way, `parse: []`); the test asserts the words plus the id digits, not the raw mention.
Task 9: `inspect.ts`/`inspect.test.ts` copied character for character from the plan's Task 6 Step 1 blocks, then `npx prettier --write` (as ordered) reformatted only the sample literal's long lines; the parallel branch runs the same command on the same input, so the files still match byte for byte.
Task 9: `publish.test.ts` and `interactions.test.ts` did not exist on this branch (the plan says "Modify"); created them with the plan's Step 2 assertions — the refusal/grant/clamp/declined/not-applied/no-change/catch table, `flags: 32768` on every reply, and post/edit routing through `toMessage`.
Task 9: the plan's spread-ready `emojiFor` (`{}`, `{ emoji: { id } }`, `{ emoji: '<chars>' }`) cannot spread unchanged into a select option under strict TS, because `SelectOption.emoji` takes `{ name } | { id }`, not a bare string; buttons spread `emojiFor` directly and select options go through a `selectEmojiFor` adapter that wraps characters as `{ name }`. Same wire bytes.
Task 9: `panelResultCard`'s ok/neutral cases are built with `card()` plus `text()` rather than `resultCard()`, because `resultCard` runs its detail through `escapeText`, which would neutralise the live `<@&role>` mentions the Step 2 table requires (`You now have <@&a>.`); `toOutgoingMessage` still sends `{ parse: [] }`, so nothing pings. Refusal/declined/not-applied/unavailable cases return `errorCard(...)` exactly.
Task 9: compiler-forced harness change: the `PublishDeps` literal in `apps/daemon/src/mcp/wiring.test.ts` gains a `toMessage` stub (banner file bytes inline), mirroring the new required field.
Task 9: the `renderPanelMessage` mention in `packages/core/src/panels/model.ts` (a docstring, line 96) was left stale; the file is outside this task's Files list and Task 12's final sweep searches for the old name.
Task 10: the plan's "delete `renderReminder`" predates ADR 0145's `style === 'message'` branch (owner's own words as plain text); the message branch stays plain text exactly as before via an internal `renderMessageReminder`, and only the default style goes through the new `renderAssistantReminderCard`. `DeliverableReminder` is exported from `reminder-delivery.ts` as the plan requires.
Task 10: the `reminder-delivery.test.ts` no-model import allowlist gains `./cards.js` and the `toOutgoingMessage` core name, mirroring the new card send; no provider-layer name is added.
Task 10: the plan's Step 3 test list missed two files asserting the old shapes, so they assert cards now with every fact kept: `apps/daemon/src/assistant/commands.test.ts` (both escalation sends assert `flags: 32768`, reviewer `allowedMentions`, and `cardTexts` holding the ticket id) and `apps/daemon/src/jobs/reminders.test.ts` (the handler delivery asserts `flags`, `cardTexts` of the eyebrow/text/Set-by lines, and `allowedMentions`). Both files are outside the task's Files list; no production code outside the list changed.
Task 12 Step 2b: no `LogEventKind` union is exported anywhere in the logging module (`LOG_EVENT_KINDS` and `AUDIT_EVENT_KINDS` are both `readonly string[]`), so the 37-value union (verified against the built `LOG_EVENT_KINDS` at runtime) lives in `logging/cards.ts` next to the table it keeps exhaustive, and `LOG_KIND_META` is `Record<LogEventKind | 'gap', Meta>` (the plan's `Record<LogEventKind, Meta>` would reject the `gap` row). `LogCardView.kind` stays `string` so `audit-items.ts`/`subscriber.ts` compile unchanged, and `FALLBACK` stays because a non-union string can still reach the lookup. Mutant check: deleting the `gap` row fails `tsc` with TS2741. The three test files import `cardTexts`/`cardCustomIds` relatively (`../ui/discord/inspect.js`) inside core and from `@bananasaurs/core` in the daemon, with `?? []` where `OutgoingMessage.components` is optional; all 88 tests pass unchanged.
