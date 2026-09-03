import { createContext, Script, type Context } from 'node:vm';
import { z } from 'zod';
import type { AutomodRule, CompiledPredicate, Predicate } from './types.js';

/**
 * How long one pattern may run against one message before it is abandoned
 * (plan ruling PR-11).
 *
 * A legitimate pattern completes in well under a microsecond — a direct
 * `exec` was measured at 0.05 microseconds — so this is four orders of
 * magnitude of headroom. Deliberately not operator-configurable: the only
 * use for raising it is to make a hanging pattern hang for longer.
 */
export const REGEX_TIMEOUT_MS = 25;

/** Flags that are safe on a regex reused for a rule's whole lifetime. */
const ALLOWED_FLAGS = ['i', 'm', 's', 'u'] as const;

/**
 * `g` and `y` are refused, and this is measured behaviour rather than
 * caution (plan ruling PR-13). Both keep `lastIndex` on the RegExp object
 * between calls, and this predicate compiles one RegExp and reuses it for
 * every message the rule ever sees. A probe on this Node: `/a/g` answered
 * `test('banana')` true (lastIndex 2), then true (lastIndex 4), then
 * `test('xyz')` false (lastIndex reset to 0). The same message would get
 * different answers depending on what was posted before it, which is a
 * moderation rule that is wrong roughly half the time and looks fine in
 * every test that evaluates one message.
 */
export const regexConfig = z
  .object({
    pattern: z.string().min(1).max(1_000),
    flags: z
      .string()
      .max(ALLOWED_FLAGS.length)
      .refine(
        (value) => [...value].every((flag) => (ALLOWED_FLAGS as readonly string[]).includes(flag)),
        {
          message:
            'only the i, m, s and u flags are allowed; g and y carry lastIndex between messages',
        },
      )
      .optional(),
  })
  .strict();

export type RegexConfig = z.infer<typeof regexConfig>;

/**
 * The regex predicate, with a hard per-evaluation timeout (spec section 3,
 * Slice 3; the gate is named in section 4).
 *
 * **Why `node:vm` is here, and what it is not doing.** It is an
 * *interruptible execution wrapper*, not a security sandbox. V8 cannot
 * abandon a runaway regex from ordinary JavaScript — there is no `RegExp`
 * timeout — but `vm`'s watchdog terminates execution inside a context, and a
 * probe on this Node confirmed it interrupts catastrophic backtracking that
 * would otherwise never return (it threw at 204 ms on a 200 ms budget,
 * against a pattern measured at 3052 ms for a 26-character input).
 *
 * The script inside the context is the fixed string below. The operator's
 * pattern reaches it as a `RegExp` object built by `new RegExp` in the
 * ordinary realm; `new RegExp` cannot execute arbitrary code, so no
 * operator-supplied *code* is ever evaluated. A reader who sees `node:vm`
 * will reasonably assume a sandbox, which is why this says otherwise.
 *
 * The alternative the spec also permits — a linear-time engine — means
 * `re2`, a native module that must compile on the deployment host. The
 * timeout costs no dependency (plan ruling PR-10).
 */
export const regexPredicate: Predicate<RegexConfig> = {
  kind: 'regex',
  config: regexConfig,
  compile(_rule: AutomodRule, config: RegexConfig): CompiledPredicate {
    // Throws on an invalid pattern, which `compileRule` turns into
    // `compile-failed` — inert and loud (ADR 0040 section 4), never a crash.
    const pattern = new RegExp(config.pattern, config.flags ?? '');

    // Context and Script are built once, here, not per message: that is what
    // keeps an evaluation at ~120 microseconds instead of paying for context
    // creation every time. A probe confirmed the timeout still fires when
    // both are reused, and that a context which has already timed out stays
    // usable for later messages.
    const context: Context = createContext({ pattern, input: '' });
    const script = new Script('pattern.exec(input)');

    return {
      evaluate(messageInput) {
        (context as { input: string }).input = messageInput.content;

        // A timeout throws, and that is deliberate (plan ruling PR-12):
        // `evaluateRule` catches it and the subscriber logs "the predicate
        // threw", naming the rule. Returning "no match" would be silent,
        // which is the ADR 0039 failure this project has walked into three
        // times — a rule that looks configured and quietly does nothing.
        const found = script.runInContext(context, {
          timeout: REGEX_TIMEOUT_MS,
        }) as RegExpExecArray | null;
        if (found === null) return undefined;

        const matched = found[0];
        return {
          // No categories on this predicate, so the kind is the category —
          // the convention `PredicateMatch.categoryId` documents.
          categoryId: 'regex',
          snippet: matched,
          trace: {
            kind: 'regex',
            // The configured pattern, not the text it matched (ruling R-8).
            // Slice 9's suppression for this predicate is "narrow the
            // pattern", and it needs to know which pattern.
            matchedOn: config.pattern,
            // The engine's own index, not indexOf on the matched text —
            // ruling R-9 records a shipped bug from exactly that shortcut,
            // where a repeated term produced a span over the wrong
            // occurrence.
            span: [found.index, found.index + matched.length],
            normalisations: ['zero-width stripped'],
            detail: {
              flags: config.flags ?? '',
              patternLength: config.pattern.length,
            },
          },
        };
      },
    };
  },
};
