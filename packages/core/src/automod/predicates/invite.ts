import { z } from 'zod';
import type { AutomodRule, CompiledPredicate, Predicate } from './types.js';

/**
 * Anything invite-shaped: `discord.gg/CODE`, `discord.com/invite/CODE`, and
 * the legacy `discordapp.com` host, with or without a scheme or `www.`.
 *
 * Written to be linear — no nested quantifier, no alternation inside a
 * repetition — because this runs on every message and, unlike the `regex`
 * predicate, it is not behind the `node:vm` timeout. A catastrophic pattern
 * here would be this project's own doing rather than an operator's.
 *
 * `[\w-]{2,64}` is deliberately loose about what a code looks like: Discord
 * vanity URLs allow hyphens, and being generous here costs a false positive
 * that the allowlist resolves in one click, where being strict costs a
 * missed invite. That trade is the spec's, not this file's.
 */
const INVITE =
  /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([\w-]{2,64})/gi;

export const inviteConfig = z.object({}).strict();
export type InviteConfig = z.infer<typeof inviteConfig>;

/**
 * `invite` — pattern matching only, no resolution (spec section 3, Slice 3,
 * and CLAUDE.md rule 8: resolving a code to a guild id is an outbound API
 * call, and the owner chose not to authorise one).
 *
 * **The known failure mode, designed for rather than hoped away.** Pattern
 * matching cannot tell which server a code points at, so when a partner
 * rotates their invite their new code is not on the list and this fires on a
 * legitimate message. It surfaces as exactly one false positive in the
 * Slice 9 review queue, whose suppression for this predicate is "add this
 * code to the allowlist" — one click, and the loop closes.
 */
export const invitePredicate: Predicate<InviteConfig> = {
  kind: 'invite',
  config: inviteConfig,
  compile(rule: AutomodRule): CompiledPredicate {
    // Lower-cased once at compile time, not per message: the allowlist is
    // per-rule and the message is not.
    const allowed = new Set(rule.inviteAllowlist.map((entry) => entry.code.toLowerCase()));

    return {
      evaluate(input) {
        // `matchAll` rather than a shared `exec` loop: INVITE carries the `g`
        // flag, and a module-level regex with `g` reused across calls keeps
        // `lastIndex` between them — the hazard plan ruling PR-13 refuses in
        // the `regex` predicate's own config. `matchAll` requires `g` and
        // does not leak `lastIndex` back to the pattern, which is why it is
        // safe here where a bare `.test()` would not be.
        for (const found of input.content.matchAll(INVITE)) {
          const code = found[1];
          if (code === undefined) continue;
          // Every invite in the message is checked, not just the first: a
          // message pairing the club's own invite with a spam one is the
          // case that matters, and stopping at the first would clear it.
          if (allowed.has(code.toLowerCase())) continue;

          return {
            categoryId: 'invite',
            snippet: found[0],
            trace: {
              kind: 'invite',
              // The code, which is what Slice 9's one-click suppression adds
              // to the allowlist (ruling R-8: matchedOn is the thing a
              // reviewer acts on).
              matchedOn: code,
              span: [found.index, found.index + found[0].length],
              normalisations: ['zero-width stripped'],
              detail: { code, allowlistSize: rule.inviteAllowlist.length },
            },
          };
        }
        return undefined;
      },
    };
  },
};
