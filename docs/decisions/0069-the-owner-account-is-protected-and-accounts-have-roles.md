# 0069. The owner account is protected and accounts have roles

Date: 2026-09-24
Status: Accepted (owner approved spec 2026-09-24)

## Context

The dashboard lets an owner manage accounts, but the owner account itself
could be deleted or disabled (spec A1). The create form lists raw capability
ids with no explanation, access grants are a confusing checkbox, and deleting
an account can fail with a misleading error (spec A2, A3, A5). Implements
spec Part A sections A1, A2, A3 and A5.

## Decision

- An account with `is_owner = 1` shows an **Owner** badge and the sentence
  "The owner runs this Bananasaurs install and always has every permission
  on every server."
- The dashboard shows no delete, disable, remove-server-access or permission
  controls for an owner row. The owner can still change their own password.
- The HTTP routes refuse these actions on an owner account with
  `403 owner-protected`, whoever asks. This is enforced on the server, not
  only hidden in the UI. Tests are written first.
- The CLI recovery path (`bootstrap reissue`, ADR 0056) is untouched: the
  guard lives in the dashboard route layer, so a human on the host can still
  recover.
- Adding an account happens on one page (`/accounts/new`) with an **Add
  account** button at the top right of the Accounts page: name with inline
  rules, a password choice (generate by default, or choose with a strength
  hint), one role card per server, and a review sentence before **Create
  account**.
- Role presets (Cloudflare-style): **Viewer** (see settings, logs and
  history; change nothing), **Moderator** (Viewer plus moderation actions,
  undo and role changes), **Server manager** (everything on the server except
  managing accounts and connecting apps), **Custom** (every permission as a
  checkbox, each with a one-line description). The descriptions live in one
  source of truth in `packages/core/src/authz.ts`.
- Access to the current server is always granted on creation; the checkbox is
  gone. The edit page (`/accounts/:username`) shows Summary, Permissions on
  this server, Password, Sessions and apps, and a Danger zone, with a new
  revoke-one-permission route.
- Fix the delete bug properly: `apiFetch` sets `Content-Type: application/json`
  only when a body is sent, and the Fastify error handler keeps a 4xx status
  from Fastify's own errors instead of turning everything into 500. The
  regression test sends a real bodiless DELETE with
  `Content-Type: application/json` through the real Fastify app.

## Consequences

The owner cannot be locked out through the dashboard, and every other account
gets a readable role instead of raw capability ids. The bodiless DELETE fix
also repairs "stop archiving", "send-disallow" and logging "unexclude", which
share the same failure.
