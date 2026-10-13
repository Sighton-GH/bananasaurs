# P5 Task 7a - Moderation deviations and notes

Base d318fb29. Branch oc/p5-u7a. Local only.

## Scope done
- Move-only commit: `review` and `logging` moved to `pages/<name>/index.tsx`; one-line wrappers at the original paths export the exact original names (`ReviewPage`, `LoggingPage`). Shell and old tests are untouched. Only the relative import depth changed.
- Sweep: `Moment` (domain-local, `pages/moderation/moment.tsx`) renders relative time in a `<time>` with the absolute local time with zone abbreviation in `title` and ISO in `dateTime`. Used in cases, case, member, review.
- `/cases`: status filter (All/Open/Closed, client-side over the same `GET /api/mod/cases?limit=50`), "No cases match these filters" with Clear filters.
- `/members`: "Find on this page" filter over the loaded 25-member page. It says it filters only the loaded page. The cursor request is unchanged.
- `/automod` create form: native `<select>` to kit `Select`, `<textarea>` to kit `Textarea`. Kind change still loads the example config. POST body unchanged.
- `/safety`: health failure now shows `Unavailable` with retry and says the state is unknown (before: "Loading..." forever). Kill switch buttons unchanged and still reachable. Definition list stacks below the `sm` breakpoint, action row wraps, long breaker reasons use `overflow-wrap:anywhere`. No overflow-hidden, no max-width clipping.

## Request-assertion audit
No stubFetch URL, method or body assertion was changed. `/api/killswitch` body `{on}`, ConfirmDialog scope text, and the `/api/automod/rules` POST body are asserted as before.

## Test change (interaction only)
`automod-rules.test.tsx` "posts the create body exactly": the Kind field is now a Radix Select, so the test changes it through Radix's form-bridge `<select aria-hidden>` instead of `getByLabelText('Kind')` on a native select. The expected request body is byte-identical.

## Not done / not claimed
- Safety 180 CSS px overflow was NOT reproduced or measured: no real browser here. The fix is a class-contract change checked in jsdom only. Nothing is claimed about the base overflow cause or about pixels. The earlier 360 dry-run chip report is not base-confirmed.
- `logging` keeps its native checkbox (`TriCheckbox`, indeterminate state); there is no kit checkbox at d318 and a new shared primitive is out of ownership.
- `review`, `case`, `logging` raw `<details>` (Advanced payloads) are unchanged.
- No native keyboard or focus walkthrough, no light/dark, no 360/1440 pixel checks.
- Review queue/Audit log/NAV label mapping: no mapped route labels in owned files, no change.
- No Shell route patch needed (no new route).
- Fix round (review): hover title now includes the timezone (timeZoneName short), per docs/28 2.3. Test asserts a zone suffix pattern; also green under TZ=Asia/Kolkata.
