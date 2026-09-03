import { randomUUID } from 'node:crypto';
import {
  authorize,
  ModerationActionGateway,
  parseGuildId,
  safeLogFields,
  serialiseTrace,
  type Actor,
  type AutomodSubscriberDeps,
  type Authorized,
  type DiscordPort,
  type Logger,
  type MatchTrace,
  type ModerationGatewayDeps,
  type ModerationRefusalReason,
} from '@bananasaurs/core';
import {
  authzStoreFor,
  automodFixtureRepo,
  automodRuleRepo,
  guildRepo,
  modCaseRepo,
  pipelineRepo,
  type GuildScope,
} from '@bananasaurs/storage';

/**
 * Binds the automod ports to one guild (ADR 0035, Task 10).
 *
 * Mirrors `panels/wiring.ts`: the composition root is the only place that
 * knows both the domain (`AutomodSubscriberDeps`, `ModerationActionGateway`)
 * and the database (`GuildScope`), so this is where the two meet. Exported —
 * not private to `guild.ts` — for the same reason `panelAuthorization`/
 * `panelEffectsFor`/`panelStoreFor` are: Task 12's integration test needs to
 * construct this exact wiring, not re-derive it by hand a second time.
 */

/**
 * Who acts when the automod subscriber escalates a violation.
 *
 * Not the member who tripped the rule, and not a moderator — nobody clicked
 * anything. `system` mirrors `panels/wiring.ts`'s `PANEL_ACTOR`: authorized by
 * being wired into the daemon (`authz.ts`'s `SYSTEM_ACTORS`), not by a grant a
 * club officer could revoke by accident and then wonder why automod silently
 * stopped escalating. Every other safety layer still runs on every call —
 * kill switch, breaker, live hierarchy, idempotency, dry run (`CLAUDE.md`
 * rule 1: only deterministic, authorised code executes anything).
 */
export const AUTOMOD_ACTOR: Actor = { type: 'system', id: undefined, roleIds: [] };

/**
 * The longest string `matchTraceSchema`'s `detail` accepts (`trace.ts`).
 * Kept in sync by hand rather than imported, because `trace.ts` does not
 * export the number — this is a copy for the truncation below, not a second
 * source of truth for the schema's own bound.
 */
const DETAIL_MAX = 120;

/**
 * A valid trace that says a valid one could not be produced (IMPORTANT-3,
 * coordinator ruling).
 *
 * `listUnreviewedMatches` filters on `trace IS NOT NULL` to cleanly exclude
 * manual `/mod` events and native AutoMod events, which have no trace and
 * are not ours to review. PR-7's plan ruling justified that filter by saying
 * only pre-Slice-2 rows can lack a trace — which is false: when a predicate
 * produces a trace its *own* schema rejects, writing the case event without
 * one would silently and permanently exclude that match from review, and
 * the class of predicate that gets its trace construction wrong correlates
 * with the class that gets its matching wrong. So the case event always
 * gets *a* trace — a placeholder naming the failure — and stays reviewable.
 */
const placeholderTrace = (kind: MatchTrace['kind'], reason: string): MatchTrace => ({
  kind,
  matchedOn: '(the predicate produced an invalid trace)',
  span: undefined,
  normalisations: [],
  detail: {
    traceError: reason.length > DETAIL_MAX ? `${reason.slice(0, DETAIL_MAX - 3)}...` : reason,
  },
});

/**
 * Serialises a trace, falling back to a placeholder that says serialisation
 * failed (plan ruling PR-8, revised by the IMPORTANT-3 coordinator ruling).
 *
 * `serialiseTrace` throws when a predicate produced a trace its own schema
 * rejects — a bug in our code, which is why it throws rather than returning
 * a result. The composition root is not the place to let that bug become a
 * moderation outage, so the case event is always written (ADR 0036), and
 * always with a trace: writing `undefined` here used to mean the match
 * vanished from `automod review` forever (IMPORTANT-3). The placeholder is
 * serialised through the same validator as any other trace — if *that*
 * fails, it is a bug in the placeholder, not a reason to give up and return
 * nothing, so it is allowed to throw here rather than being caught again.
 *
 * Exported — not private to this module's own `recordCaseEvent` closure —
 * so `wiring.test.ts` can prove the fallback path directly rather than only
 * through a full pipeline integration test standing up a predicate that
 * deliberately misbehaves.
 */
export const traceJson = (scope: GuildScope, logger: Logger, trace: MatchTrace): string => {
  try {
    return serialiseTrace(trace);
  } catch (err) {
    logger.error(
      safeLogFields({ component: 'automod', guildId: scope.guildId, err }),
      'the predicate produced a trace that failed validation; recording a placeholder trace instead',
    );
    const reason = err instanceof Error ? err.message : String(err);
    return serialiseTrace(placeholderTrace(trace.kind, reason));
  }
};

/** The witness the automod subscriber runs under. Obtained honestly, never cast. */
export const automodAuthorization = (scope: GuildScope): Authorized<'moderation.act'> => {
  const result = authorize(
    { store: authzStoreFor(scope), guildId: parseGuildId(scope.guildId), actor: AUTOMOD_ACTOR },
    'moderation.act',
  );
  if (!result.ok) {
    throw new Error(`automod could not obtain authorization: ${result.error.reason}`);
  }
  return result.value;
};

/**
 * A distinct `event_kind`, in the same `event_dedupe` table `LoggingPorts`
 * and `MessageDeleteAttributionPorts` already claim against for an analogous
 * reason (ADR 0023: claim before an idempotent Discord call).
 *
 * `ModerationActionGateway`'s idempotency layer (mirroring `EffectGateway`'s
 * layer 9) needs a durable, guild-scoped, insert-or-ignore claim keyed on the
 * intent's `dedupeKey` before the REST call — CLAUDE.md rule 6. Task 1's
 * schema has no table shaped for that (`mod_rules`/`mod_cases`/
 * `mod_case_events` all serve a different purpose), and adding one is a
 * schema change outside this task's scope. `event_dedupe`'s primary key is
 * `(guild_id, event_kind, fingerprint)` with no `CHECK` on `event_kind`
 * (`schema.ts`), so a new, distinct `event_kind` here cannot collide with the
 * pipeline's own `messageCreate`/`messageUpdate` fingerprints, which are
 * recorded under those events' own kind strings.
 */
const MODERATION_CLAIM_EVENT_KIND = 'automod-moderation-action';

/** Constructs the one gateway that may time out or kick a member for this guild. */
export const automodGatewayFor = (
  scope: GuildScope,
  discord: DiscordPort,
  logger: Logger,
  now: () => number,
): ModerationActionGateway =>
  new ModerationActionGateway({
    guildId: parseGuildId(scope.guildId),
    authz: authzStoreFor(scope),
    discord,
    logger,
    now,
    state: { read: () => guildRepo.readSafetyState(scope) },
    claims: {
      claim: (dedupeKey) => ({
        claimed: pipelineRepo.recordFirstSight(scope, {
          eventKind: MODERATION_CLAIM_EVENT_KIND,
          fingerprint: dedupeKey,
          atMs: now(),
        }),
      }),
    },
  } satisfies ModerationGatewayDeps);

/**
 * The full port set `createAutomodSubscriber` needs, bound to one guild.
 *
 * `gateway` and `auth` are taken as parameters rather than built inside —
 * mirroring `panelEffectsFor(scope, gateway, auth, now)` — so a caller (this
 * module's own `guild.ts`, or Task 12's test) can construct or fake either
 * independently of this function.
 */
export const automodPortsFor = (
  scope: GuildScope,
  discord: DiscordPort,
  gateway: ModerationActionGateway,
  auth: Authorized<'moderation.act'>,
  logger: Logger,
  now: () => number,
): AutomodSubscriberDeps => {
  const guildId = parseGuildId(scope.guildId);

  return {
    logger,
    moderationAuth: auth,
    listRules: () => automodRuleRepo.listEnabledRules(scope),
    hasRoleExemption: (ruleId) => automodRuleRepo.hasRoleExemption(scope, ruleId),
    isExempt: (ruleId, input) => automodRuleRepo.isExempt(scope, ruleId, input),
    // Narrower than `DiscordPort.deleteMessage(guildId, ref, reason)` — the
    // subscriber only ever names a channel and a message, so the guild id is
    // closed over here rather than threaded through the subscriber's own
    // interface (which knows nothing about guilds; that is `core`'s
    // boundary, ADR 0014).
    deleteMessage: (channelId, messageId, reason) =>
      discord.deleteMessage(guildId, { channelId, messageId }, reason),
    openOrResolveCase: (memberId, options) =>
      modCaseRepo.openOrResolveCase(scope, {
        memberId,
        now: now(),
        countsAsViolation: options.countsAsViolation,
      }),
    captureFixture: (input) =>
      automodFixtureRepo.captureObservedFixture(scope, {
        messageId: input.messageId,
        content: input.content,
        authorId: input.authorId,
        createdAt: input.atMs,
      }),
    recordCaseEvent: (input) => {
      // Computed once, not once per spread branch below: `serialiseTrace`
      // parses and re-stringifies the trace, so calling it twice would do
      // that work twice for no reason (plan ruling PR-8).
      const trace = traceJson(scope, logger, input.trace);
      modCaseRepo.recordCaseEvent(scope, {
        eventId: randomUUID(),
        at: now(),
        caseId: input.caseId,
        ruleId: input.ruleId,
        memberId: input.memberId,
        matchedCategory: input.matchedCategory,
        matchedSnippet: input.matchedSnippet,
        actionTaken: input.actionTaken,
        // `exactOptionalPropertyTypes` (tsconfig) treats an optional property
        // set to literal `undefined` as distinct from the property being
        // absent, and `RecordCaseEventInput` wants the latter — so these two
        // are included only when a value actually exists, via spread, rather
        // than assigned `undefined` directly.
        ...(input.escalationAction !== undefined && {
          escalationAction: input.escalationAction,
        }),
        // `core`'s interface deliberately widens this to a bare `string` so
        // `packages/core` need not depend on `@bananasaurs/storage`'s
        // `ModCaseRefusalReason` (ADR 0014). The composition root is exactly
        // the place allowed to narrow it back: the only values that ever
        // flow through here are `ModerationOutcome['reason']`, whose
        // `ModerationRefusalReason` union (also `core`) is identical to
        // `ModCaseRefusalReason`'s, member for member.
        ...(input.refusalReason !== undefined && {
          refusalReason: input.refusalReason as ModerationRefusalReason,
        }),
        ...(input.fixtureId !== undefined && { fixtureId: input.fixtureId }),
        trace,
      });
    },
    nextEscalationTier: (violationCount) => modCaseRepo.nextEscalationTier(violationCount),
    // Literally the same call `automodGatewayFor` above passes as the
    // gateway's `state.read()`. Deliberately one function referenced twice
    // rather than two reads of two different things: dry run, the kill switch
    // and the breaker are guild-level settings, so the deletion and the
    // escalation must agree about them, and the only way to guarantee that is
    // for both to read the same row through the same function.
    readSafetyState: () => guildRepo.readSafetyState(scope),
    moderationGateway: gateway,
    authorRoleIds: async (userId) => (await discord.fetchMember(guildId, userId)).roleIds,
  };
};
