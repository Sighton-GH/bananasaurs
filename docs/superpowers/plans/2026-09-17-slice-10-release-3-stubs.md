# Slice 10 — Release 3 route stubs

**Status: DRAFT.** Written 2026-09-17. **Branch:** `oc/slice-10-stubs`.
**ADR:** none — ADR 0043 D3 ("navigation is data") already reserves
`NavStatus = 'stub'` for this slice, and `packages/dashboard/src/app/routes.ts`
carries the comment naming it.

**Goal** (roadmap spec, Slice 10): clearly-labelled empty routes for the
Release 3 areas — Archive, Search, Resources, Providers, Memory, AI
workspace, Proposals — so Release 3 adds a page rather than triggering a
rebuild. Each stub states plainly that the feature does not exist yet;
`docs/06`'s own requirement is that the UI never pretends an unbuilt module
is available.

**Amended 2026-09-12 (carried):** Archive and Search stay stubs even though
Phase 4b built the archive and FTS5 search underneath them. The CLI is the
management surface for those in Release 2; the pages arrive with Release 3.
The two stubs say so.

## Rulings

**S10-D1 — stubs render in their own rail group, not among the built
entries.** The rail gains a second `<nav aria-label="Planned">` below the
first, listing only `status: 'stub'` entries, visually muted, headed
"Release 3". The existing `<nav aria-label="Areas">` filters to
`status: 'built'` explicitly, so a stub can never appear there by accident.

**Corrected after implementation.** The first draft said the existing test
"the rail lists every built NAV entry and no others" was the guard that would
catch a stub being promoted to `'built'`, and that keeping it unchanged was
the point. That was wrong, and the implementer proved it by breaking it:
the test computes its expectation from `NAV` at runtime
(`NAV.filter(n => n.status === 'built')`), exactly like the rail it checks,
so a promoted stub moves both sides together and the test stays green. What
actually catches a promotion is the **new** "Planned lists exactly the seven"
test, which asserts seven literal labels. Hardcoding nine labels into the old
test would have caught it too, but would fight ADR 0043 D3 ("navigation is
data") for no gain. The ruling's *design* stands; its stated rationale was a
guard I had not watched fail.

**S10-D2 — one `StubPage` component, seven one-line facts.** Not seven
hand-written pages. Each stub is `StubPage` with a title, one sentence saying
what the area will be, and the fixed statement that it is not built. No
disabled buttons, no empty tables, no placeholder data — anything that looks
like a feature with nothing behind it is the thing `docs/06` forbids. A stub
page makes **no API call**; a test asserts it.

**S10-D3 — the stub says which release, and Archive and Search say where the
feature lives today.** "Not built. Planned for Release 3." on all seven;
Archive and Search add "The archive and search exist in Release 2 as
operator CLI commands (`archive`, `mcp`) and through the MCP connector; the
page arrives with Release 3."

## Global constraints (copy verbatim into the brief)

1. **Do not touch** `mod_rules`, `setRuleMode`, `packages/core/src/mod/`,
   `packages/core/src/automod/`, `packages/core/src/effects/gateway.ts`.
   The observe window is running on two live guilds. Nothing in this slice
   is outside `packages/dashboard/`.
2. **The systemd unit runs the main checkout's `dist/`.** Work only in the
   worktree.
3. **Do not build ahead** (CLAUDE.md, current release scope). A stub is a
   statement that a thing does not exist. If a stub starts to do anything,
   it has stopped being a stub.
4. **Break every guard and watch it fail.**
5. Gates: `npm run typecheck && npm run lint && npm run test` pass by exit
   code, in the worktree.

## The one task

Seven stub entries in `NAV` with `status: 'stub'`; `StubPage`; seven routes;
the "Planned" rail group; tests — each route renders the not-built statement,
the planned group lists exactly the seven, the built group is unchanged, and
no stub page fetches. `docs/STATE.md` gains one line.
