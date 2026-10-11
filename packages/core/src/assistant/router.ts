/** Which half of the chain a run tries first (contracts §3, Slice 6 produces). */
export type ChainTier = 'standard' | 'light';

export interface RouterRules {
  readonly enabled: boolean;
  readonly maxChars: number;
  readonly fullModelKeywords: readonly string[];
  readonly greetingPatterns: readonly string[];
  readonly longThreadTurns: number;
  readonly escalateOnTool: boolean;
}

export interface RouteInput {
  /** Mentions already stripped. */
  readonly text: string;
  readonly hasAttachments: boolean;
  readonly hasQuoteOrReply: boolean;
  readonly earlierTurns: number;
}

/** Spec 6e defaults: on, 80 chars, 17 full-model keywords, 4-turn thread cap, escalate on. */
export const DEFAULT_ROUTER_RULES: RouterRules = {
  enabled: true,
  maxChars: 80,
  fullModelKeywords: [
    'remind',
    'schedule',
    'task',
    'ping',
    'search',
    'look up',
    'summar',
    'explain',
    'why',
    'how',
    'write',
    'story',
    'code',
    'plan',
    'compare',
    'translate',
    'fix',
  ],
  greetingPatterns: [
    'hi',
    'hello',
    'hey',
    'thanks',
    'thank you',
    'thx',
    'good morning',
    'good night',
  ],
  longThreadTurns: 4,
  escalateOnTool: true,
};

const isEmojiOnly = (text: string): boolean =>
  text.length > 0 && /^\p{Extended_Pictographic}[\p{Extended_Pictographic}\s]*$/u.test(text);

const isGreeting = (text: string, rules: RouterRules): boolean => {
  const clean = text
    .trim()
    .toLowerCase()
    .replace(/[.!?…\s]+$/g, '');
  if (isEmojiOnly(text.trim())) return true;
  return rules.greetingPatterns.some((pattern) => clean === pattern.toLowerCase());
};

/** Deterministic and free: no AI request is spent to classify. Reasons are a fixed vocabulary. */
export function routeRun(
  input: RouteInput,
  rules: RouterRules,
): { tier: ChainTier; reason: string } {
  if (!rules.enabled) return { tier: 'standard', reason: 'router-off' };
  if (input.hasAttachments) return { tier: 'standard', reason: 'has-attachments' };
  if (input.hasQuoteOrReply) return { tier: 'standard', reason: 'has-quote' };
  if (isGreeting(input.text, rules)) return { tier: 'light', reason: 'greeting' };
  if (input.text.length > rules.maxChars) return { tier: 'standard', reason: 'long-message' };
  const lowered = input.text.toLowerCase();
  if (rules.fullModelKeywords.some((keyword) => lowered.includes(keyword.toLowerCase()))) {
    return { tier: 'standard', reason: 'full-model-keyword' };
  }
  if (input.earlierTurns > rules.longThreadTurns) {
    return { tier: 'standard', reason: 'long-thread' };
  }
  return { tier: 'light', reason: 'short-and-simple' };
}

/** Light run: light entries first, then standard in order. Standard run: standard in order, then light. */
export function orderChainByTier<T extends { readonly tier: ChainTier }>(
  entries: readonly T[],
  tier: ChainTier,
): T[] {
  const first = tier === 'light' ? 'light' : 'standard';
  const second = tier === 'light' ? 'standard' : 'light';
  return [...entries.filter((e) => e.tier === first), ...entries.filter((e) => e.tier === second)];
}
