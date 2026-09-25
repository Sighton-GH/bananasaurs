# 0078. Explained error bodies and one error catalog

Date: 2026-09-25

Status: accepted (owner request 2026-09-25)

## Context

The API answers every refusal with a bare slug (`{ "error": "bad-request" }`). The dashboard
turns a few of them into sentences (`REFUSAL_SENTENCES` in `packages/dashboard/src/api/ops.ts`,
five account codes). Everything else reaches the owner as the raw slug, or as "The request
failed". A 500 answers `{ "error": "internal" }`, and nothing ties it to the journal line that
explains it. On 2026-09-25 the owner asked for much better error codes and explanations
everywhere on the dashboard.

## Decision

1. **Codes stay.** The existing kebab-case slugs are the stable error codes. None is renamed,
   because the dashboard and the CLI branch on them.
2. **One catalog on the server.** `packages/http/src/errors/catalog.ts` maps every code to
   `{ title, explanation, hint? }`. A test scans `packages/http/src` for every
   `error: '<slug>'` literal and fails on a slug without an entry.
3. **Enriched bodies.** An `onSend` hook adds `title`, `message` (the catalog explanation when
   the route sent none) and `hint` to every JSON error body. It never overwrites a route's own
   `message`. Every error body carries `requestId` (Fastify's request id). The same id goes on
   the `request failed` log line.
4. **Validation detail without values.** A Zod failure answers `fields: [{ path, problem }]`,
   holding the issue path and the issue code only. Values are never echoed, because a value can
   be a key the owner just pasted.
5. **The dashboard renders, it does not translate.** `describeError(err)` reads the body, and
   `<ErrorNotice>` shows title, message, hint and a `code · status · request id` line. The
   dashboard's own sentence map is folded into the catalog and removed.

## Consequences

- A new route cannot ship an unexplained code without failing the suite.
- Error bodies grow by a few hundred bytes. No secrets are added: the catalog is static text,
  and `fields` carries paths only.
- The CLI keeps working unchanged: it reads `error` only.
