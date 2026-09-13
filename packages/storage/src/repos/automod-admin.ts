import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  modCaseEvents,
  modCases,
  modMatchReviews,
  modRuleExemptions,
  modRules,
} from '../schema.js';
import type { GuildScope } from '../scope.js';
import { read, write } from '../write.js';
import type { CutoverState, RuleKind, RuleMode } from './automod-rules.js';
import type { ModCase } from './mod-cases.js';

/**
 * Read-mostly queries for the dashboard's automod pages (Slice 8). Kept out
 * of `automod-rules.ts` deliberately: that module owns the state machine
 * (`setRuleMode`) and the subscriber's hot path, and the observe window is
 * running — nothing here changes what a rule does, only what an operator can
 * see about it. The one write, `removeExemption`, is the inverse of two
 * writers that already live there.
 */

export interface AdminRule {
  readonly ruleId: string;
  readonly kind: RuleKind;
  readonly name: string;
  readonly mode: RuleMode;
  readonly enabled: boolean;
  readonly config: string;
  readonly cutoverState: CutoverState;
  readonly observeStartedAt: number | null;
  readonly legacyRuleRef: string | null;
  readonly countsAsViolation: boolean;
  readonly maxFalsePositiveRate: number;
  readonly minReviewedMatches: number;
  readonly enforceSignedOffBy: string | null;
  readonly enforceSignedOffAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const RULE_COLUMNS = {
  ruleId: modRules.ruleId,
  kind: modRules.kind,
  name: modRules.name,
  mode: modRules.mode,
  enabled: modRules.enabled,
  config: modRules.config,
  cutoverState: modRules.cutoverState,
  observeStartedAt: modRules.observeStartedAt,
  legacyRuleRef: modRules.legacyRuleRef,
  countsAsViolation: modRules.countsAsViolation,
  maxFalsePositiveRate: modRules.maxFalsePositiveRate,
  minReviewedMatches: modRules.minReviewedMatches,
  enforceSignedOffBy: modRules.enforceSignedOffBy,
  enforceSignedOffAt: modRules.enforceSignedOffAt,
  createdAt: modRules.createdAt,
  updatedAt: modRules.updatedAt,
};

const toAdminRule = (row: {
  ruleId: string;
  kind: string;
  name: string;
  mode: string;
  enabled: number;
  config: string;
  cutoverState: string;
  observeStartedAt: number | null;
  legacyRuleRef: string | null;
  countsAsViolation: number;
  maxFalsePositiveRate: number;
  minReviewedMatches: number;
  enforceSignedOffBy: string | null;
  enforceSignedOffAt: number | null;
  createdAt: number;
  updatedAt: number;
}): AdminRule => ({
  ...row,
  kind: row.kind as RuleKind,
  mode: row.mode as RuleMode,
  enabled: row.enabled === 1,
  cutoverState: row.cutoverState as CutoverState,
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
