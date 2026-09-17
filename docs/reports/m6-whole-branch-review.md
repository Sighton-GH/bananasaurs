# Slice M6 — whole-branch review

**Branch:** `oc/m6-tunnel-access`, 14 commits off `main` at `96703c3`, reviewed
in the worktree `.oc-worktrees/oc/m6-tunnel-access`.
**Date:** 2026-09-17. **Reviewer:** Claude (Opus 5), read-only.
**Verdict: SHIP-WITH-FIXES.** Two Important findings, both in the probe's
classification, neither of which makes an exposed dashboard read as `ok`
on its own. No Critical.

## Gates (worktree only, one at a time)

| Gate | Exit | Count |
|---|---|---|
| `npm run typecheck` | 0 | 0 `error TS` |
| `npm run lint` | 0 | eslint clean; "All matched files use Prettier code style!" |
| `npm run test` | 0 | 174 files, 3,336 tests passed, 66s |

Nothing was built or typechecked in the main checkout.

## Constraint check

`git diff 96703c3..HEAD --stat` over `packages/core/src/mod/`,
`packages/core/src/automod/`, `packages/core/src/effects/gateway.ts`,
`apps/daemon/src/runtime/daemon.ts`, `drizzle/`, `packages/storage/src/schema.ts`
is **empty**. `mod_rules` and `setRuleMode` appear in no changed file.
`trustProxy` appears in the diff only inside comments
(`packages/http/src/server.ts`, `server.test.ts`, docs) — the Fastify option is
untouched. The `docs/decisions/0045-*` "66 deletions" in the branch diff
against `main` HEAD is only Amendment 5 landing on `main` after the fork; the
merge-base diff touches only ADR 0029 (+14).

## What I ran (evidence)

1. **Fake-fetch drive of `probePublicSurface`** — 34 scenarios from
   `/tmp/m6rev/fool.mts` via `npx tsx`, covering every "can it be fooled"
   shape in the brief. Result: every exposed shape is red. Specifically:
   `/` 200 with no content type → `unexpected`; 200 `application/octet-stream`
   → `unexpected`; 302 to a relative `/login` → `unexpected`; 302 to
   `evil.example` → `unexpected`; `Location` host
   `x.cloudflareaccess.com.evil.net` → `unexpected`; bare
   `cloudflareaccess.com` → `unexpected`; userinfo trick
   `a.cloudflareaccess.com@evil.net` → parsed host `evil.net` → `unexpected`;
   non-default port `a.cloudflareaccess.com:8443` → `unexpected`; well-known
   JSON without `issuer` / with a numeric `issuer` / with `text/plain` →
   `unexpected`; `/mcp` 401 without the challenge, with a `Basic` challenge,
   or a 200 → `unexpected`; `/mcp` 404 → `not-published`. A body containing a
   marker string never appears in `formatPublicSurface` output or in
   `JSON.stringify(report)`. **One shape reads `ok` that should not:** `/`
   answering a bare `403` from anything (Important 1 below).
2. **Real `fetch` against the live hostname** (`/tmp/m6rev/live.mts`, status,
   content type and `Location` host printed only): all five rows return
   `302 → sighton.cloudflareaccess.com`; the probe reports the three dashboard
   rows `ok` and both machine rows `blocked-by-access`, `ok=false`, in 139 ms.
   That is exactly the "too wide" state the controller described, caught by
   the real module with the real fetch.
3. **`curl -D - -o /dev/null`** on eight paths with `accept: text/html`, and
   on the two machine paths with `accept: application/json`: every one is a
   302 to `sighton.cloudflareaccess.com`, with
   `www-authenticate: Cloudflare-Access resource_metadata="…"`. Access never
   answered 403 to either accept type. An unknown path also 302s (no edge
   404 in the current layout).
4. **Hung-fetch timeout with the real `fetch`** (`/tmp/m6rev/hang.mts`, a
   loopback `http.Server` that sends headers then never ends the body on `/`,
   and never answers at all on the other rows): with `timeoutMs: 300` all
   five rows are `unreachable` in 1,510 ms. So `AbortSignal.timeout` aborts
   both the connect and the `text()` read; nothing hangs.
5. **Composition, by reading:** `apps/daemon/src/runtime/daemon.ts:152` builds
   `ctx.instance` from `opsInstanceFor`; `apps/daemon/src/ops/wiring.ts`
   `probePublicSurface` calls the module with `deps.config.MCP_PUBLIC_URL` and
   `globalThis.fetch`; `packages/core/src/ops/dispatch.ts:314` awaits
   `run.result`; `reads.ts` awaits the probe and ANDs `surface.ok` into `ok`.
   `apps/daemon/src/index.ts` `runDoctor` uses the same module, same config
   key, same fetch, and exits 1 on `!surface.ok`. Only two `set-cookie`
   writers exist in `packages/http/src/server.ts` (lines 127, 138), both go
   through `forwardedProtoIsHttps`; `/api/login`, `/api/logout`, the guard's
   401 clear and `/api/bootstrap` all pass `request`. `MCP_PUBLIC_URL` is
   schema-constrained to a bare `https://` origin (or a `127.0.0.1` dev
   origin), and every probe URL is `${base}${path}` — hard rule 8 holds.

## Findings

### Important

**I-1. A bare `403` on a dashboard row is accepted as "Access", with no
evidence it came from Access.** `classifyDashboardPath` returns `ok` on
`accessRedirect() || status === 403`. Fake-fetch: `/` → 403 from the app →
whole report `OK`. Nothing in the app 403s a GET on `/`, `/api/session` or
`/oauth/authorize`, but Cloudflare itself does: a WAF rule, Bot Fight Mode or
a managed challenge answers 403 to a non-browser client. In that state the
dashboard rows read "protected" whether or not an Access policy exists. The
live evidence says the branch is being generous for nothing: with **either**
accept header and no cookie, Access answers `302`, never `403`. Fix: drop
`status === 403` from the dashboard-row `ok` path (make it `unexpected`), or
require an Access signature on a 403 — the live responses carry
`www-authenticate: Cloudflare-Access …`, and a WAF challenge carries
`cf-mitigated: challenge`. On the machine rows a bare 403 → `blocked-by-access`
is a misdiagnosis for the same reason; `unexpected` with the status is more
honest. One-line change plus flipping the two "ok on a 403" tests.

**I-2. The probe's worst case is 25 s inside a 30 s CLI socket timeout.**
`DEFAULT_PROBE_TIMEOUT_MS = 5_000` per row, five rows, sequential (the hang
test shows the bound is linear). `packages/cli/src/client.ts:58` sets
`DEFAULT_TIMEOUT_MS = 30_000` (ADR 0026), and `doctor` does Discord and
archive reads before the probe. If the edge is *hanging* rather than
refusing, `bananasaurs doctor` becomes a CLI timeout with no report at all,
instead of five `unreachable` rows under `PROBLEMS FOUND`. Not silent-green,
so not Critical, but the failure the probe exists to report is the one it
cannot deliver. Fix: one shared deadline across the five rows (e.g. a single
`AbortSignal.timeout(10_000)` passed to every fetch), or a 2 s per-row
default. Keep sequential.

### Minor

**M-1. A relative `Location` renders as `location placeholder.invalid`.**
`hostOf` resolves against `https://placeholder.invalid`, so `/login` yields
that host; the doc comment says "undefined for a relative value". Fake-fetch:
`/ 302 → /login` renders `observed status 302, text/html, location
placeholder.invalid — unexpected`. Classification is right; the operator
line is fiction. Fix: `URL.canParse(location) ? new URL(location).host : undefined`.

**M-2. The daemon-side composition is tested only for the unset branch.**
`apps/daemon/src/ops/wiring.test.ts` proves `probed: false` when
`MCP_PUBLIC_URL` is unset; the `reads.test.ts` conjunction test injects a
fake `probePublicSurface`. The real-fetch path is proven here by my live run
of the module, not by the suite, and the ten-line mapping in `wiring.ts` is
read, not run. Acceptable given Task 4 step 1 runs the composed `doctor`
against the live hostname; if you want it in-suite, inject `fetch` through
`OpsInstanceDeps` and point it at a loopback server.

**M-3. A `127.0.0.1` dev origin makes `doctor` permanently red.** The schema
admits `http://127.0.0.1:<port>` for `MCP_PUBLIC_URL`; the probe would then
hit the app directly and report three `exposed` rows every time. Either skip
the probe for a loopback base (rendering "not probed (loopback origin)") or
say in `docs/17` that a dev origin is expected to fail this block.

**M-4. Plan text vs behaviour.** M6-D1's "Cost if wrong" says the probe runs
"at startup and on every `doctor`". It runs in `--doctor` and in the `doctor`
command; the daemon's on-ready report (`runtime/daemon.ts`, untouchable) does
not probe. ADR 0045 A5-2 and `docs/17` §2.4 say `doctor`, which matches.
Amend the plan line.

**M-5. `X-Forwarded-Proto` is matched exactly.** `https, http` (a proxy
chain) would read as not-HTTPS. Cloudflare sends a single value, so this is
a note, not a bug; the direction of failure is non-`Secure`, i.e. the old
behaviour.

**M-6. The live run should record `Secure` on the tunnel path.** Task 4
records `Host` and `Origin`; it does not check that the `Set-Cookie` from
`/api/login` through the tunnel carries `Secure`. That is the only way to
confirm cloudflared actually delivers `X-Forwarded-Proto: https` — the branch
asserts it in `docs/17` ("which the tunnel sets") without evidence. Add
"devtools → Set-Cookie contains `Secure`" to step 3 of Section D.

**M-7. Well-known path-suffix variants.** Some MCP clients first try
`/.well-known/oauth-protected-resource/mcp` and
`/.well-known/oauth-authorization-server/mcp` (RFC 8414 path-insertion) before
the bare documents. Whether the Bypass application on
`bananasaurs.sighton.ca/.well-known/oauth-protected-resource` matches that
subpath is a Cloudflare matching question I could not confirm from docs. The
app 404s those variants, which clients fall back from; an Access 302 → HTML
login page is the shape to watch for in the live run. If it bites, a Bypass
on `/.well-known/*` widens nothing (only two routes exist under it).

**M-8. `301`/`308` to `*.cloudflareaccess.com` are `unexpected`, not `ok`.**
Conservative and fine (Access uses 302); mentioning so nobody "fixes" it into
a looser check later.

## The cookie, both directions

Tests in `packages/http/src/server.test.ts` cover: login without the header →
no `Secure`; with `x-forwarded-proto: https` → `; Secure;`; logout clear
matches in both cases. The guard's 401 clear and `/api/bootstrap` reuse the
same helpers. A spoofed header on loopback yields a `Secure` cookie the
browser drops and a bounced login — nothing authorises on the header, and
`SameSite=Lax`, `HttpOnly`, `Path=/` and `Max-Age` are unchanged in both
branches. The Access login round-trip ends in a top-level GET, so `Lax` still
sends the cookie. No finding.

## Rulings

- **M6-D1 (probe, both directions):** correct and necessary; the live run
  today shows it catching the too-wide state. Tighten per I-1/I-2.
- **M6-D2 (`Secure` iff `X-Forwarded-Proto: https`):** agree. One header,
  one attribute, fails toward the old behaviour.
- **M6-D3 (`trustProxy` stays off):** contested and held. Turning it on would
  change `request.ip` for the OAuth limiter reasoning at `routes/oauth.ts:140`
  and buy nothing this slice consumes. Revisit only if session-row IPs are
  wanted.
- **M6-D4 (whole origin, no `Host` rewrite):** agree; not verifiable from
  inside — the live run's `Host`/`Origin` record is the evidence.
- **M6-D5 (six-path Bypass set):** the set is right. `/oauth/authorize` is
  correctly excluded — the client never calls it; the browser does, carrying
  the Access cookie, and Access preserves the query string through login.
  `/api/bootstrap` (and the SPA `/bootstrap`) are correctly behind Access:
  human paths, extra layer, no client involved. `/mcp` GET/POST/DELETE share
  the one path. Watch M-7.
- **M6-D6 (voice/stage channels accepted):** agree; pinned by a test in
  `apps/daemon/src/ops/wiring.test.ts`.

## M5 Minors

N1 wording + voice-channel pin: done. N2: pinned with a test naming the gap
rather than closed in `test-support.ts`; the reasoning (no `Client` under ADR
0014, no dashboard route reaches `allowSendChannel`, send-time C2 contains
any stray row) holds. N3: `channel-not-in-guild` is a distinct union member
and text; the daemon mapping is now 1:1 and typechecks. N4: rendering only,
no migration, note line present.

## Ship list

1. I-1: bare 403 is not Access — make it `unexpected` on all rows (or
   require the `Cloudflare-Access` challenge header), flip the two tests.
2. I-2: bound the whole probe to well under the CLI's 30 s.
3. M-1: relative `Location` → `undefined`, not `placeholder.invalid`.
4. M-6: add the `Secure` check to Section D step 3 and the live-run template.
5. M-3/M-4: one doc line each.
