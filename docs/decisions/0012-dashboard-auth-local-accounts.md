# ADR 0012: Dashboard authentication is owner-provisioned local accounts

Status: accepted (2026-08-22)

## Context

The obvious design is Discord OAuth2 login: one integration gives identity, login, and live role membership, which is what the capability model in `docs/06` wants.

It is the wrong primary mechanism here. **Other members of the club server hold Discord Administrator.** Discord permissions therefore cannot be the gate on Bananasaurs' control plane — the dashboard exposes the archive, provider credentials, moderation history, purge, and the kill switch, and Administrator in Discord must not imply any of that. The owner has stated the dashboard should sit behind a login he sets.

## Decision

**Primary: local accounts created by the bot owner.**

- The owner provisions each account explicitly: username, password, and a capability set. There is no self-registration and no invite link.
- Passwords hashed with Argon2id. Sessions are signed, HTTP-only, `SameSite=Lax` cookies with a bounded lifetime and server-side revocation.
- The first-run bootstrap creates exactly one owner account from a one-time token printed to the console or the systemd journal, never a default password. The token expires, and the bootstrap path disables itself once used.
- TOTP two-factor is available and required for any account holding provider-credential or purge capability.
- Rate limiting and lockout on failed attempts. CSRF protection on every state-changing request. Re-authentication for destructive actions.
- Sessions are guild-scoped, as everything else is.

**Optional, later: Discord account linking.** An existing local account may link a Discord identity so the dashboard can resolve live role membership for the member-facing capability tiers. Linking never creates an account and never grants capability by itself — it only attaches an identity to an account the owner already made.

**Discord Administrator grants nothing in Bananasaurs.** Not dashboard access, not moderation capability, not archive visibility. Capability comes only from an owner-issued grant. `docs/07`'s "never infer privileges from a role's name" is extended: never infer privileges from a Discord permission bit either.

## Consequences

- The club's other administrators cannot reach the control plane, which is the point.
- Slightly more to build than OAuth: user CRUD, password reset by the owner, session management, TOTP. All of it is well-trodden and small.
- The owner is a single point of failure for dashboard access. Mitigation: the bootstrap path can be re-armed from the host by someone with shell access, which the owner already has. Document the recovery procedure and test it once.
- The future member-facing tier is reached primarily through Discord commands, not the dashboard, which keeps the dashboard's threat model small.
- Exposing the dashboard beyond LAN still requires Tailscale or Cloudflare Access per `docs/07`. Local accounts are the inner gate, not the only one.
