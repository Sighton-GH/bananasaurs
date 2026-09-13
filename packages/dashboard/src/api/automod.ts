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

export interface ModeRequest {
  readonly mode?: RuleMode;
  readonly enabled?: boolean;
}

/**
 * The `ConfirmDialog` scope for a mode change, computed client-side from the
 * current cutover state and the request (PR-48). The sentence is chosen by
 * `mode` when one is requested, and by `enabled` only when no `mode` is —
 * the server's precedence: `mode` drives the state machine, `enabled` alone
 * never moves it. When both are requested, a second sentence covers `enabled`.
 */
export const modeScopeSentence = (
  current: {
    readonly cutoverState: CutoverState;
    readonly mode: RuleMode;
    readonly enabled: boolean;
  },
  request: ModeRequest,
  now: number,
): string => {
  let base: string;
  if (request.mode === 'enforce') {
    base =
      'Enforces this rule for real. Its cutover state becomes cutover and the bot starts acting on matches.';
  } else if (
    request.mode === 'observe' &&
    (current.cutoverState === 'not_started' || current.cutoverState === 'rolled_back')
  ) {
    const elapses = new Date(now + OBSERVE_FLOOR_DAYS * DAY_MS).toLocaleDateString();
    base = `Starts this rule's observe window now. The two-week floor elapses on ${elapses}.`;
  } else if (request.mode === 'test' && current.cutoverState === 'observing') {
    base =
      'Switches to test mode: the rule keeps matching and recording fixtures but stops deleting; its cutover state stays observing and its clock keeps running, so the window will elapse with a gap in its evidence.';
  } else if (request.mode !== undefined && current.cutoverState === 'cutover') {
    base =
      'Rolls this rule back from enforcement and withdraws its sign-off; it must observe again before it can enforce.';
  } else if (request.mode !== undefined) {
    base = `Changes mode from ${current.mode} to ${request.mode}; cutover state stays ${current.cutoverState}.`;
  } else if (request.enabled === false) {
    return 'Disables the rule. Its cutover state and clock are unchanged.';
  } else {
    return `Enables the rule in its current mode, ${current.mode}.`;
  }
  if (request.enabled === false) {
    if (request.mode === 'observe') {
      return `${base} It also disables the rule, so the observe window will run with the rule matching nothing — the window's evidence will be empty.`;
    }
    return `${base} It also disables the rule, so nothing will match while it is disabled.`;
  }
  if (request.enabled === true) {
    return `${base} It also enables the rule.`;
  }
  return base;
};

/** Whole days since the observe clock started, or `null` when it never did. */
export const daysObserved = (observeStartedAt: number | null, now: number): number | null =>
  observeStartedAt === null ? null : Math.floor((now - observeStartedAt) / DAY_MS);
