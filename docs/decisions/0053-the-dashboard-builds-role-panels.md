# 0053. The dashboard builds role panels: managed panels only, definition validated before write, publish stays a separate act

Date: 2026-09-20
Status: accepted

## Context

Role panels had no production creation path. The operator command registry
carries `panel list`, `panel show` and `panel sync` but no `panel create`;
the MCP connector has no panel tool; and the only caller of
`panelRepo.createPanel` was `scripts/seed-test-panel.mjs`, which refuses to
run under `BANANASAURS_ENV=production`. The dashboard's panels page even
pointed operators at a CLI command that does not exist. The owner's standing
rule (2026-09-20) is that every current capability needs a dashboard path,
and he explicitly approved building the creation path in the dashboard.

Two scoping choices fall out of the panel model (`core/panels/model.ts`):

- **Managed panels only.** An adopted panel claims a message someone else
  posted and owes an adoption pass over its reactions — minutes of REST
  traffic, blocked-role resolution and an allowance (`adoption allow`). That
  flow answers "we already have a reaction post", which is not what a builder
  is for. A builder starts from nothing, so it creates a managed panel: the
  bot owns the message, components are buttons or a select menu, and there is
  no adoption pass.
- **Creation and publication stay separate acts.** `createPanel` writes the
  definition; nothing reaches Discord. Posting the message is the existing
  bounded publish (`POST /api/panels/:id/publish`, `panel sync`), which the
  operator triggers deliberately after reviewing what was built. A create
  that also posted would hide a live side effect inside a form submission.

## Decision

Add a dashboard panel builder on the panels page:

1. Channel from the named channel picker (never an ID-only field).
2. Behaviour (`toggle`, `add_only`, `remove_only`, `single_choice`) and
   component (`button` or `select`) chosen from labelled options that say
   what each does, with the invalid pairs refused by
   `panelDefinitionSchema` itself.
3. Up to `MAX_PANEL_OPTIONS` role options: role, label, optional emoji,
   display order. Role picks come from the guild's role list, never typed
   snowflakes.
4. A review step that shows the exact definition; confirming writes it
   through `panelDefinitionSchema` — the same validator the dev seed script
   goes through, so a dashboard panel is indistinguishable from any other.
5. The new panel then appears in the list with the existing publish and
   reconcile levers.

The write goes through a new `panel create` operator command and its
`POST /api/panels` route, audited as `actor_type='dashboard', via='http'`,
behind the existing `panels.manage` capability. The CLI gains the same
command over the same port, so the web-is-the-full-surface rule
(ADR 0051) keeps its symmetry in the other direction too.

## Consequences

- The panels empty state no longer needs to apologise: the builder is the
  next action.
- Adopted panels remain a deliberate non-goal here; if a club needs one,
  that is its own slice with the adoption pass and allowance in view.
- The builder never widens the role allowlist silently: options whose roles
  are not allowlisted are caught by the existing gateway at publish time,
  and the builder says so up front rather than letting the operator discover
  it from a dead panel (docs/SESSION_LOG.md's seed-script lesson).
