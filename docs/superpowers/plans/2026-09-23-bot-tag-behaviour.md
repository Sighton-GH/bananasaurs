# Training check becomes a warning; tagging @Bananasaurs answers with a chosen behaviour

Status: **EXECUTED 2026-09-23 on branch `bot-tag-behaviour`.** Task 1 ran through opencode; tasks 2-6 were built in-session after the opencode limit.
Branch: `bot-tag-behaviour`. Global gate for every task:
`npm run typecheck && npm run lint && npm run test`.

## A. The training check becomes a warning (owner instruction, 2026-09-23)

Today a provider whose terms record says `trainsOnInput` is `yes` or `unknown`
is refused. The owner has decided to allow it, with a warning.

- `assertProviderEligible` (`packages/core/src/providers/eligibility.ts`) stops
  throwing on `trainsOnInput`. It still throws when production use is not
  allowed. A new helper, `providerMayTrain(e)`, returns `e.trainsOnInput !== 'no'`.
- `apps/daemon/src/assistant/service.ts` still requires a terms record. When
  `providerMayTrain` is true, it proceeds and logs one `warn` line per invoke
  (`component: 'assistant'`, `guildId`, `provider`,
  `msg: 'provider may train on server content'`).
- Setup tracker (`packages/http/src/routes/assistant-setup.ts`): a new step
  state, `warning`. The terms step shows `warning` with the detail
  "<Name>'s terms record says it may train on your data. Member questions and
  server excerpts sent to it may be used for training." A `warning` counts as
  done for `answering`. The dashboard tracker renders it with the warning tone.
- `doctor` and overview warnings (`isEligible`, reason `not-no`) stay as they
  are. They are the standing warning. The `provider review` CLI text drops the
  words "no server content may be sent to it".
- Docs: ADR 0062 records the decision and supersedes the refusal. `CLAUDE.md`
  hard rule 5 is rewritten to match. `PRIVACY.md` is corrected so it no longer
  promises members "not used to train AI models". It says instead that the
  configured provider may train on what is sent, and that the setup page
  shows which.

## B. Tagging @Bananasaurs (ADR 0063)

Root cause: `routeAssistantMention` answers only **role** tags mapped to a
behaviour. A tag of the bot user (`<@botId>`) is ignored.

- Storage: `assistant_behaviours.answers_bot_tag` (integer 0/1, default 0,
  bool check), plus the partial unique index
  `assistant_behaviours_one_bot_tag` on `(guild_id) WHERE answers_bot_tag = 1`.
  That index allows at most one per guild, enforced by the database.
- The migration's data step flags the single enabled `bananasaurs`-surface
  behaviour (the all-round club assistant), only if exactly one exists.
- Repo: `toBehaviour` exposes `answersBotTag`. `putBehaviour` inserts 0 and
  never changes the flag on update. `setBotTagBehaviour(scope, behaviourId |
  null, now)` clears the flag and sets it on one behaviour in one write.
- Router: a bot-user tag (`<@id>` or `<@!id>`) goes to the enabled flagged
  behaviour. If there is none, it is ignored. A mapped role tag in the same
  message wins. For bot tags, the caller-role check is left to the service, as
  with `/ask`: the owner is exempt and a refusal is visible. The tag is removed
  from the prompt.
- HTTP: `PUT /api/assistant/bot-tag` `{ behaviourId: string | null }`,
  `config.write`. Unknown id → 404. Disabled behaviour → 409
  `behaviour-disabled`. The change is audited as `assistant_bot_tag.set`
  with before and after. The behaviours list carries `answersBotTag`.
- Dashboard (Assistant page): a card, "When someone tags @Bananasaurs, answer
  with: [enabled behaviours ▾ | Nobody]" with a Save button, and a "Tag
  @Bananasaurs" badge on the chosen behaviour's card.

## Tasks

1. Docs: ADR 0062, ADR 0063, `CLAUDE.md` rule 5, and `PRIVACY.md`.
2. The training check becomes a warning: core, service, setup tracker (server
   and dashboard), CLI text, and tests.
3. Storage: column, index, migration with the data step, repo, and tests
   (including that a second flag is rejected by the database).
4. Core type, router and subscriber wiring, with tests.
5. HTTP route and behaviour list field, with tests.
6. Dashboard picker and badge, with tests.

## Out of scope

- Answering replies to the bot's own messages without a tag.
- Any member-facing notice inside Discord answers. `PRIVACY.md` is the
  disclosure.
