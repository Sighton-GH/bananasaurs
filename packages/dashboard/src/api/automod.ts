/**
 * The dashboard's mirror of the automod API shapes (Slice 8).
 *
 * `packages/dashboard` may not import server packages (ADR 0014, ADR 0043 —
 * the dashboard builds to static assets), so these are re-declared by hand
 * from `OpsAutomodRuleSummary` / `OpsAutomodRuleDetail` in
 * `packages/core/src/ops/ports.ts` and `DryRunReport` in
 * `packages/core/src/automod/dry-run.ts`. If a route test changes a server
 * shape, update the mirror here and the page that reads it.
 */

export type RuleKind =
  | 'keyword_filter'
  | 'regex'
  | 'invite'
  | 'link_domain'
  | 'caps'
  | 'emoji'
  | 'attachment_type'
  | 'mention_spam'
  | 'rapid_spam'
  | 'duplicate_message';

export const RULE_KINDS: readonly RuleKind[] = [
  'keyword_filter',
  'regex',
  'invite',
  'link_domain',
  'mention_spam',
  'rapid_spam',
  'duplicate_message',
  'caps',
  'attachment_type',
  'emoji',
];

export type RuleMode = 'test' | 'observe' | 'enforce';

export type CutoverState = 'not_started' | 'observing' | 'ready' | 'cutover' | 'rolled_back';

/** Every `AdminRule` field plus the two counts the cutover board reads. */
export interface RuleSummary {
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
  readonly matchCount: number;
  readonly reviewedCount: number;
}

export interface RuleExemption {
  readonly exemptType: 'role' | 'channel';
  readonly exemptId: string;
}

/** The `GET /api/automod/rules/:ruleId` body: the summary row with the raw config parsed beside it. */
export interface RuleDetail extends RuleSummary {
  readonly configObject: Record<string, unknown>;
  readonly exemptions: readonly RuleExemption[];
  readonly terms: readonly { readonly text: string; readonly categoryId: string }[];
  readonly allowlist: readonly string[];
  readonly inviteAllowlist: readonly { readonly code: string; readonly label: string }[];
  readonly linkDomains: readonly { readonly domain: string; readonly listType: 'allow' | 'deny' }[];
  readonly eligibility:
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly refusal: { readonly reason: string; readonly [k: string]: unknown };
      };
}

export interface DryRunFixtureResult {
  readonly fixtureId: string;
  readonly label: 'should_match' | 'should_not_match' | 'unlabelled';
  readonly matched: boolean;
  readonly match: unknown;
  readonly agreement: 'agreed' | 'disagreed' | 'unlabelled';
  readonly outcome: 'ok' | 'threw';
}

/** Mirrors `DryRunReport` in `packages/core/src/automod/dry-run.ts` field by field. */
export interface DryRunReport {
  readonly ruleId: string;
  readonly kind: string;
  readonly usable: boolean;
  readonly failure: { readonly reason: string; readonly detail: string } | undefined;
  readonly threw: number;
  readonly corpusSize: number;
  readonly total: number;
  readonly matched: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly results: readonly DryRunFixtureResult[];
}

/** ADR 0042's observe floor: enforcement is never offerable before this many days. */
export const OBSERVE_FLOOR_DAYS = 14;

const DAY_MS = 86_400_000;

/** Whole days since the observe clock started, or `null` when it never did. */
export const daysObserved = (observeStartedAt: number | null, now: number): number | null =>
  observeStartedAt === null ? null : Math.floor((now - observeStartedAt) / DAY_MS);
