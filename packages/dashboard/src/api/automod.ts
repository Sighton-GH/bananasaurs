/**
 * The dashboard's mirror of the automod API shapes (Slice 8).
 *
 * `packages/dashboard` may not import server packages (ADR 0014, ADR 0043 —
 * the dashboard builds to static assets), so these are re-declared by hand
 * from the JSON `packages/http/src/routes/automod.ts` and
 * `automod-state.ts` send. If a route test changes a server shape, update the
 * mirror here and the page that reads it.
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

/** The verdict split for one rule — mirrors `OpsVerdictCounts`. */
export interface VerdictCounts {
  readonly falsePositive: number;
  readonly truePositive: number;
  readonly unclear: number;
}

/** One rule as `GET /api/automod/rules` sends it, with its match and flag counts. */
export interface RuleSummary {
  readonly ruleId: string;
  readonly kind: RuleKind;
  readonly name: string;
  readonly enabled: boolean;
  readonly config: string;
  readonly countsAsViolation: boolean;
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
}

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
 * Plain-language renderings of the automod vocabulary. Labels and copy
 * only; behaviour stays above.
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

/** HelpTip body for the Reviewed column. */
export const REVIEWED_HELP =
  'Matches you have flagged as correct or false positive. Flags help you tune a rule.';

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

/** ADR 0121: the guild-wide automod switch. */
export type AutomodState = 'off' | 'watch' | 'on';
export const AUTOMOD_STATES: readonly AutomodState[] = ['off', 'watch', 'on'];
export const AUTOMOD_STATE_LABEL: Record<AutomodState, string> = {
  off: 'Off',
  watch: 'Watch',
  on: 'On',
};
export const AUTOMOD_STATE_MEANING: Record<AutomodState, string> = {
  off: 'Automod is off. It does not check messages and records nothing.',
  watch:
    'Automod records matches for you to review and flag. It deletes nothing and touches no one.',
  on: 'Automod deletes messages that match an enabled rule and escalates repeat offenders.',
};
export interface AutomodStateView {
  readonly state: AutomodState;
  readonly dryRun: boolean;
  readonly killswitch: boolean;
  readonly enabledRules: readonly { readonly ruleId: string; readonly name: string }[];
}
