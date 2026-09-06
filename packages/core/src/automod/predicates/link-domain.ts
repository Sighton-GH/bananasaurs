import { z } from 'zod';
import { truncateDetailString } from '../trace.js';
import type { AutomodRule, CompiledPredicate, Predicate } from './types.js';

/**
 * URL-shaped text. Linear by construction — a character class with a single
 * quantifier, no nesting — because this runs on every message outside the
 * `regex` predicate's timeout.
 *
 * Scheme-ful URLs and bare `www.` hosts only. A bare `example.com` in prose
 * is deliberately not a link: Discord does not linkify it either, and
 * treating every dotted word as a URL is a false-positive machine in a
 * predicate whose whole job is precision.
 */
const URL_LIKE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

/**
 * Punctuation a sentence puts after a URL rather than inside it.
 *
 * Without this, `'blocked at https://example.com.'` extracts
 * `https://example.com.` and `new URL` reports the hostname `example.com.`
 * — which matches neither `example.com` (not equal) nor `.example.com` (wrong
 * suffix), so a denied domain quoted at the end of a sentence slips through.
 * A false negative rather than a false positive, and therefore the safe
 * direction, but a silent one: nothing about the output would tell an
 * operator their deny list had been bypassed by a full stop.
 *
 * Trailing `)` is included because a URL in parentheses is far more common in
 * prose than a URL genuinely ending in one.
 */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

export const linkDomainConfig = z
  .object({
    /**
     * `deny` fires on a link whose host is on the deny list. `allow` fires on
     * a link whose host is on neither list — a whitelist for a locked-down
     * channel. Explicit rather than inferred from which rows exist, because
     * inferring it from an empty list would be ambiguous about which
     * direction "empty" means: deleting the last **deny** row would silently
     * turn the rule into a no-op (never matches), but deleting the last
     * **allow** row does the opposite — it makes the rule match every link,
     * since "on neither list" is trivially true of everything once the allow
     * list is empty. `compileRule` (`registry.ts`) closes both directions by
     * refusing to compile a `link_domain` rule with no row on its configured
     * `mode` at all (CRITICAL-2, review of Slices 3+5), rather than this
     * predicate silently doing either thing.
     */
    mode: z.enum(['allow', 'deny']),
  })
  .strict();

export type LinkDomainConfig = z.infer<typeof linkDomainConfig>;

/**
 * Label-wise suffix match (plan ruling PR-15): `example.com` matches
 * `example.com` and `gist.example.com`, but not `notexample.com`.
 *
 * Comparing labels rather than raw strings is the whole point — a
 * `host.endsWith(entry)` check says true for `notexample.com`, which is a
 * domain someone else owns.
 */
const hostMatches = (host: string, entry: string): boolean => {
  if (host === entry) return true;
  return host.endsWith(`.${entry}`);
};

/**
 * `link_domain` — matches a message's links against a per-rule allow or deny
 * list, by label-wise domain suffix (spec section 3, Slice 3; plan ruling
 * PR-15). No fetching, no DNS, no resolution: same reasoning as `invite`
 * (CLAUDE.md rule 8) — this is local pattern matching against configured
 * lists, nothing more.
 */
export const linkDomainPredicate: Predicate<LinkDomainConfig> = {
  kind: 'link_domain',
  config: linkDomainConfig,
  compile(rule: AutomodRule, config: LinkDomainConfig): CompiledPredicate {
    const listed = rule.linkDomains
      .filter((entry) => entry.listType === config.mode)
      .map((entry) => entry.domain.toLowerCase());

    return {
      evaluate(input) {
        for (const found of input.content.matchAll(URL_LIKE)) {
          // Trailing sentence punctuation is not part of the URL. Stripped
          // before parsing, because `new URL` keeps it in the hostname and a
          // trailing dot makes every list comparison below silently miss.
          const text = found[0].replace(TRAILING_PUNCTUATION, '');
          if (text === '') continue;
          let host: string;
          try {
            // `new URL` does the normalisation this predicate would
            // otherwise get wrong by hand: it lower-cases the host and
            // strips the port and any userinfo. Verified on this Node:
            // 'https://user:pw@example.com:8443/x' -> 'example.com'.
            // The trailing dot is stripped a second time, on the host: a
            // fully-qualified `https://example.com./x` is legal and `new URL`
            // preserves the root label, which would defeat the comparison
            // below just as sentence punctuation would.
            host = new URL(text.startsWith('www.') ? `https://${text}` : text).hostname.replace(
              /\.$/,
              '',
            );
          } catch {
            // Not a URL after all. A message is not malformed for containing
            // 'https://' in prose, so this is a skip, not an error.
            continue;
          }
          const onList = listed.some((entry) => hostMatches(host, entry));
          // deny: fires when the host IS listed. allow: fires when it is not.
          if (config.mode === 'deny' ? !onList : onList) continue;

          return {
            categoryId: 'link_domain',
            snippet: text,
            trace: {
              kind: 'link_domain',
              // The host, which is what an operator adds to a list — not the
              // whole URL, which would never be a list entry (ruling R-8).
              matchedOn: host,
              span: [found.index, found.index + text.length],
              normalisations: ['zero-width stripped'],
              // `host` is member-controlled — in `allow` mode any host
              // matches, so a member picks the value — and hostnames run to
              // 253 characters against `detail`'s 120-character cap
              // (IMPORTANT-3). Truncated here, deliberately, rather than
              // relying on `serialiseTrace`'s truncation to salvage it.
              detail: {
                host: truncateDetailString(host),
                mode: config.mode,
                listSize: listed.length,
              },
            },
          };
        }
        return undefined;
      },
    };
  },
};
