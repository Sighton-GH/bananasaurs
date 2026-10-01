# ADR 0118: MCP role changes and role panels

Status: accepted (2026-10-01; owner auto-approved MCP v2 slices on 2026-09-29)

Amends: ADR 0044 §4 ("the MCP connector never changes roles") for role grants, role removal, role creation and editing, and role-panel management only.
Spec: `docs/superpowers/specs/2026-09-29-mcp-connector-v2-design.md` §5.2, §6.1, §6.2 (owner decisions D1, D3, D8, D11).

## Decision

1. **One chokepoint, still.** Every MCP role change goes through
   `EffectGateway.applyRoleEffect` (ADR 0014), the only code that may call
   Discord's role API. The MCP does not edit `gateway.ts`. Instead the daemon
   builds a dedicated `EffectGateway` instance for MCP calls, with:
   - **`isRoleAllowlisted`** set to the MCP grant policy. In `below-bot` mode
     (the default) a role passes when it is below the bot, not managed, not
     `@everyone`, and not dangerous (`rolePingAllowed`'s rules with the grant
     mode). In `allowlist` mode it passes only with a `grant` row in
     `mcp_role_allowlist`. The gateway's own live hierarchy and managed checks
     (step 7) still run after this.
   - **`tripBreaker`** set to a no-op that logs. An MCP rate overflow refuses
     but never opens the guild breaker (M5-D12).
   - **Its own rate bucket**, under a new `EffectSource` value `mcp`.
   - **The standard protected-target and panel-status checks**, unchanged.
2. **Authorization.** The witness comes from `authorize` with actor
   `{ type: 'dashboard', id: <the token's account id> }` and capability
   `roles.mutate`. The MCP gets no new actor type and no implicit grant: an
   account without `roles.mutate` cannot change roles over MCP. Audit rows
   for these effects record `actor_type = 'mcp_operator'`.
3. **The dangerous-permission floor** (ADR 0117 §3) is checked live,
   immediately before each effect. A role that has gained a dangerous
   permission is refused even when allowlisted.
4. **Ledger and undo.** Each `grant_role` / `remove_role` call is one
   `mcp_actions` row in cap group `member_role`, run through `runMcpAction`.
   Its `execute` calls the MCP `EffectGateway`, with trigger ref
   `mcp:<actionId>` and batch id = the action id. Undo is the opposite effect,
   with key `undo:<actionId>`. The gateway's own `role_effects` dedupe stays
   underneath as a second idempotency layer.
5. **Bulk changes (D11): preview, confirm, durable job.**
   - **Preview:** a first call with no `confirmToken` resolves the member set
     live (an explicit list, or `{hasRoles, lacksRoles}`), caps it at 100,
     and stores a preview row in `mcp_bulk_previews` (migration `0093`). The
     row holds a random 128-bit token, the args hash, the resolved member ids,
     the role, the operation, and a 10-minute expiry. The call returns the
     count, the first 20 names, and the token.
   - **Confirm:** a second call with the token must match guild, args hash
     and expiry, and the token is single-use (`consumed_at`). It enqueues one
     durable job, `mcp.bulk_role`, whose payload carries the guild id and the
     preview id.
   - **The job:** it walks the stored member set through the MCP
     `EffectGateway`, one effect per member, resuming from a cursor. The
     member set is the one the owner previewed, never re-resolved.
   - **Why a stored preview and not an HMAC token:** no signing key to
     manage, and tampering is impossible because the token only names a row.
6. **Roles (D8).**
   - **`create_role`** sends permissions `0` and has no permissions parameter
     at all. It places the new role directly below the bot's highest role.
     Two new port methods do this: `createRole` and `setRolePosition`.
   - **`edit_role`** changes only name, colour and mentionable, and only for
     a role that passes the grant policy.
   - Both are in cap group `structure`. Neither can be undone, except that an
     `edit_role` records its previous values.
7. **Panels (D8)** go through the existing ops commands that the CLI and the
   dashboard share:
   - `panel create` writes the definition and allowlists its roles in
     `managed_roles`, as it does today;
   - `panel sync` publishes the panel.

   `edit_panel` and `delete_panel` add the missing ops commands (`panel edit`
   and `panel delete`), so all three surfaces share one path. A panel option
   may name an existing role, or ask for a new one with `{create:{name,
   colour}}`, which runs `create_role` first. Every panel role must pass the
   grant policy and the floor at creation time. Panel messages are protected
   from `edit_message` and `delete_message` (ADR 0116 §4). Panel actions are
   in cap group `structure`.
8. **Cap groups.** `mcp_actions.cap_group` becomes `message`, `edit`,
   `member_role` (1,000 per hour; a bulk job counts each member),
   `structure` (100; threads, polls, events, panels, role create/edit) and
   `pin_react`. Slice 3's `thread` group is renamed `structure` in migration
   `0092`, which has not been released.

## Consequences

- ADR 0044 §4's statement that "the MCP never changes roles" no longer
  holds. The MCP still never bans, kicks, times out, purges, or edits automod
  or role permissions.
- The moderation `EffectGateway` code is unchanged. Its behaviour for every
  other source is untouched, because the MCP policy is injected only into the
  MCP's own instance.
- One new `EffectSource` value (`mcp`), one migration (`0093_mcp_bulk_previews`),
  three new port methods (`createRole`, `setRolePosition`, `editRole`) and two
  new ops commands (`panel edit`, `panel delete`).
