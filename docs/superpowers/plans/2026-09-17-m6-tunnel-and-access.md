# Slice M6 — the tunnel, Access, and the live end-to-end

**Status: DRAFT.** Written 2026-09-17, before implementation.
**Branch:** `oc/m6-tunnel-access`. **ADRs:** amendments to 0045 (exposure)
and 0029 (the session cookie); no new number.
**Precondition:** M5, merged at `765695a`. The live database is migrated
through 0023 and the daemon is up on both guilds.

**Owner decision, 2026-09-17:** `bananasaurs.sighton.ca` publishes the
**dashboard too**, behind Cloudflare Access — not only the MCP surface the
original plan scoped. The owner set up the tunnel and Access the same day;
`cloudflared` was already installed and authenticated on the box. The
Anthropic training opt-out is confirmed set on the connector account, which
clears ADR 0044 §8.4's precondition for the first real read.

## What changes because the dashboard is published

The original M6 published only `/mcp`, `/oauth/*` and the two well-known
documents, with everything else answered `404` at the edge. The dashboard
stayed loopback-only, reached by `ssh -L` or Tailscale, because "`0.0.0.0`
would put a password form holding the kill switch on the LAN" (`docs/17`).

Publishing it does **not** widen the bind — `cloudflared` connects to
`127.0.0.1:8787` from the same machine, and `DASHBOARD_BIND` still refuses
anything else. What changes is that the login form, the session cookie and
the kill switch are now reachable from the internet, and the thing standing
in front of them is a Cloudflare Access policy. **Access is the entire
security boundary for the dashboard paths.** A misconfigured policy exposes
the kill switch to the world, silently. That is why M6-D1 exists.

## Rulings

**M6-D1 — `doctor` probes the public surface in both directions, and that
is the slice's one new outbound destination.** Hard rule 8 forbids a new
outbound network destination without an explicit instruction; the original
M6 task instructs exactly this probe ("checked by an unauthenticated
`GET /oauth/authorize` through the public hostname returning an Access
redirect, not the consent page"), and the destination is the daemon's own
`MCP_PUBLIC_URL`. Nothing else is contacted. The probe runs only when
`MCP_PUBLIC_URL` is set, sends no credentials, and uses a short timeout.

Both directions, because a boundary checked for the wrong input and never
for the absent input is this project's Slice 4 CRITICAL-2:

| Path | Must return | Must NOT return | Meaning if wrong |
|---|---|---|---|
| `/` and `/api/health` | Access redirect or 403 | the SPA shell / API JSON | **the dashboard is exposed** |
| `/oauth/authorize` | Access redirect or 403 | the consent page | the consent page is exposed |
| `/.well-known/oauth-authorization-server` | the JSON document | an Access redirect | **the connector cannot work** |
| `/mcp` (no bearer) | `401` with the RFC 9728 challenge | an Access redirect | the connector cannot work |

An edge `404` on any of them means the ingress is not publishing that path;
a `502` means the tunnel is up and the origin is not. Each is its own
finding, and all of them make `doctor` report `PROBLEMS FOUND`, because a
dashboard reachable without Access is a silent breach of the whole exposure
decision, not a footnote.

**Cost if wrong:** one HTTPS round trip to the bot's own hostname at
startup and on every `doctor`, and a `PROBLEMS FOUND` when the tunnel is
down — which is correct.

**M6-D2 — the session cookie is `Secure` when the request arrived over HTTPS,
decided from `X-Forwarded-Proto` alone, and ADR 0029 is amended.** ADR 0029
omitted `Secure` because both documented remote paths delivered the
dashboard as plain `http` on localhost, where a `Secure` cookie is never
stored and login appears to succeed and then bounces. That reasoning was
true and is about to be incomplete: there is now a third path, over HTTPS,
and a session cookie on a public HTTPS dashboard without `Secure` is basic
hygiene missing.

`request.protocol` cannot decide it — `trustProxy` is off (M6-D4) so it is
always `http`. So: `Secure` iff the request carries `X-Forwarded-Proto:
https`, read directly. A direct loopback client never sends that header, so
`ssh -L` and Tailscale keep working exactly as before. A client that
*spoofs* it on plain `http://127.0.0.1` gets a `Secure` cookie the browser
drops and a login that bounces — a self-inflicted nuisance that widens
nothing, which is the direction to fail in.

**M6-D3 — `trustProxy` stays off.** Turning it on changes `request.ip` for
every route, and `packages/http/src/routes/oauth.ts:140` already reasons
about the rate limiter on the basis that it is off. The one proxy-derived
fact the daemon consumes is the scheme, for M6-D2, read from one header for
one decision that fails safe. Nothing authorises on it. Revisit after the
observe window if real client IPs in the session row are wanted.

**M6-D4 — the ingress publishes the whole origin and never rewrites `Host`.**
With Access as the boundary, the ingress becomes one rule to
`http://127.0.0.1:8787` plus the edge `404` catch-all for other hostnames.
`originRequest.httpHostHeader` must **not** be set: `originMatchesHost`
compares the `Origin` header's host to the `Host` header by equality, and
`cloudflared` forwards the original `Host` by default, so the consent POST
works unchanged through the tunnel. A rewritten `Host` would break it, and
the "fix" someone would reach for is loosening the CSRF check. The live run
records what `Host` and `Origin` actually arrived as.

**M6-D5 — the Access layout is one identity policy on the hostname and one
Bypass policy on the six machine paths.** Cloudflare matches the more
specific path first. The Bypass set is exactly `/mcp`, `/oauth/token`,
`/oauth/register`, `/oauth/revoke`,
`/.well-known/oauth-authorization-server` and
`/.well-known/oauth-protected-resource` — every path a client reaches with
no browser and no Access cookie, each already guarded by a bearer token or
PKCE. `/oauth/authorize` is deliberately **not** in it: it is the only OAuth
path a human loads in a browser, and it inherits the identity policy. This
is what M6-D1's table verifies.

**M6-D6 — (M5 Minor N1) `mcp allow-channel` accepts a voice or stage
channel's text chat, and the wording changes to match.** discord.js reports
those as `isTextBased()` because they carry a `messages` manager. They are
in-guild, the owner opts in per channel, and refusing them would remove an
option at no gain in safety. The comments and `docs/17` said "text channel";
they now say "a channel of this guild the bot can post text into".

## Global constraints (copy verbatim into every brief)

1. **Do not touch** `mod_rules`, `setRuleMode`, `packages/core/src/mod/`,
   `packages/core/src/automod/`, or `packages/core/src/effects/gateway.ts`.
   The observe window is running on two live guilds.
2. **The systemd unit runs this checkout's `dist/`.** Every `npm run build`
   or `npm run typecheck` on `main` is a deployment. Work on the branch in
   its worktree; nothing in a brief runs a gate on `main`.
3. **No new outbound network destination** (hard rule 8) beyond the one
   M6-D1 names. No probe of anything but `MCP_PUBLIC_URL`'s own hostname.
4. **No secrets anywhere** (rule 4). The probe sends no credentials and logs
   no response body.
5. **Verify both directions of a boundary.** M6-D1's table has a "must NOT"
   column for a reason.
6. **Break every guard and watch it fail.**
7. Gates: `npm run typecheck && npm run lint && npm run test` pass by exit
   code, in the worktree.

## Tasks

### Task 1 — the four M5 Minors and the cookie

N1 (M6-D6 wording), N2 (the allow-time guard exists in only one `OpsPorts`
implementation — add it to `packages/http/src/test-support.ts` or pin the
gap with a test that names it), N3 (an uncached channel is reported as "not
on the send allowlist" — give it its own refusal text), N4 (`mcp sends`
renders a failed attempt as `sent` — the ledger CHECK has no `failed`, so
render "sent (no message id recorded)" and say why). Then M6-D2's `Secure`
flag, with ADR 0029 amended and a test in each direction: loopback request
without the header → no `Secure`; request with `X-Forwarded-Proto: https`
→ `Secure`.

### Task 2 — the `doctor` probe (M6-D1)

A `publicSurface` finding in `buildDoctorReport`, behind `MCP_PUBLIC_URL`,
implementing the table exactly, with the fetch injected so every row is
testable with no network. Each row's failure has its own line in the
rendered report naming the path and what came back. Wired into `ok`.

### Task 3 — `deploy/` and the documents

`deploy/cloudflared-config.yml` per M6-D4 with the reasoning attached;
`deploy/cloudflared.service` (or the drop-in the installed `cloudflared`
expects — check what `cloudflared service install` produced on the box
rather than inventing one); `docs/17` §2.4 (the tunnel, the Access layout,
the six bypass paths, and "if the consent POST is refused, the fix is not
in the CSRF check"); `docs/17` §4's line from ADR 0044; `docs/07` records
the Access applications; `docs/SMOKE_TESTS.md` gains the MCP section; ADR
0045 amendment recording the dashboard-behind-Access decision (controller
writes the ADR text).

### Task 4 — the live run (controller + owner)

`docs/reports/mcp-m6-live-run.md`, in the style of
`release1-smoke-tests-live-run.md`: from a client off the LAN, add the
connector, complete consent through Access, exercise every read tool, one
`send_message` to an allowlisted test channel, one refused send, revoke,
watch the next call fail; claude.ai connector, one read; Claude Code via
`claude mcp add --transport http`. Record what `Host` and `Origin` arrived
as. Run `doctor` and confirm the probe reports clean.

## Not in M6

Real client IPs in the session row (M6-D3). Defaulting `allowedMentions`
across the tree (M5-D2). Separating the systemd unit from the dev checkout —
worth doing, recorded in `docs/STATE.md`, not this slice.
