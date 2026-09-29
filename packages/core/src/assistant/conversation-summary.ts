import { z } from 'zod';

/**
 * The validated shape of a conversation summary (ADR 0091 decisions 1–2).
 *
 * Model output is untrusted (hard rule 3): it is parsed with this schema, and
 * every string is marker-neutralised and redacted before storage. Every string
 * is capped so no single summary can grow the row without bound, and the whole
 * object renders to at most 150 words via `renderSummary`.
 */
export const conversationSummarySchema = z
  .object({
    topic: z.string().trim().min(1).max(200),
    facts: z
      .array(
        z
          .object({
            text: z.string().trim().min(1).max(300),
            from: z.enum(['member', 'club-doc', 'archive']),
          })
          .strict(),
      )
      .max(10),
    /** What the bot itself said, kept apart so a guess never hardens into a fact. */
    botClaims: z.array(z.string().trim().min(1).max(300)).max(5),
    openQuestions: z.array(z.string().trim().min(1).max(300)).max(5),
    commitments: z
      .array(
        z
          .object({
            who: z.string().trim().min(1).max(80),
            what: z.string().trim().min(1).max(200),
            when: z.string().trim().min(1).max(80).optional(),
          })
          .strict(),
      )
      .max(5),
    participants: z.array(z.string().trim().min(1).max(80)).max(10),
  })
  .strict();

export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

/**
 * Applies `clean` to every free string in the summary. The daemon passes
 * redaction plus `neutraliseMarkers`, so this module stays free of daemon
 * imports — core never decides what "clean" means, it just reaches every
 * string. The `from` enum is a fixed vocabulary, not a free string, and is
 * left alone.
 */
export const cleanSummary = (
  summary: ConversationSummary,
  clean: (s: string) => string,
): ConversationSummary => ({
  topic: clean(summary.topic),
  facts: summary.facts.map((fact) => ({ text: clean(fact.text), from: fact.from })),
  botClaims: summary.botClaims.map(clean),
  openQuestions: summary.openQuestions.map(clean),
  commitments: summary.commitments.map((c) => ({
    who: clean(c.who),
    what: clean(c.what),
    ...(c.when === undefined ? {} : { when: clean(c.when) }),
  })),
  participants: summary.participants.map(clean),
});

const FROM_LABEL = {
  member: 'member',
  'club-doc': 'club doc',
  archive: 'archive',
} as const;

const MAX_WORDS = 150;

const countWords = (text: string): number => text.split(/\s+/).filter((w) => w.length > 0).length;

/**
 * Short plain text, most durable part first. Empty parts are omitted. Hard-cap
 * of 150 words: parts are dropped from the end first, then the last kept part
 * is truncated at a word boundary with `…`.
 */
export const renderSummary = (summary: ConversationSummary): string => {
  const parts: string[] = [`Topic: ${summary.topic}`];
  if (summary.facts.length > 0) {
    parts.push(
      `Facts: ${summary.facts.map((f) => `${f.text} (${FROM_LABEL[f.from]})`).join('; ')}`,
    );
  }
  if (summary.botClaims.length > 0) {
    parts.push(`The bot said earlier (not confirmed): ${summary.botClaims.join('; ')}`);
  }
  if (summary.openQuestions.length > 0) {
    parts.push(`Open questions: ${summary.openQuestions.join('; ')}`);
  }
  if (summary.commitments.length > 0) {
    parts.push(
      `Commitments: ${summary.commitments
        .map((c) => `${c.who} — ${c.what}${c.when === undefined ? '' : ` (${c.when})`}`)
        .join('; ')}`,
    );
  }
  if (summary.participants.length > 0) {
    parts.push(`People: ${summary.participants.join(', ')}`);
  }

  while (parts.length > 1 && countWords(parts.join('\n')) > MAX_WORDS) {
    parts.pop();
  }
  const joined = parts.join('\n');
  if (countWords(joined) <= MAX_WORDS) return joined;

  const head = parts.slice(0, -1).join('\n');
  const headWords = head === '' ? 0 : countWords(head);
  const budget = MAX_WORDS - headWords;
  const lastWords = (parts[parts.length - 1] ?? '').split(/\s+/).filter((w) => w.length > 0);
  const kept = lastWords.slice(0, Math.max(1, budget)).join(' ') + '…';
  return head === '' ? kept : `${head}\n${kept}`;
};

/**
 * Parses untrusted model output: strips a single surrounding ```json fence if
 * present, `JSON.parse` in try/catch, validates against the schema. Returns
 * `undefined` on any failure — a failed parse writes nothing (ADR 0091).
 */
export const parseSummaryJson = (text: string): ConversationSummary | undefined => {
  let body = text.trim();
  if (body.startsWith('```') && body.endsWith('```')) {
    const lines = body.split('\n');
    lines.shift();
    lines.pop();
    body = lines.join('\n').trim();
    if (body === '') return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const result = conversationSummarySchema.safeParse(parsed);
  return result.success ? result.data : undefined;
};
