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

/** The verdict split for one rule — mirrors `OpsVerdictCounts`. */
export interface VerdictCounts {
  readonly falsePositive: number;
  readonly truePositive: number;
  readonly unclear: number;
}

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
  /** The verdict split for this rule — zeros when the rule has none. */
  readonly verdicts: VerdictCounts;
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
      'Enforces this rule for real. Its stage becomes enforcing and the bot starts acting on matches.';
  } else if (
    request.mode === 'observe' &&
    (current.cutoverState === 'not_started' || current.cutoverState === 'rolled_back')
  ) {
    const elapses = new Date(now + OBSERVE_FLOOR_DAYS * DAY_MS).toLocaleDateString();
    base = `Starts this rule's observe window now. The two-week floor elapses on ${elapses}.`;
  } else if (request.mode === 'test' && current.cutoverState === 'observing') {
    base =
      'Switches to test mode: the rule keeps matching and recording fixtures but stops deleting; its stage stays observing and its clock keeps running, so the window will elapse with a gap in its evidence.';
  } else if (request.mode !== undefined && current.cutoverState === 'cutover') {
    base =
      'Rolls this rule back from enforcement and withdraws its sign-off; it must observe again before it can enforce.';
  } else if (request.mode !== undefined) {
    base = `Changes mode from ${current.mode} to ${request.mode}; its stage stays ${CUTOVER_STAGE_LABEL[current.cutoverState]}.`;
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

/** A human verdict on a match, as `POST /api/automod/review/:eventId/verdict` records it (Slice 9). */
export type Verdict = 'false_positive' | 'true_positive' | 'unclear';

/**
 * One Bananasaurs match nobody has ruled on yet — mirror of
 * `OpsReviewableMatch` in `packages/core/src/ops/ports.ts`.
 */
export interface ReviewableMatch {
  readonly eventId: string;
  readonly ruleId: string;
  readonly memberId: string;
  readonly at: number;
  readonly matchedCategory: string;
  readonly matchedSnippet: string;
  readonly actionTaken: string;
  /** Raw JSON, rendered behind a `<details>`; `undefined` should not occur but is not trusted not to. */
  readonly trace: string | undefined;
  /** The fixture's whole message, when one was captured; `undefined` once `/forgetme` has removed it. */
  readonly fixtureContent: string | undefined;
  /** Live server identity; null when Discord no longer knows the id. */
  readonly member: { readonly username: string; readonly displayName: string } | null;
}

/** A native Discord AutoMod decision nobody has ruled on — mirror of `OpsNativeHit`. */
export interface NativeHit {
  readonly eventId: string;
  readonly ruleId: string;
  readonly memberId: string;
  readonly at: number;
  readonly matchedCategory: string;
  readonly matchedSnippet: string;
  readonly actionTaken: string;
  /** Live server identity; null when Discord no longer knows the id. */
  readonly member: { readonly username: string; readonly displayName: string } | null;
}

/** The `GET /api/automod/review` body. */
export interface ReviewQueue {
  readonly matches: readonly ReviewableMatch[];
  readonly nativeHits: readonly NativeHit[];
  readonly nativeBlocked: number;
  readonly verdicts: Record<string, VerdictCounts>;
}

/**
 * Kinds whose observe stream native AutoMod's three default rules filter
 * first (spec F3, PR-56): mention spam, spam content, and flagged words
 * overlap `mention_spam`, `rapid_spam`/`duplicate_message` and
 * `keyword_filter` respectively. Used to decide whether the F3.2 warning is
 * relevant to what is in view.
 */
export const NATIVE_OVERLAP_KINDS: readonly RuleKind[] = [
  'keyword_filter',
  'mention_spam',
  'rapid_spam',
  'duplicate_message',
];

/** What a one-click suppression narrows, as `POST /api/automod/rules/:ruleId/suppress` takes it. */
export type SuppressionKind =
  'allowlist_phrase' | 'invite_code' | 'link_domain' | 'channel_exemption';

/** The value a suppression should act on: the trace's `matchedOn` (the invite code, the host, the configured term — ADR 0041 R-8) when the trace carries one, else the snippet. */
export function suppressionPrefill(match: {
  readonly trace: string | undefined;
  readonly matchedSnippet: string;
}): string {
  if (match.trace !== undefined) {
    try {
      const parsed = JSON.parse(match.trace) as { matchedOn?: unknown };
      if (typeof parsed.matchedOn === 'string' && parsed.matchedOn.length > 0) {
        return parsed.matchedOn;
      }
    } catch {
      // A trace that is not JSON carries no `matchedOn` — fall through.
    }
  }
  return match.matchedSnippet;
}

/**
 * The one-click suppression appropriate to a predicate kind (spec Slice 9),
 * or `undefined` when the honest answer is "edit the configuration" — a
 * `regex` rule's pattern cannot be narrowed from a single match without
 * inventing what the narrower pattern should be (PR-55).
 */
export const suppressionFor = (
  kind: RuleKind,
):
  | { readonly kind: SuppressionKind; readonly label: string; readonly prefillFromSnippet: boolean }
  | undefined => {
  switch (kind) {
    case 'keyword_filter':
      return { kind: 'allowlist_phrase', label: 'Allow this phrase', prefillFromSnippet: true };
    case 'invite':
      return { kind: 'invite_code', label: 'Allow this invite code', prefillFromSnippet: true };
    case 'link_domain':
      return { kind: 'link_domain', label: 'Allow this domain', prefillFromSnippet: true };
    case 'caps':
    case 'emoji':
    case 'attachment_type':
    case 'mention_spam':
    case 'rapid_spam':
    case 'duplicate_message':
      return { kind: 'channel_exemption', label: 'Exempt a channel', prefillFromSnippet: false };
    case 'regex':
      return undefined;
  }
};

/* --------------------------------------------------------------------------
 * Plain-language renderings of the automod vocabulary: "cutover state"
 * and "(2 fp)" read like internals, not product. The raw
 * values stay visible in parentheses where the CLI uses the same word.
 * Labels and copy only; behaviour stays above.
 * ------------------------------------------------------------------------ */

export const RULE_KIND_LABEL: Record<RuleKind, string> = {
  keyword_filter: 'Keyword filter',
  regex: 'Pattern (regex)',
  invite: 'Invite links',
  link_domain: 'Link domains',
  caps: 'All caps',
  emoji: 'Emoji flood',
  attachment_type: 'Attachment types',
  mention_spam: 'Mention spam',
  rapid_spam: 'Rapid-fire spam',
  duplicate_message: 'Duplicate messages',
};

/**
 * Where a rule is on the path to enforcement. `cutover` is the server's word
 * for "crossed over to acting", so the dashboard says "enforcing" instead.
 */
export const CUTOVER_STAGE_LABEL: Record<CutoverState, string> = {
  not_started: 'not started',
  observing: 'observing',
  ready: 'ready to enforce',
  cutover: 'enforcing',
  rolled_back: 'rolled back',
};

export const RULE_MODE_LABEL: Record<RuleMode, string> = {
  test: 'Test',
  observe: 'Observe',
  enforce: 'Enforce',
};

/** One sentence per mode, shared by the rules table and the detail radios. */
export const RULE_MODE_HELP: Record<RuleMode, string> = {
  test: 'matches and records, but deletes nothing. Use it while tuning.',
  observe:
    'records matches for a person to review. Enforcement can only be offered after the observe window.',
  enforce: 'acts on matches for real.',
};

/** HelpTip body for the Stage / cutover column. */
export const CUTOVER_STAGE_HELP =
  'Where the rule sits on the path from watching to acting: not started, observing (collecting matches without acting), ready to enforce, enforcing. Rolled back means it enforced before and was withdrawn; it must observe again before it can enforce.';

/** HelpTip body for the Observed column. */
export const OBSERVED_HELP =
  'Whole days since the observe window started. Enforcement cannot be offered before 14 days.';

/** HelpTip body for the Reviewed column. */
export const REVIEWED_HELP =
  'Matches a person has ruled on. False positives are messages the rule caught but should not have; too many block enforcement.';

/**
 * A starting configuration per kind, grounded in each predicate's Zod schema
 * (`packages/core/src/automod/predicates/`). Kinds whose schema is empty say
 * so instead of inventing fields.
 */
export const RULE_CONFIG_EXAMPLE: Record<
  RuleKind,
  { readonly json: string; readonly note: string }
> = {
  keyword_filter: {
    json: '{}',
    note: 'This kind has no configuration of its own; the seeded word list drives it.',
  },
  invite: {
    json: '{}',
    note: 'This kind has no configuration; allowlisted invite codes are managed on the rule page.',
  },
  regex: {
    json: '{\n  "pattern": "free\\\\s+nitro",\n  "flags": "i"\n}',
    note: 'pattern is the regular expression; flags may only use i, m, s and u.',
  },
  link_domain: {
    json: '{\n  "mode": "deny"\n}',
    note: 'deny fires on listed domains; allow fires on every domain that is not listed. The lists themselves are managed on the rule page.',
  },
  caps: {
    json: '{\n  "minLength": 8,\n  "maxRatio": 0.7\n}',
    note: 'Fires when a message at least minLength characters long has a higher capital-letter ratio than maxRatio.',
  },
  emoji: {
    json: '{\n  "maxCount": 10\n}',
    note: 'Fires when a message carries more emoji than maxCount.',
  },
  attachment_type: {
    json: '{\n  "blockedExtensions": ["exe", "scr"]\n}',
    note: 'Needs at least one blocked extension or content type (blockedContentTypes).',
  },
  mention_spam: {
    json: '{\n  "maxMentions": 5,\n  "countEveryoneAs": 5\n}',
    note: 'Fires above maxMentions; one @everyone or @here counts as countEveryoneAs mentions.',
  },
  rapid_spam: {
    json: '{\n  "maxMessages": 5,\n  "windowMs": 10000\n}',
    note: 'Fires when one member sends more than maxMessages messages inside windowMs milliseconds.',
  },
  duplicate_message: {
    json: '{\n  "maxRepeats": 3,\n  "windowMs": 60000,\n  "minLength": 10\n}',
    note: 'Fires when the same text repeats more than maxRepeats times inside windowMs milliseconds; messages shorter than minLength are ignored.',
  },
};
