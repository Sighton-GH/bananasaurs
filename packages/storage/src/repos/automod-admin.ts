import { and, asc, desc, eq, inArray, isNull, like, sql } from 'drizzle-orm';
import {
  modCaseEvents,
  modCases,
  modMatchReviews,
  modRuleExemptions,
  modRules,
} from '../schema.js';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import type { RuleKind } from './automod-rules.js';
import type { ModCase } from './mod-cases.js';

/**
 * Read-mostly queries for the dashboard's automod pages (Slice 8). Kept out
 * of `automod-rules.ts` deliberately: that module owns the subscriber's hot
 * path, and nothing here changes what a rule does, only what an operator can
 * see about it. The one write, `removeExemption`, is the inverse of two
 * writers that already live there.
 */

export interface AdminRule {
  readonly ruleId: string;
  readonly kind: RuleKind;
  readonly name: string;
  readonly enabled: boolean;
  readonly config: string;
  readonly countsAsViolation: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const RULE_COLUMNS = {
  ruleId: modRules.ruleId,
  kind: modRules.kind,
  name: modRules.name,
  enabled: modRules.enabled,
  config: modRules.config,
  countsAsViolation: modRules.countsAsViolation,
  createdAt: modRules.createdAt,
  updatedAt: modRules.updatedAt,
};

const toAdminRule = (row: {
  ruleId: string;
  kind: string;
  name: string;
  enabled: number;
  config: string;
  countsAsViolation: number;
  createdAt: number;
  updatedAt: number;
}): AdminRule => ({
  ...row,
  kind: row.kind as RuleKind,
  enabled: row.enabled === 1,
  countsAsViolation: row.countsAsViolation === 1,
});

export const listRules = (scope: GuildScope): readonly AdminRule[] =>
  read(scope, (db) =>
    db
      .select(RULE_COLUMNS)
      .from(modRules)
      .where(scope.only(modRules))
      .orderBy(asc(modRules.ruleId))
      .all()
      .map(toAdminRule),
  );

export const findRule = (scope: GuildScope, ruleId: string): AdminRule | undefined =>
  read(scope, (db) => {
    const row = db
      .select(RULE_COLUMNS)
      .from(modRules)
      .where(scope.only(modRules, eq(modRules.ruleId, ruleId)))
      .get();
    return row === undefined ? undefined : toAdminRule(row);
  });

export interface RuleExemption {
  readonly exemptType: 'role' | 'channel';
  readonly exemptId: string;
}

export const listExemptions = (scope: GuildScope, ruleId: string): readonly RuleExemption[] =>
  read(scope, (db) =>
    db
      .select({ exemptType: modRuleExemptions.exemptType, exemptId: modRuleExemptions.exemptId })
      .from(modRuleExemptions)
      .where(scope.only(modRuleExemptions, eq(modRuleExemptions.ruleId, ruleId)))
      .orderBy(asc(modRuleExemptions.exemptType), asc(modRuleExemptions.exemptId))
      .all()
      .map((r) => ({ exemptType: r.exemptType as 'role' | 'channel', exemptId: r.exemptId })),
  );

export const removeExemption = (
  scope: GuildScope,
  input: {
    readonly ruleId: string;
    readonly exemptType: 'role' | 'channel';
    readonly exemptId: string;
  },
): boolean =>
  write(scope, ({ db }) => {
    const result = db
      .delete(modRuleExemptions)
      .where(
        scope.only(
          modRuleExemptions,
          and(
            eq(modRuleExemptions.ruleId, input.ruleId),
            eq(modRuleExemptions.exemptType, input.exemptType),
            eq(modRuleExemptions.exemptId, input.exemptId),
          ),
        ),
      )
      .run();
    return result.changes > 0;
  });

export const countMatchesByRule = (scope: GuildScope): Readonly<Record<string, number>> =>
  read(scope, (db) =>
    Object.fromEntries(
      db
        .select({ ruleId: modCaseEvents.ruleId, n: sql<number>`count(*)` })
        .from(modCaseEvents)
        .where(scope.only(modCaseEvents))
        .groupBy(modCaseEvents.ruleId)
        .all()
        .map((r) => [r.ruleId, Number(r.n)]),
    ),
  );

export const countReviewedByRule = (scope: GuildScope): Readonly<Record<string, number>> =>
  read(scope, (db) =>
    Object.fromEntries(
      db
        .select({ ruleId: modCaseEvents.ruleId, n: sql<number>`count(*)` })
        .from(modMatchReviews)
        .innerJoin(
          modCaseEvents,
          and(
            eq(modMatchReviews.guildId, modCaseEvents.guildId),
            eq(modMatchReviews.eventId, modCaseEvents.eventId),
          ),
        )
        .where(scope.only(modMatchReviews))
        .groupBy(modCaseEvents.ruleId)
        .all()
        .map((r) => [r.ruleId, Number(r.n)]),
    ),
  );

export const listRecentCases = (
  scope: GuildScope,
  query: { readonly limit: number },
): readonly ModCase[] =>
  read(scope, (db) =>
    db
      .select()
      .from(modCases)
      .where(scope.only(modCases))
      .orderBy(desc(modCases.openedAt), sql`rowid DESC`)
      .limit(query.limit)
      .all()
      .map((row) => ({
        caseId: row.caseId,
        memberId: row.memberId,
        openedAt: row.openedAt,
        violationCount: row.violationCount,
        escalationTier: row.escalationTier,
        status: row.status as ModCase['status'],
      })),
  );

export const findCase = (scope: GuildScope, caseId: string): ModCase | undefined =>
  read(scope, (db) => {
    const row = db
      .select()
      .from(modCases)
      .where(scope.only(modCases, eq(modCases.caseId, caseId)))
      .get();
    return row === undefined
      ? undefined
      : {
          caseId: row.caseId,
          memberId: row.memberId,
          openedAt: row.openedAt,
          violationCount: row.violationCount,
          escalationTier: row.escalationTier,
          status: row.status as ModCase['status'],
        };
  });

/** Native AutoMod decisions (rule_id 'native:…') nobody has ruled on, oldest first. No trace, no fixture: the evidence is the snippet Discord sent. */
export interface NativeHit {
  readonly eventId: string;
  readonly ruleId: string; // 'native:<discord rule id>'
  readonly memberId: string;
  readonly at: number;
  readonly matchedCategory: string; // Discord's trigger type
  readonly matchedSnippet: string;
  readonly actionTaken: string; // one of the native_* values
}

export const listUnreviewedNativeHits = (
  scope: GuildScope,
  query: { readonly limit: number },
): readonly NativeHit[] =>
  read(scope, (db) =>
    db
      .select({
        eventId: modCaseEvents.eventId,
        ruleId: modCaseEvents.ruleId,
        memberId: modCaseEvents.memberId,
        at: modCaseEvents.at,
        matchedCategory: modCaseEvents.matchedCategory,
        matchedSnippet: modCaseEvents.matchedSnippet,
        actionTaken: modCaseEvents.actionTaken,
      })
      .from(modCaseEvents)
      .leftJoin(
        modMatchReviews,
        and(
          eq(modMatchReviews.guildId, modCaseEvents.guildId),
          eq(modMatchReviews.eventId, modCaseEvents.eventId),
        ),
      )
      .where(
        scope.only(
          modCaseEvents,
          like(modCaseEvents.ruleId, 'native:%'),
          isNull(modMatchReviews.eventId),
        ),
      )
      .orderBy(asc(modCaseEvents.at), sql`mod_case_events.rowid`)
      .limit(query.limit)
      .all(),
  );

export interface VerdictCounts {
  readonly falsePositive: number;
  readonly truePositive: number;
  readonly unclear: number;
}

/** Verdicts per rule, attributed through the event each verdict names — the numerator Release 2's gate is written against. Rules with no verdicts are absent. */
export const countVerdictsByRule = (scope: GuildScope): Readonly<Record<string, VerdictCounts>> =>
  read(scope, (db) => {
    const rows = db
      .select({
        ruleId: modCaseEvents.ruleId,
        verdict: modMatchReviews.verdict,
        n: sql<number>`count(*)`,
      })
      .from(modMatchReviews)
      .innerJoin(
        modCaseEvents,
        and(
          eq(modMatchReviews.guildId, modCaseEvents.guildId),
          eq(modMatchReviews.eventId, modCaseEvents.eventId),
        ),
      )
      .where(scope.only(modMatchReviews))
      .groupBy(modCaseEvents.ruleId, modMatchReviews.verdict)
      .all();
    const out: Record<string, { falsePositive: number; truePositive: number; unclear: number }> =
      {};
    for (const row of rows) {
      const counts = out[row.ruleId] ?? { falsePositive: 0, truePositive: 0, unclear: 0 };
      if (row.verdict === 'false_positive') counts.falsePositive += Number(row.n);
      else if (row.verdict === 'true_positive') counts.truePositive += Number(row.n);
      else if (row.verdict === 'unclear') counts.unclear += Number(row.n);
      out[row.ruleId] = counts;
    }
    return out;
  });

/** How many native AutoMod decisions that stopped a message this guild has recorded — `native_blocked`, `native_timeout` and `native_blocked_interaction`; `native_alerted` lets the message through and is excluded. Nonzero means the observe window measures a stream native already filtered (spec F3.2). */
export const countNativeBlocked = (scope: GuildScope): number =>
  read(scope, (db) => {
    const row = db
      .select({ n: sql<number>`count(*)` })
      .from(modCaseEvents)
      .where(
        scope.only(
          modCaseEvents,
          inArray(modCaseEvents.actionTaken, [
            'native_blocked',
            'native_timeout',
            'native_blocked_interaction',
          ]),
        ),
      )
      .get();
    return row === undefined ? 0 : Number(row.n);
  });
