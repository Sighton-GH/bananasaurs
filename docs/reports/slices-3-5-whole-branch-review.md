# Whole-branch review — Release 2, Slices 3+5 (nine tasks, `f6bddff..HEAD`)

**Verdict: SHIP-WITH-FIXES.**

2 CRITICAL · 8 IMPORTANT · 7 MINOR.

Nothing here is a per-task correctness defect — the individual reviews did their
job. Every finding below is either an interaction between two tasks, or output
that reads as reassuring to a human when it is not, which is what this pass was
sequenced to find.

## A reachability fact that applies to every finding

Release 2 has **no code path that creates a rule of any of the six new kinds**,
and none that moves a rule to `enforce`. `createRule` has exactly one production
caller (`apps/daemon/src/runtime/daemon.ts:539`, the seeded `keyword_filter`),
and `setRuleMode` has none. So today a `regex`, `invite`, `link_domain`,
`caps`, `attachment_type` or `emoji` rule exists only if someone hand-inserts a
`mod_rules` row.

That lowers the *blast radius* of everything below, and it does not excuse any of
it: the four new CLI commands shipped precisely because such rules are expected
to exist (`automod.ts`'s own header: "That rule cannot pass its gate until an
operator can populate the list"), and Slice 8/9 adds the creation surface. The
severities below are graded on the design intent — that these rules exist and an
operator manages them — because that is the decision the coordinator has to make
now, while the fixes are cheap. Where reachability changes the picture I say so
in the finding.

---

## CRITICAL

### CRITICAL-1 — the dry run reports a rule that threw on every fixture as a clean rule (Task 3 × Slice 2)

`packages/core/src/automod/dry-run.ts:103-112`, with
`packages/core/src/ops/commands/automod.ts:39-74` and `:144-153`.

`evaluateRule` has four outcomes. `runDryRun` handles three of them and folds
the fourth into silence:

```ts
// A predicate that throws on one fixture is recorded as a non-match for
// that fixture and the replay continues — one malformed message must not
// end the run, the same way it does not end the live handler.
const match = outcome.kind === 'match' ? outcome.match : undefined;
```

`failure` is left `undefined`, so `usable` stays `true`; `DryRunReport` has no
field for a throw; `projectReport` therefore cannot put one in `data`; and the
summary line prints as if nothing happened. A `should_not_match` fixture that
*threw* is even scored `agreement: 'agreed'`.

Task 3 introduced the first predicate that can throw at evaluate time — the
`node:vm` timeout is *designed* to throw (plan ruling PR-12, "returning 'no
match' would be silent"). So an operator who dry-runs a catastrophic-backtracking
pattern over a 300-fixture corpus gets:

```
0/300 matched · 0 false positive(s) of 300 labelled · 0 missed
```

Every evaluation timed out. The rule is unusable. The report is
indistinguishable from a rule that behaved perfectly — which is the exact
failure the two guards directly above it in `automod.ts` (`!report.usable`,
`report.total === 0`) exist to close, and the exact shape of Slice 2's
CRITICAL-1. PR-12's whole argument is that a throw is better than silence
because `evaluateRule`'s caller logs it; the dry run is a caller that does not.

The comment's justification ("the same way it does not end the live handler") is
the load-bearing error: the live handler does not end, **but it logs
`'the predicate threw; message left unmatched for this rule'` naming the rule**
(`subscriber.ts:307-317`). The dry run has no logger by design, and no report
field, so it says nothing at all.

**Fix.** Add `threw: number` to `DryRunReport` and a per-fixture
`outcome: 'ok' | 'threw'`; count throws in `runDryRun`; in `automod dryrun`,
treat `threw > 0` the way `!usable` is treated — refuse to print a match table
under it, and say `N of M evaluations failed (the predicate threw)`. Cheap, and
it also bounds IMPORTANT-5 if you abandon the run after the first few throws.

### CRITICAL-2 — `link_domain` has no empty-list guard: in `allow` mode it matches every link, in `deny` mode it can never match, and the CLI reports both as a tidy success (Task 6 × Task 8 × Task 9)

`packages/core/src/automod/predicates/link-domain.ts:71-108`,
`packages/core/src/automod/predicates/registry.ts:139-148`,
`packages/core/src/ops/commands/automod.ts:471-478` and `:673-698`.

`compileRule`'s `no-terms` check — the one that closes "a rule that looks
configured and can never match" — is hard-scoped to one kind:

```ts
if (rule.kind === 'keyword_filter' && rule.terms.length === 0) {
```

`link_domain` compiles from `rule.linkDomains.filter(e => e.listType === config.mode)`.
When that filter is empty:

- **`mode: 'deny'`, no deny rows** — `listed` is `[]`, `onList` is always false,
  the `deny` branch always `continue`s. The rule can never fire. `compileRule`
  returns `ok`, so `doctor`'s `listUnusableAutomodRules` reports nothing. This is
  ADR 0039's silent non-matching, in the slice that exists to kill it, for the
  one kind whose guard was never generalised.
- **`mode: 'allow'`, no allow rows** — `onList` is always false, the `allow`
  branch never `continue`s, so **every link in every message matches**. In
  `test`/`observe` that floods the corpus and the Slice 9 review queue with a
  false positive per link and opens a case event per message; in `enforce` it
  deletes every message containing a link.

Both states are one CLI command away. `automod domain-rm` on the last row prints:

```
removed example.com from rule r1's domain lists
rule r1's domain lists are now empty
```

"now empty" reads as a completed tidy-up. It is either "this rule is now inert"
or "this rule now blocks every link", and the command knows which — it has the
rule id — and says neither. `domain-add` has the mirror problem: creating a rule
before populating it leaves a window in which an `allow`-mode rule fires on
everything, and nothing warns.

The predicate's own comment shows the hazard was considered and the direction
got reversed:

> `mode` … Explicit rather than inferred from which rows exist, because
> inferring it would make deleting the last allow row silently change the rule
> from a whitelist into a no-op.

Deleting the last allow row does not make it a no-op. It makes it match
everything. The comment is a load-bearing claim and it is wrong.

`link-domain.test.ts` has no empty-list case in either mode, so nothing goes red.

**Fix.** Two parts. (1) Generalise the guard: in `compileRule`, return
`no-terms` for `link_domain` when no row carries the configured `mode` —
`doctor` then reports the deny case, and the allow case becomes inert-and-loud
rather than fire-on-everything. (2) Have `domain-add`/`domain-rm` print the
rule's `config.mode` and what the resulting list means (`this rule is a
whitelist; with an empty allow list it matches every link`). If you prefer to
keep `allow`-with-no-rows meaningful, then it must be `compile-failed`, not a
clean compile.

---

## IMPORTANT

### IMPORTANT-1 — `automod domain-add` prints the list the operator asked for, not the one the row is on (Task 6 × Task 9)

`packages/core/src/ops/commands/automod.ts:673-686`,
`packages/storage/src/repos/automod-rule-lists.ts:133-152`.

`automod_link_domains`' primary key is `(guild_id, rule_id, domain)` — the
schema comment says so deliberately ("a domain that appears on both is a
configuration error the primary key makes impossible to express"). `addLinkDomain`
is `onConflictDoNothing` on that key. So re-adding a domain with the *other*
`listType` is a no-op. The wiring's before/after count sees no change and returns
`'already-present'`, and the command renders:

```
example.com was already on rule r1's deny list      ← args.listType
rule r1's domain lists:
  allow example.com                                  ← the actual row
```

The line asserts a state that is false, and the operator's actual intent — move
this domain to the deny list — silently did not happen. Two lines of output
contradict each other and the wrong one is the headline. There is no move path at
all: nothing in this branch can change a domain's `listType`.

**Fix.** Return the stored `listType` from the port so the message can name it
(`example.com is already on rule r1's allow list; nothing changed`), or add an
`'on-the-other-list'` outcome and an explicit move. Do not paper over it by
printing `args.listType`.

### IMPORTANT-2 — `addLinkDomain` canonicalises, `removeLinkDomain` does not (Task 6 × Task 9)

`packages/storage/src/repos/automod-rule-lists.ts:133-135` vs `:155-169`.

Add lower-cases and strips a leading `www.`. Remove compares the operator's
string against the stored one verbatim. So `automod domain-rm r1 WWW.Example.COM`
deletes nothing and reports:

```
WWW.Example.COM was not on rule r1's domain lists
rule r1's domain lists:
  deny  example.com
```

The operator has to work out the canonical form from the printed list to remove
what they themselves added. `apps/daemon/src/ops/wiring.ts:190-197` congratulates
itself on avoiding exactly this class of drift on the add path ("comparing the
list's length before and after the write is correct regardless of what canonical
form the repository settles on") — and the remove path got none of that care.

**Fix.** Apply the same canonicalisation inside `removeLinkDomain`, in the
repository, so there is one place that knows the rule. (`removeInviteAllowlistEntry`
is consistent with its add — codes are stored case-preserving and matched
case-insensitively only in the predicate — but the same command-level surprise
applies there: removing `CLUBHOUSE` will not remove `clubhouse`. Worth the same
one-line fix.)

### IMPORTANT-3 — two new predicates put member-controlled strings into `MatchTrace.detail`, which is capped at 120 characters and enforced by throwing (Task 5 × Task 8 × Slice 2)

`packages/core/src/automod/predicates/attachment-type.ts:96-101`,
`packages/core/src/automod/predicates/link-domain.ts:118`,
`packages/core/src/automod/trace.ts:54`.

`matchTraceSchema`'s `detail` is `z.record(z.union([z.string().max(120), …]))`
and `serialiseTrace` throws on a violation — deliberately, because a trace that
fails its own schema is "a bug in our own code". Slice 2's `.max(120)` exists to
keep whole-message content out of the trace, and it is the right guard.

Two of the six new predicates put strings a member controls into that record:

- `attachment_type` → `detail.fileName`, the raw filename. Filenames run to 255
  characters.
- `link_domain` → `detail.host`. Hostnames run to 253, and in `allow` mode any
  host matches, so a member picks the value.

Verified against the installed zod: a 121-character value is rejected
(`too_big`); 120 passes. The result is not a crash — `traceJson`'s fallback
(`apps/daemon/src/automod/wiring.ts:170-199`) catches it — but every such match
stores a **placeholder** trace: `matchedOn` becomes
`'(the predicate produced an invalid trace)'`, `detail` becomes
`{traceError, kindReplaced}`, and the reviewer loses the size, the declared
content type, the attachment count, the host and the mode. And the log line says
`'the predicate produced a trace that failed validation'`, which sends an
operator hunting a bug in our code when the cause is a member naming a file. A
member can trigger it at will, on every match.

The reviewer is not left with nothing — Slice 2's CRITICAL-2 fix means `matched
"<filename>"` still prints from `matchedSnippet` — which is why this is
IMPORTANT rather than CRITICAL. It is still a systematic, member-triggered loss
of exactly the evidence Slice 9's screen is being built to render.

**Fix.** Truncate at the producer: `fileName: attachment.fileName.slice(0, 120)`
and the same for `host`. Better, make `serialiseTrace` truncate over-long
`detail` strings (with an ellipsis) instead of throwing, so the next predicate
that carries member text does not have to remember.

### IMPORTANT-4 — a filename is now personal information in a permanent moderation record, and PRIVACY.md was only updated for the corpus (Task 1 × Task 5)

`PRIVACY.md:32-35`, `packages/core/src/automod/predicates/attachment-type.ts:89-101`,
`packages/core/src/automod/subscriber.ts:353-354`.

Task 1 added the honest line about the corpus:

> Messages an automod rule matched while it was being tested, kept as examples
> … — including the name, type and size of any files attached to them

and the retention table already covers it (`Automod test examples | Kept until
the owner removes them. /forgetme removes yours.`). That is correct and it is
where OD-3's owner approval was directed.

Task 5 then puts the same filename somewhere else: `attachment_type`'s `snippet`
*is* the filename, so it lands in `mod_case_events.matched_snippet`, and
`detail.fileName` lands in `mod_case_events.trace`. Those rows are covered by
`Moderation records | Kept as long as the server needs them` and by
`/forgetme does not delete moderation records`. So `medical_letter.docx` survives
a member's deletion request indefinitely, in a table the owner was not asked
about, and PRIVACY's "Automod matches and the action taken" bullet does not say a
match can name a file.

Neither task could see this alone: Task 1 wrote the corpus line before the
predicate existed; Task 5 reviewed a predicate whose snippet convention was
already established.

**Fix.** One line in PRIVACY.md's "What it stores" list ("Automod matches and the
action taken — including the name of a file that triggered a rule"), and a
sentence in the `/forgetme` paragraph. If the owner would not accept that,
`attachment_type` needs a redacted snippet (`*.exe`, size, type) and the filename
confined to the corpus.

### IMPORTANT-5 — `automod dryrun` on a pathological regex blocks the whole process for `fixtures × 25 ms` (Task 3 × Slice 2 × Task 1)

`packages/core/src/automod/predicates/regex.ts:14`, `dry-run.ts:88`,
`packages/storage/src/repos/automod-fixtures.ts:216-273`.

The brief asks whether 25 ms per evaluation is survivable. On the *live*
subscriber path it is: one message pays 25 ms per timing-out regex rule, bounded
by the rule count, and the plan's measured 120 µs for a healthy pattern is fine.

The dry run is the case nobody costed. It is fully synchronous, one process (ADR
0006), and it replays the *whole* corpus: 300 fixtures × 25 ms = 7.5 s of
completely blocked event loop — no gateway heartbeat, no HTTP, no job worker. The
corpus has no cap and no expiry (`PRIVACY.md`: "Kept until the owner removes
them"), so it grows with every match in test/observe mode; at ~1 700 fixtures the
stall passes Discord's ~41 s heartbeat interval and forces a gateway reconnect,
which by CLAUDE.md rule 6's own assumption replays events.

And because of CRITICAL-1, what the operator sees after the freeze is a clean
report.

**Fix.** Abandon the run after a small number of throws (`k = 5`) and report it —
one change that fixes CRITICAL-1's reporting and bounds this. A per-run wall-clock
budget would do as well.

### IMPORTANT-6 — a dry run of an `attachment_type` rule prints `0/N matched` without saying how many fixtures carry any attachment metadata at all (Task 1/2 × Task 5)

`packages/core/src/ops/commands/automod.ts:144-153`.

`attachment_type` can only match a fixture that has attachment rows. Every
fixture captured before migration `0013` has none — `types.ts` is explicit and
honest about that ("an empty list is the honest representation"). But the dry-run
summary's denominator is the fixture count, not the count that could possibly
match. Over a corpus captured during the first weeks of the observe window an
`attachment_type` rule prints `0/300 matched`, which reads as "no bad files were
posted" and is actually "no fixture in this corpus records a file either way".

This is Slice 2's CRITICAL-1 one level down: the numerator got a denominator, and
then a predicate arrived whose real denominator is a different number.

**Fix.** When the rule's kind reads attachments, add
`k of 300 fixtures carry attachment metadata (the rest predate it and cannot
match this rule)` to the summary and to `data`.

### IMPORTANT-7 — none of the four new commands checks the rule's *kind* (Task 6 × Task 9)

`apps/daemon/src/ops/wiring.ts:194-224`, `packages/core/src/ops/ports.ts:317-360`.

The guard is `ruleExists`, which is existence only. So
`automod invite-allow default-word-filter clubhouse 'our server' --confirm`
succeeds, writes a row, writes an audit row, and prints
`rule default-word-filter's invite allowlist: clubhouse (our server)`. Nothing
will ever read it — `keyword_filter`'s `compile` does not look at
`inviteAllowlist`. Same for `domain-add` against an `invite` rule.

The `no-such-rule` path was carefully designed so an operator's typo is a usage
answer rather than an opaque foreign-key error. A typo'd *rule* is caught; a
typo'd rule that happens to name a real rule of the wrong kind is reported as a
success.

**Fix.** Add `'wrong-kind'` to each port's return union, check
`kind === 'invite'` / `'link_domain'`, and say so.

### IMPORTANT-8 — `emoji` counts `©`, `™`, `↔`, `▪`, `☑` as emoji (Task 4)

`packages/core/src/automod/predicates/emoji.ts:17-19, 47-58`.

The plan's Verified environment facts checked the *under*-count direction
(`\p{Extended_Pictographic}` misses flags and keycaps — correct, and correctly
fixed). Nobody checked the other direction. Measured on this Node just now:
`\p{Extended_Pictographic}` is **true** for `©`, `®`, `™`, `‼`, `↔`, `▪`, `☑`,
`♀`. These are text-presentation characters, not emoji.

So a bulleted list written with `▪`, a message with a `™`, or a checklist with
`☑` counts toward `maxCount`, and `maxCount` can be as low as 1. Release 2's gate
is a false-positive rate; this is a false-positive source in the predicate
itself, on ordinary club-server messages.

**Fix.** `\p{Emoji_Presentation}` is supported here and behaves correctly —
verified: false for `©` and `▪`, true for `😀` and each half of `🇬🇧`. Count a
grapheme when it matches `\p{Emoji_Presentation}`, or is
`\p{Extended_Pictographic}` **followed by U+FE0F** (the variation selector that
makes `©️` an emoji and `©` not), or is a regional indicator, or carries the
keycap. The keycap and regional-indicator branches stay as they are.

---

## MINOR

**MINOR-1 — `listFixtures`' single `inArray` meets SQLite's variable limit on a
large corpus** (`packages/storage/src/repos/automod-fixtures.ts:239-251`, Task 1).
The bundled SQLite is 3.53.4 (checked), so `SQLITE_MAX_VARIABLE_NUMBER` is
32 766. The corpus is uncapped and never expires, so past ~32.7 k fixtures in one
guild the attachment query throws `too many SQL variables` and takes `automod
dryrun` with it. Far off, but the fix is four lines: chunk the ids, or replace
the `inArray` with a join/`EXISTS` against the same filtered parent query.

**MINOR-2 — an orphaned doc comment in `ports.ts`** (`packages/core/src/ops/ports.ts:316-317`).
The six new methods were inserted *between* `/** Points an event kind at a
channel, creating or re-pointing the route. */` and `setRoute`. `setRoute` is now
undocumented and `addInviteAllowlistEntry` carries a comment about log routing.
In a codebase whose review brief says "comments are load-bearing claims", this is
worth the 10-second move.

**MINOR-3 — a second capture of the same fixture id can build an attachment list
that never existed** (`packages/storage/src/repos/automod-fixtures.ts:109-131`,
Task 1 × Task 2). The parent is `onConflictDoNothing`, and each child is
`onConflictDoNothing` on `(guild, fixture, ordinal)` — independently. A
`messageUpdate` that changes the attachments but not the content produces the
same `fixtureId` (`<messageId>:<sha256(content)>`), so a first capture of
`['a.txt']` followed by a capture of `['b.exe','c.exe']` stores ordinal 0 =
`a.txt` and ordinal 1 = `c.exe`: a file set no version of the message ever had,
in a table whose whole purpose is evidence. The comment claims otherwise — "the
first capture wins for both, which keeps parent and children consistent about
which capture they describe" — which holds only when the later capture has no
more attachments than the first. Fix: write children only when the parent insert
actually inserted (`.run().changes > 0`).

**MINOR-4 — obligation 2's end-to-end test reimplements the wiring it is meant to
cover** (`packages/storage/src/repos/automod-rule-lists.test.ts:104-118`). The
three invite ports are re-written against the repository rather than called
through `opsPortsFor`, for a stated and legitimate reason (ADR 0014 forbids the
import). The consequence is that `apps/daemon/src/ops/wiring.ts`'s six real port
implementations have no test at all, and the `link_domain` half is `notNeeded` in
this file too — so the CLI→storage→hydrate→predicate path is proven for
`inviteAllowlist` and unproven for `linkDomains`. That is where IMPORTANT-1 and
IMPORTANT-2 live.

**MINOR-5 — `EvaluateOutcome.kind === 'threw'` has no test at either consumer.**
`evaluate.test.ts:137` proves `evaluateRule` returns it; nothing proves the
subscriber logs it (`subscriber.ts:307-317`) or that the dry run does anything
sane with it. Since Task 3 shipped the first predicate that can produce it, both
branches deserve a test — and writing the dry-run one is how CRITICAL-1 would
have been found.

**MINOR-6 — `caps` and `emoji` truncate their snippet with `slice(0, 200)`,**
which can split a surrogate pair and store half an emoji
(`caps.ts:53`, `emoji.ts:66`). Cosmetic, but this is an emoji predicate. Use a
grapheme- or code-point-aware truncation (`[...content].slice(0, 200).join('')`).

**MINOR-7 — `validateRuleConfig` still has no production caller** (pre-existing,
Slice 1, not this branch). `createRule`'s and `setRuleConfig`'s doc comments both
say "the caller must call `validateRuleConfig(kind, config)` first", and the one
production caller (`daemon.ts:539`) does not. Harmless today because the only
seeded config is `'{}'` for `keyword_filter`; it becomes the write-side hole ADR
0040 §2 names the moment Slice 8 adds a rule editor. Noting it because six new
config schemas just landed behind it.

---

## Decorative guards

Tests that would stay green against the bug they are named after.

1. **All four new CLI command test suites**
   (`packages/core/src/ops/commands/automod.test.ts:590-855`). Every one drives
   `fakeOpsPorts` with a hard-coded outcome string — `addLinkDomain: () =>
   'already-present'` — and asserts on the rendered text. They test the
   renderer, which is fine, but they *cannot* fail for IMPORTANT-1
   (`already-present` rendered with the wrong `listType`), IMPORTANT-2
   (canonicalisation asymmetry) or IMPORTANT-7 (no kind check), because the
   repository is never in the loop. `it('says a code is already allowed rather
   than erroring on a repeat add')` in particular reads like a round-trip test
   and is a string assertion over a canned constant.
2. **`link-domain.test.ts` has no empty-list case in either mode**, so CRITICAL-2
   has no guard anywhere in the suite. Every one of its nine tests supplies at
   least one row of the configured mode.
3. **`caps.test.ts`'s "ignores fenced and inline code"** passes for two reasons at
   once — the code is stripped *and* the remaining prose has a 0.0 ratio. It does
   go red if the stripping is removed (the SQL is upper-case), so it is not
   decorative; noting it because one more assertion (`prose` length, or a shout
   *outside* the fence that still fires) would pin the intent rather than
   coincide with it.

Guards I checked and found genuinely non-decorative — worth saying explicitly,
since three of them are the handoff's own obligations:

- **Obligation 1, the ReDoS gate** (`regex.test.ts:110-124`). The pattern is
  measured-catastrophic on this machine, the input is 60 characters (the plan's
  table says 26 already costs 3 s), the assertion is a *throw* plus an elapsed
  bound of `8 × REGEX_TIMEOUT_MS`, and a second test proves a reused context
  survives a timeout. It proves what it claims.
- **Obligation 2, an allowlist edit reaching the fingerprint**
  (`automod-rule-lists.test.ts:164-217`). Reuses **one** predicate cache across
  the before and after evaluation, which is the whole point — a fresh cache would
  pass with `inviteAllowlist` excluded from the digest. It also re-reads through
  `listEnabledRules` rather than mutating the object in hand. Correct.
  `fingerprint.test.ts:129-180` adds the ambiguity a sort-only test would miss (a
  domain moving allow→deny at the same position).
- **Obligation 3, the one-code-path gate reaching a second field**
  (`dry-run.test.ts:181-244`). The new case gives the message both content *and*
  an attachment, and asserts `replayed?.trace.kind === 'attachment_type'` — so
  "two identical undefineds" cannot pass it. That last assertion is the
  difference between this and a decorative comparison, and it is there.
- **`fingerprint.test.ts:98-121`** was correctly repaired: it used
  `inviteAllowlist` as its example of "a field the digest was not taught about",
  which Task 6 turned into a field it now knows by name, and the test now uses a
  genuinely unnamed field. That is exactly the kind of drift this pass looks for,
  and the branch caught it itself.
- **`subscriber.test.ts:384-403`** (attachments reach the corpus) gives the
  message both content and an attachment, so an implementation passing `[]`
  passes every other assertion in the file and only this one goes red. Stated in
  the test, and true.
- **`regex.test.ts:47-78`** (span points at the right occurrence) uses
  `'concatenate a cat'` and pins its own premise with
  `expect(content.indexOf('cat')).toBe(3)`, having explicitly discarded a
  first-draft fixture too simple to fail. This is the standard the rest of the
  branch should be held to.

---

## Verified clean

Checked, and correct.

- **`AutomodRule` has exactly one production construction site.** `rg` for
  `inviteAllowlist` across all non-test, non-doc source finds only `hydrate`
  (`automod-rules.ts:127-148`), the type declarations, the predicate that reads
  it, and the fingerprint. Nothing builds an `AutomodRule` by hand outside tests,
  so the failure mode the brief names — a rule carrying empty lists silently, and
  an `invite` rule firing on allowlisted codes — does not exist. `hydrate` queries
  both new tables unconditionally with no `kind` branch, which is the right call.
- **Both new fields reach both consumers.** `listEnabledRules` → subscriber
  (`automod/wiring.ts:278`) and → `findAutomodRule` (`ops/wiring.ts:171`), both
  passing hydrated objects through untouched.
- **No field a predicate's `compile` reads escapes the digest.**
  `EXCLUDED_FIELDS` is `{ruleId, mode}`; `mode` is read by the subscriber, never
  by a `compile`. Across all seven registered predicates, `compile` reads only
  `config`, `terms`, `allowlist`, `inviteAllowlist`, `linkDomains` — all hashed.
  `attachment_type`'s Zod `.default([])` does not matter, because the digest
  hashes the raw `config` *string*, not the parsed object.
- **Guild scope (rule 2).** Every new repository function takes `GuildScope`
  first and every query goes through `scope.only(...)`, including
  `listFixtures`' child-table query. Both new tables carry `guild_id` in the
  primary key, in the composite foreign key, and in a snowflake CHECK.
  `predicateCacheKey` is still `<guildId>:<ruleId>`. There is no new function
  that can omit a guild.
- **Zod at every boundary (rule 3).** All four new config schemas are
  `.strict()`; `attachment_type` additionally `.refine`s that at least one list
  is non-empty, which is the `no-terms` idea done *right* (refused at validation,
  so `doctor` reports it) — and is precisely the guard CRITICAL-2 shows
  `link_domain` never got. `config` is parsed on the way out of the database in
  `resolveConfig`, not only on the way in. All four new CLI arg schemas are
  `.strict()` with bounded strings, and `listType` is a `z.enum` with a matching
  SQL CHECK. `regexConfig` bounds the pattern at 1 000 characters and refuses
  `g`/`y` with a measured justification.
- **Logs, exports, diagnostics (rule 4).** Nothing new is logged, and nothing new
  needed adding to `LOGGABLE_FIELDS` — correctly, none was added. The one new
  log-adjacent path is `evaluation.kind === 'threw'` → `err`, and no new
  predicate can put message content in a throw message: `regex`'s is the vm's
  fixed `Script execution timed out after 25ms`, `link_domain` catches its own
  `new URL` failure locally, and `caps`/`emoji`/`invite`/`attachment_type` cannot
  throw. Filenames reach the database only; there is no diagnostics bundle and
  the config export covers settings, not these tables. `traceJson`'s use of
  `compileError` with `failureSummary` (quoting nothing) rather than `err` is the
  right call and its reasoning is recorded.
- **AI (rule 1).** No provider call, no provider import, nothing async in any of
  the six predicates. All are pure functions of `PredicateInput` plus validated
  config. Every one of them works with every provider unreachable.
- **No new outbound destination (rule 8).** `invite` matches a regex and never
  resolves a code; `link_domain` uses `new URL` for parsing only. No `fetch`, no
  `node:dns`, no `node:http` anywhere in the diff. `node:vm` executes a fixed
  one-line script with no network access reachable from its context.
- **No new dependency.** `node:vm` and `Intl.Segmenter` ship with Node 22;
  `package.json`/`package-lock.json` are untouched by the branch.
- **No new Discord side effect (rule 6),** so no new idempotency key is owed —
  saying so rather than inventing one. The only Discord call on the touched path
  is the pre-existing `deleteMessage`, unchanged.
- **`lastIndex` hazards on the module-level `g`-flagged patterns.** `INVITE` and
  `URL_LIKE` are only used via `String.prototype.matchAll`, which iterates a
  *clone* and does not write back to the original — the comment in `invite.ts`
  is correct. `CUSTOM_EMOJI` is used with `String.match` and `String.replace`,
  and `FENCED_CODE`/`INLINE_CODE` with `replace`; all three reset `lastIndex`.
  The three `test()`-ed patterns in `emoji.ts` carry no `g`. `regexConfig`'s
  refusal of `g`/`y` closes the operator-supplied case, and it is tested for
  `g`, `y` and `gi`.
- **`link_domain`'s parsing.** Trailing sentence punctuation stripped before
  parsing *and* a trailing root dot stripped from the host afterwards (both
  needed, both tested); label-wise suffix matching rather than `endsWith`, with
  the `notexample.com` ambiguity tested; port, userinfo and case handled by
  `new URL` as the plan measured.
- **`attachment_type`'s matching.** `extensionOf` takes the last dot-segment only
  (so `exeter-notes.pdf` does not match `exe`) and `dot <= 0` correctly rejects a
  dotfile; `bareContentType` strips `; charset=…`; extension **or** content type
  is enough, which is the spec's belt-and-braces intent, not a conjunction.
- **`caps`.** Code fences removed before inline spans, in that order and for the
  stated reason; the `minLength` floor is applied to the code-stripped prose, so
  a message that is mostly code cannot trip it; the ratio is over letters, not
  characters; division by zero handled.
- **`attachment_type` cannot be defeated by an empty config,** and an
  attachment-only message *is* evaluated: the adapter maps a non-partial
  message's empty content to `''`, not `undefined`
  (`packages/discord/src/events.ts:395`), so `predicateInputFrom`'s
  `content === undefined` guard does not drop an image-only post. I checked this
  specifically because it would have made the whole predicate dead on the live
  path.
- **The corpus cascade.** `automod_fixture_attachments`' `ON DELETE CASCADE` is
  tested through `deleteObservedFixturesForMember`, not assumed — which also
  proves `foreign_keys` is on in the test database.
- **PRIVACY.md's retention table** already covers both new rows
  (`Automod test examples`, `Attachments | Same as the messages they belong to`),
  so only the "what it stores" bullet for *moderation records* needs the sentence
  IMPORTANT-4 asks for.
- **Slice 2's CRITICAL-2 fix holds under the new predicates.**
  `renderReviewableMatch` prints `message` and `matched` unconditionally, before
  and independently of the trace, so `caps`, `emoji` and `attachment_type` —
  which all have `span: undefined` — still show a reviewer the message and the
  snippet. `caps`/`emoji` compensate for the missing span with a quantified
  `detail` (`ratio`, `letters`, `upper`, `minLength`, `maxRatio`; `total`,
  `custom`, `unicode`, `maxCount`), which is enough to agree or disagree with
  the threshold. I judge the no-span traces adequate.
- **PR-14's deferral of `invite`'s `last_matched_at` is no worse than recorded.**
  The schema comment states it, the alternatives are correctly characterised, and
  nothing in the shipped code pretends the column exists.
- **Task 6's missing test file is now adequately covered, with one gap.**
  `listInviteAllowlist`, `addInviteAllowlistEntry`, `removeInviteAllowlistEntry`
  and `listLinkDomains` are exercised by `automod-rule-lists.test.ts` (including
  guild isolation and the canonicalisation on add). The gap is not the repository
  — it is the *wiring* on top of it (MINOR-4), which is where IMPORTANT-1 and
  IMPORTANT-2 hide.
- **The plan's Verified environment facts** are not contradicted by any code in
  the branch. I did not re-derive them; I extended one (IMPORTANT-8 measures the
  opposite direction of the `Extended_Pictographic` fact) and separately measured
  two new things the branch depends on and the table does not name: the bundled
  SQLite version (3.53.4 → 32 766 variables, MINOR-1) and zod's rejection of a
  121-character `detail` value (IMPORTANT-3).

---

## Hard-rules checklist

| # | Rule | Verdict |
| --- | --- | --- |
| 1 | AI never in the enforcement path | **Pass.** No provider import or call in the diff; all six predicates are pure and synchronous. |
| 2 | Guild scope is a mandatory partition key | **Pass.** Every new repo function takes `GuildScope` first; every query goes through `scope.only`, including `listFixtures`' child query; both new tables carry `guild_id` in PK, FK and CHECK; `predicateCacheKey` unchanged. |
| 3 | Model output / stored data is untrusted input | **Pass.** Four new `.strict()` config schemas, validated on read as well as write; four new `.strict()` CLI arg schemas; trace parsed by `matchTraceSchema` on read. No model output involved. |
| 4 | No secrets, and nothing new in logs/exports/diagnostics | **Pass.** No new `LOGGABLE_FIELDS` entry, and none needed. Filenames reach the database only — but see IMPORTANT-4: the *database* location is broader than PRIVACY.md was updated for. |
| 5 | No provider receives server content | **Pass, vacuously.** No provider is touched. |
| 6 | Every Discord side effect has a durable idempotency key | **Pass.** This slice adds **no** new Discord side effect, so none is owed. Stating that rather than inventing one. |
| 7 | Licensing | **Pass.** No copied code; `docs/PROVENANCE.md` needs no entry; `node:vm` and `Intl.Segmenter` are platform. |
| 8 | No autonomous writes, broad access, DM AI, or new outbound destinations | **Pass.** `invite` never resolves a code; `link_domain` never does DNS; no `fetch`/`dns`/`http` in the diff. The four new writes are operator-initiated CLI commands with `--confirm` and an audit row. |
| 9 | Never spawn `claude` from application code | **Pass.** Nothing in the diff goes near it. |
| — | No new dependency | **Pass.** `package.json` untouched. |

## What I would fix before merging

CRITICAL-1 and CRITICAL-2 are both small, and both are the shape this project
keeps getting bitten by. IMPORTANT-1 through IMPORTANT-4 are each a few lines and
all four are in the operator's line of sight. IMPORTANT-5 falls out of
CRITICAL-1's fix. The rest can be a follow-up, but IMPORTANT-7 is worth doing in
the same pass as IMPORTANT-1 since it touches the same three port signatures.
