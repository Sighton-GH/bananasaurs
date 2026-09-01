# 0039 — Keyword filter collapse thresholds derive from the configured word list

Status: accepted
Date: 2026-09-01
Depends on ADR 0035 (automod rule engine foundation — the matcher this ADR
fixes), ADR 0038 (recorded the bug's discovery in passing while closing out
Slice 0).
Constrained by `CLAUDE.md` rule 2 (guild scope — unaffected here, but the fix
must not weaken it), the release-2 false-positive gate (`REVIEW.md` §E /
`docs/STATE.md` "still open" §7), and the "no new dependency" rule (this uses
`obscenity` APIs already installed).

## Context

`packages/core/src/automod/matcher.ts`'s `buildMatcher` compiles each
configured term with `parseRawPattern(term.text)` and matches using
`englishRecommendedTransformers`. Those transformers include
`collapseDuplicatesTransformer`, which runs against the **matched input text**
only — never against the pattern — with `defaultThreshold: 1` and, per
`obscenity`'s own source (`node_modules/obscenity/dist/preset/english.js`), six
hand-picked exceptions at threshold 2:

```js
customThresholds: new Map([
  ['b', 2], // a_bb_o
  ['e', 2], // ab_ee_d
  ['o', 2], // b_oo_nga
  ['l', 2], // fe_ll_atio
  ['s', 2], // a_ss_
  ['g', 2], // ni_gg_er
]),
```

Each entry exists because a specific word in `obscenity`'s **bundled**
dataset needs it — the comments name the word. The thresholds were hand-tuned
to that word list and were never meant to cover arbitrary user-supplied terms.
ADR 0035 seeded Bananasaurs' word list from `englishDataset`, so those seeded
words keep working. The club's own added terms are the case nobody tuned for.

**The bug.** A configured term containing a doubled letter outside those six
never matches, at any stretch, including the exact literal spelling. Input
`"you are a spammer"` is transformed (collapsing the non-thresholded `m`) to
`"you are a spamer"` before matching, but the compiled pattern still requires
the literal substring `"spammer"` — so it never matches, not even the
unstretched case. Confirmed directly against the library, not inferred:

```
CURRENT (broken):                      6/10 of a 10-case suite
    MISSED  "spammer"   in "you are a spammer"
    MISSED  "spammer"   in "you are a spaaaammmmer"
    MISSED  "forbidden" in "that is forbidden here"
    MISSED  "bitter"    in "so bitter today"
```

**Blast radius.** Any configured term with a doubled letter outside
`{b, e, o, l, s, g}` — `spammer`, `forbidden`, `bitter`, and any future
club-added term with the same shape — sits in the database looking
configured and silently never fires, in any mode (`test`, `observe`,
`enforce`). This is worse than an ordinary miss because Release 2's gate
(`docs/STATE.md` §7) measures the false-positive *rate among matches*: a rule
that never matches reports a perfectly clean 0% false-positive rate, and "no
matches" is indistinguishable on the review screen from "no misses." A rule
could clear the gate and go to `enforce` while never having actually
evaluated a single real hit.

**Consequence already banked.** `docs/STATE.md` recorded this bug on
discovery (2026-09-01, closing out Slice 0) as "found, deliberately not fixed
there" — deferred to its own ADR per `CLAUDE.md`'s working-style rule that a
change touching matcher semantics for every existing rule needs one. This ADR
is that fix.

## Decision

### Derive the collapse thresholds from the configured word list (Fix A)

Any ASCII letter that appears doubled in any configured term for a guild's
rule gets a custom threshold of 2, unioned with `obscenity`'s existing six.
This is exactly what `obscenity` did by hand for its own dataset, automated
for arbitrary user-supplied terms:

```ts
const OBSCENITY_BUILTIN_THRESHOLDS: ReadonlyMap<string, number> = new Map([
  ['b', 2], ['e', 2], ['o', 2], ['l', 2], ['s', 2], ['g', 2],
]);

function collapseThresholdsFor(terms: readonly string[]): Map<string, number> {
  const thresholds = new Map(OBSCENITY_BUILTIN_THRESHOLDS);
  for (const term of terms) {
    const lower = term.toLowerCase();
    for (let i = 1; i < lower.length; i++) {
      const ch = lower[i]!;
      if (ch === lower[i - 1] && ch >= 'a' && ch <= 'z') {
        thresholds.set(ch, 2);
      }
    }
  }
  return thresholds;
}
```

`buildMatcher` then spells out the blacklist transformer pipeline explicitly
— `resolveConfusablesTransformer()`, `resolveLeetSpeakTransformer()`,
`toAsciiLowerCaseTransformer()`, then `collapseDuplicatesTransformer({
defaultThreshold: 1, customThresholds: collapseThresholdsFor(termTexts) })` —
in the same order `englishRecommendedBlacklistMatcherTransformers` uses,
because collapse must run after case-folding and confusable/leetspeak
resolution, on the same character stream those produce. The whitelist side
keeps `englishRecommendedTransformers.whitelistMatcherTransformers` verbatim
(see "The allowlist side needs no change," below).

### Fix B (pre-collapsing the pattern) is rejected

The other candidate fix runs the term itself through the collapse transformer
at compile time, so the pattern becomes the already-collapsed form (`spammer`
→ `spamer`). Tested against the same 10-case suite:

```
FIX B (pre-collapse the pattern):       9/10
    FALSE+  "spamer" wrongly matches term "spammer"
```

Fix B trades a false negative for a false positive: the pattern now matches
the collapsed spelling, so an unrelated word that merely happens to collapse
to the same form matches a term nobody configured. Release 2's entire gate
exists to keep the false-positive rate near zero; trading a silent miss for a
false hit is a worse defect, not a smaller one, in exactly the dimension this
release is being measured on. Fix A is the one implemented.

### Scope of `doubledLettersIn`: ASCII `a`–`z` only, not digits, punctuation, or non-ASCII

The threshold map is consumed by `collapseDuplicatesTransformer` **after**
`resolveConfusablesTransformer`, `resolveLeetSpeakTransformer`, and
`toAsciiLowerCaseTransformer` have already run on the input stream — so by
the time collapsing happens, non-ASCII confusables and leetspeak digit
substitutions have already been folded into their ASCII-letter equivalents.
A threshold keyed on a raw non-ASCII character from a term would never be
looked up against that transformed stream, because the character it was
keyed on no longer appears in it.

Digits and punctuation are excluded on a different, narrower ground: the
problem this ADR fixes is evasion-by-stretching of an ordinary English word
(`spammer`, `forbidden`), which is a letters-only phenomenon in practice.
Extending the same derivation to digits or punctuation (a term like `"1100"`
or `"!!"`) is a real but separate question — those characters interact with
leetspeak resolution and confusables differently, and speculatively handling
them risks quietly relaxing collapsing for characters where no configured
term actually needs it, which is exactly the trade this ADR is trying to keep
small (see "Consequences," below). If a club-configured term with a doubled
digit or punctuation mark turns out to need this, it is a small, symmetric
follow-up to `collapseThresholdsFor`, not a reason to block this fix.

### The allowlist side needs no change

`englishRecommendedTransformers.whitelistMatcherTransformers` uses
`collapseDuplicatesTransformer({ defaultThreshold: Number.POSITIVE_INFINITY,
customThresholds: new Map([[' ', 1]]) })` — an infinite default threshold
means no letter is ever collapsed on the whitelist side at all (only repeated
spaces collapse to one). An allowlisted term with a doubled letter therefore
already matches its literal spelling with no over- or under-collapsing; the
bug this ADR fixes does not exist on that side, because the whitelist preset
was never symmetric with the blacklist preset in the first place. No change
needed; recorded here so a future reader does not have to re-derive it.

### Matcher cache: already documented as stale-on-edit, now stale in one more way

`packages/core/src/automod/subscriber.ts` keeps a module-level
`matcherCache` keyed by `${guildId}:${ruleId}`, built once per key and never
invalidated — already called out in its own doc comment as a known gap ("a
rule whose word list changes after its matcher has been built keeps matching
on the stale list until the process restarts"). This ADR does not change that
behavior or close that gap; it only widens what "stale" means for an entry
already in the cache, since the derived thresholds are now also a function of
the word list at build time. The existing comment is extended (not replaced)
to say so, so a future reader sees both staleness modes in one place instead
of rediscovering the second one the way this ADR's author had to.

## Consequences

- **Collapsing thresholds are now word-list-dependent, per rule.** Adding a
  term with a previously-unseen doubled letter (say, a term containing `zz`)
  slightly *relaxes* collapsing for `z` for every term in that rule, not just
  the new one — because `collapseDuplicatesTransformer`'s thresholds are
  global to the matcher instance, not per-pattern. Stated honestly: this
  trade is small in practice (English words rarely double `z`, `q`, `x`, `j`,
  or `k`, and a letter's threshold only ever moves from 1 to 2 — from "no
  extra runs pass" to "runs of two pass," never further), but it is real, and
  it means two rules with different word lists can treat the same stretched
  input differently. This is judged acceptable because the alternative — a
  term that silently never fires — is the worse failure by the standard this
  release is held to.
- **Observe-window data already collected for an affected rule is worthless
  and must be discarded, not merely re-baselined.** Before this fix, a rule
  containing a term like `spammer` or `forbidden` was not evaluating those
  terms at all — every message that should have matched silently passed
  through unmatched. Any false-positive percentage computed from that
  window describes a rule that was not doing what its configuration said. It
  is not a slightly-biased sample; it is a measurement of the wrong rule.
  Any such rule's observe-window clock restarts from this fix landing, not
  from whenever it was originally put into `observe`.
- No schema change, no new dependency, no provider call, no new outbound
  destination. This is a pure change to `packages/core/src/automod/matcher.ts`
  plus one doc-comment extension in `subscriber.ts`.
- `packages/core` still does not import `@bananasaurs/storage` (ADR 0014);
  nothing about this fix touches that boundary.
- **Numbering knock-on.** This ADR takes 0039, which `docs/STATE.md` and
  `docs/superpowers/specs/2026-09-01-release-2-completion-and-release-3-roadmap-design.md`
  §9 had reserved for Slice 1's predicate-interface ADR. That table shifts by
  one: Slice 1 is now 0040, and every entry after it in the same table shifts
  accordingly (0041→0042, and so on through the table's last entry).
