# 0080. AI tuning: owner-edited instance settings

Date: 2026-09-25

Status: accepted (owner request 2026-09-25)

## Context

Retry delays (10 s, 30 s, 90 s), the provider timeout (30 s), tool-loop limits, the resource
fetch timeout (5 s) and the hourly refresh are hard-coded constants. Changing any of them is a
code change plus a deploy. The 2026-09-25 outage also showed that Node's 250 ms Happy Eyeballs
per-address wait is too short behind a far VPN exit. The owner asked for a page to tune these,
kept inside the Assistant group of the dashboard.

## Decision

1. New instance table `instance_settings (key, value_json, updated_at, updated_by)`. Settings
   govern the one process, not a guild, like the provider keys and model chain (ADR 0075).
2. A typed registry, `packages/core/src/settings/instance-settings.ts`, defines each setting's
   key, group, label, help, unit, Zod schema and default. **Defaults equal today's constants**,
   so a deploy changes nothing until the owner edits a value. The one exception is the connect
   wait, which defaults to 1000 ms.
3. The daemon reads settings through a cached store; a write invalidates the cache. Every use
   reads the effective value, so edits apply without a restart. Every write is audited
   (`instance_setting.changed`, key plus old and new value). The sealed header value is recorded
   only as `changed`.
4. Settings (bounds in the registry):
   - **Assistant:** retry delays (0–4 delays, each 1 s–3 min, total ≤ 3 min; owner, 2026-09-25),
     provider request timeout, max tool rounds, max tool calls, max output tokens.
   - **Network:** connect fallback wait, applied with
     `net.setDefaultAutoSelectFamilyAttemptTimeout` at startup and on change.
   - **Resources:** fetch timeout, refresh interval, and an optional fetch header (name, sealed
     value, host allowlist). The header lets a site owner add a Cloudflare WAF Skip rule for
     Bananasaurs. It is sent only to the listed hosts, only by the website resource fetcher.
     Nothing here solves or evades a bot challenge.
5. Page **Assistant → AI tuning**, owner only. `/api/session` gains `instanceOwner`, so the nav
   hides the entry for everyone else, and the API answers `owner-only` regardless.

## Consequences

- The retry ceiling (`delays + 1 ≤ 5`) stays within the job store's default `maxAttempts`, so
  the enqueue sites are unchanged.
- The general job backoff (1 s → 5 min) is deliberately not exposed: it governs Discord side
  effects on the moderation path.
