# Security, privacy, and operations

## Trust boundaries

Discord content, fetched web pages, resource repositories, attachments, model output, and imported archives are untrusted data. None may override system instructions, permissions, or tool policy. Treat retrieved text as evidence, never instructions.

## Required controls

- Guild, channel, principal, and command authorization enforced server-side.
- **Discord Administrator grants nothing in Bananasaurs.** Other members of the reference guild hold Administrator; Discord permission bits must not imply dashboard access, moderation capability, or archive visibility. Capability comes only from an owner-issued grant (ADR 0012). Never infer privilege from a role's name, and never from a permission bit.
- Dashboard authentication is owner-provisioned local accounts: Argon2id password hashing, signed HTTP-only session cookies, a one-time bootstrap token that expires and disables itself, TOTP required for provider-credential and purge capabilities, lockout on failed attempts, and re-authentication for destructive actions (ADR 0012).
- Minimum Discord intents and permissions; enable message-content access only where needed and currently permitted.
- DM responses use the deterministic help/FAQ path by default. DM AI requires explicit per-user and per-guild authorization, rate/cost limits, an unambiguous guild selection, and normal server permission checks.
- CSRF/session protection, secure cookies, rate limits, and reauthentication for sensitive dashboard actions.
- Secrets from environment or a dedicated secret store, never database exports, logs, or diagnostics bundles. On the Mint host this means a root-owned `.env` at mode 0600 loaded through systemd `EnvironmentFile=`, owned by a non-login service account. Pino redaction is an allowlist, not a denylist.
- Prompt-injection defence is a mechanism, not a policy statement: (a) all retrieved content is wrapped in a delimited, labelled envelope with a fixed preamble; (b) a turn whose only new input is retrieved text may not emit a tool call — tool calls require user intent in the current turn; (c) at least three injection cases live in the golden question set, and a cross-guild disclosure or unauthorized retrieval is release-blocking.
- Citations leak existence. Permission-filter the citation and source list, not only the content, or an answer can reveal that a message exists in a channel the asker cannot see.
- SSRF defenses for resource fetching: allow HTTP(S), resolve and block private/link-local targets unless explicitly trusted, limit redirects/size/time, and sandbox parsing.
- Attachment type/size policy and safe content handling.
- Audit authorization changes, purges, provider configuration, instruction changes, and tool effects.
- Enforce Discord role hierarchy, protected principals/roles, action-specific permissions, and bot capability checks immediately before every moderation side effect.
- Keep a durable before/after record for role and permission mutations so safe reversal is possible.
- Provide a local owner kill switch for automod actions and an AI-off mode that leaves moderation operational.
- Default new automod rules to test or observe-only mode. Rate-limit mass actions and require stronger confirmation for ban waves, bulk role changes, or lockdown.
- Prevent guild-scope omission at repository/API boundaries and test cross-guild access as a critical security failure.
- Treat indefinite retention and sub-10 MB attachment ingestion as owner-selected defaults: show storage growth, scan/validate content types, block executable parsing, and provide purge/export controls.
- Represent Discord deletions with protected tombstones while retaining archived content under the selected permanent policy. Exclude tombstoned content from normal member retrieval and require explicit archive/moderation capability to inspect it.
- Never infer privileges from a role’s name. Resolve live Discord role membership against owner-configured capability grants and re-check sensitive permissions at action time.

## Network exposure

- LAN: bind deliberately; do not assume a private subnet is trusted.
- Tailscale: preferred remote administrative path with identity-aware access where available.
- Cloudflare Tunnel: acceptable when protected by Cloudflare Access; never publish the owner dashboard unauthenticated.
- TLS and proxy headers must be configured intentionally.

## Deployment and recovery

Use least-privileged service accounts, restart policies, health checks, log rotation, database migrations, encrypted backups where practical, and a documented restore drill. Configuration export must omit secrets. Updates should support rollback of both application and schema when reasonably possible.

The public release remains self-hosted. No central Bananasaurs service receives guild content, credentials, analytics, crash reports, or update telemetry unless the operator explicitly opts in to a separately documented feature.

## Incident behavior

On credential suspicion: disable the affected provider/bot token, rotate it, inspect audit events, and invalidate sessions. On permission uncertainty or storage corruption, fail closed for retrieval and assistant responses rather than risk disclosure.

On moderation-module failure: stop new automated punishments, preserve the event/audit queue, keep explicit staff commands available only when their permission and storage checks pass, and surface a prominent dashboard alert.
