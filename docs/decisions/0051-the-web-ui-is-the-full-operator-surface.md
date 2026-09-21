# 0051 — The web UI is the full operator surface

> Reconstruction note: this ADR was drafted and committed on the original
> `oc/webui-overhaul` branch, which was lost when its sandbox was rebuilt
> before the first push (2026-09-20). Sections D5, D6, D6b, D7,
> Consequences and Rejected below are the lost file's verbatim text,
> recovered from the working transcript. The Context and D1–D4 are
> paraphrased from the design record (milestone reports and the
> implementation plan) and are marked where wording is not verbatim.
>
> Numbering note (from the original): drafted as 0050, renumbered to 0051
> when ADR 0050 (MCP read logging takes the middle path) landed on main
> first (merge caa10d1, 2026-09-20).

## Status

Accepted (2026-09-20). Implementation on `oc/webui-overhaul`; unmerged
pending owner review — the owner reviews the branch, Claude audits it, and
the owner approves any merge.

## Context

(paraphrased) The operator CLI (`docs/17_OPERATOR_ACCESS.md`) was the only
complete operator surface; the dashboard was a Release 1 page. The owner
instructed (2026-09-20, WhatsApp): overhaul the entire web UI into a
production-grade application, make every capability available through the
terminal available through the web UI, preserve the observe-phase safety
posture, and distinguish observation/simulation/enforcement-capable
controls without silently enabling enforcement. Follow-up instructions the
same day: immense improvements on every page rather than a responsive
shell; keep the Release 3 stub pages; docs updates are in scope; take the
inbound threads/forums and MCP read-logging work into account; final
credit reads "just sighton media".

## Decision

(paraphrased) D1–D4:

- **D1** — The dashboard becomes the second operator surface over HTTP, on
  the core ops ports; it does not proxy the CLI dispatcher (see Rejected).
- **D2** — `packages/http` gains ops read and write route modules covering
  the whole `docs/17` catalogue; audit rows carry `actor_type='dashboard'`,
  `via='http'`; refusals are audited 4xx answers.
- **D3** — New pages expose exactly what the CLI does today; no new
  capability enters through the UI.
- **D4** — Controls are labelled by their safety class (observation,
  simulation, enforcement-capable); nothing in the UI moves a rule out of
  the observe window, and panel sync is reconcile-enqueue only.

(verbatim from here)

### D5 — Brand, attribution, and the one accent that stays semantic

- The owner-supplied banana-saur mark becomes the product mark: rail header,
  login and bootstrap, favicon, and empty-state art. The exact supplied
  image is preserved untouched as the source asset; web assets are derived
  (sized, compressed, placed on a light tile so no pixel of the mark is
  edited and no transparency is faked).
- Original Bananasaurs-themed background art is created for the login screen
  and the shell backdrop, in dark and light variants. It sits behind content
  at low contrast with a scrim, ships as static optimized files, carries no
  animation beyond what `prefers-reduced-motion` can disable, and never
  reduces text contrast below 4.5:1.
- ADR 0043's amber `#F2B441` stays **reserved for state**. Brand warmth comes
  from the artwork and the mark, not a second yellow in the component
  palette; a yellow that means "brand" next to a yellow that means "the bot
  is holding back" would dilute the one colour the operator must trust.
- Attribution is a first-class footer on the shell and the login screen:
  "Bananasaurs by Sighton Media" with `https://sighton.ca` linked, using the
  owner-supplied Sighton Media mark alongside. Owner decision, 2026-09-20:
  asked whether the public credit should name him, the owner answered "just
  sighton media" — no personal name appears in the product.

### D6 — Production-grade shell, same stack

No new runtime dependencies. The stack ADR 0043 verified (Tailwind v4
tokens, wouter, Radix primitives, hand-written components) carries the
overhaul; icons are inline SVG. What changes is layout and density:

- The rail becomes a real app rail: grouped areas (Operate, Moderation,
  Archive, Instance, Planned), the mark and guild identity on top,
  attribution at the bottom. On mobile it collapses into a drawer behind a
  menu button — the baseline mobile layout squeezes content into half the
  viewport, which this fixes.
- A top bar carries the page's purpose, the guild switcher, the session's
  re-auth freshness where it matters, and the account menu.
- Overview becomes actionable status cards leading to detail (docs/06:
  "cards that lead to actionable detail rather than decorative statistics").
- Every page keeps D6's `<DataState>` boundary; new pages are built on the
  shared component set, and tables stay hairline-row tabular data.

### D6b — The Release 3 placeholders stay visible

The first shell pass removed the four Release 3 stub pages (Resources,
Memory, AI workspace, Proposals) on the principle that navigation lists what
exists. The owner corrected that on 2026-09-20 ("keep the stub pages as we
will need them later for release 3"): the placeholders return as a 'Release
3' rail section, each page a purpose sentence and a plain not-built
statement, styled to the new shell and making no API call. Navigation lists
what exists **plus what the owner wants the roadmap to show**, marked as
such.

### D7 — Archive and Search pages arrive now

Ruling S10-D3 kept both CLI/MCP-only for Release 2; the owner's parity
instruction supersedes it. The pages expose exactly what `archive status`,
`archive enable-channel`, `archive disable-channel`, `archive search`,
`archive preserve`, `archive link-case`, `archive reindex` and the backfill
enqueue do today — no new capability. The three vetoes of ADR 0046 (guild
allowlist, per-channel enable, log-exclusion) stay server-side; the UI shows
their state and cannot widen it.

## Consequences

- `docs/06_DASHBOARD_TARGET.md` and `docs/17_OPERATOR_ACCESS.md` are updated
  to name the dashboard as the second operator surface and to remove the
  superseded release-gating lines.
- `docs/PROVENANCE.md` gains no entries: no code is copied and no
  dependencies are added. Brand assets are owner-supplied or generated for
  this project; `branding/BRAND.md` records their origin.
- The HTTP surface grows by roughly two route modules; every new route has
  route tests of the kind Slices 7–9 established, and dashboard pages keep
  their jsdom component tests.
- Slice 11's freeze is unchanged. If a future slice merges the cutover
  driver, the dashboard can surface it behind the same labels D4 defines —
  that is a later ADR's job, not this one's.

## Rejected

- **Proxying the CLI catalogue over HTTP verbatim.** The dispatcher resolves
  CLI-shaped requests and hard-codes `actor_type='operator_cli'`; routing
  HTTP through it would misattribute every row (the same reason
  `routes/write.ts` predates this slice). Ports, not the dispatcher, are the
  seam.
- **A second brand yellow in components.** See D5.
