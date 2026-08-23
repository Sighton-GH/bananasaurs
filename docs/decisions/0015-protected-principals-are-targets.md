# ADR 0015: `protected` describes a target, not an actor

Status: accepted (2026-08-23), decided by Bryan at the WP2 boundary

Clarifies `docs/18_SAFETY_AND_BLAST_RADIUS.md` Layer 2 and corrects the ambiguous sentence in `docs/19_RELEASE_0_1_PLAN.md` §5.

## Context

`docs/18` Layer 2 introduces **protected principals** — members and roles the bot must not touch — without saying whether "must not touch" is a property of the thing being changed or of the thing asking.

`docs/19` states both readings in different places and never distinguishes them:

- §6.8, the effect gateway table: *"5. protected principal — `principals.protected` -> refuse"*, listed among checks against the role change being attempted.
- §5, the permission model: *"Protected principals are refused here regardless of grants"*, in a paragraph about what `authorize()` does to an actor.

WP2 implemented both, because both are written down. The second surfaced by failing its own test: marking the *acting* member protected denied them capability before the target check ever ran, so the test could not even construct a witness.

That is a coherent anti-nuke posture — a compromised privileged role is inert the moment it is flagged, without anyone hunting down its grants. It is also a serious footgun: **protecting the role you administer the bot through locks you out of the bot.** A safety flag whose misuse causes an outage is a safety flag people stop setting.

## Decision

**`protected` means exactly one thing: the bot will not mutate this member or this role, whoever asks.**

- The check lives in the effect gateway, step 6, against `intent.userId` and `intent.roleId`. Implemented by `isTargetProtected` in `packages/storage/src/repos/authz.ts`.
- `authorize()` does **not** consult `protected`. The `anyProtected` method is removed from the `AuthzStore` port rather than left unused, so there is no dormant surface for someone to wire back up by accident.
- `DenialReason` no longer carries `'protected-principal'`, because nothing produces it.

The anti-nuke property is not abandoned; it is provided by the mechanism already designed for it. ADR 0012 means Discord Administrator grants nothing, so a compromised privileged role holds no capability unless someone explicitly granted it — and `revokeCapability` removes that in one call. Disarming a compromised principal is an explicit act with an audit row, rather than a side effect of a flag whose primary meaning is something else.

## Consequences

**A protected principal can still drive the bot** if it holds a grant. Disarming it is a separate, deliberate action. That is one more step during an incident, and it is the trade accepted here.

**A regression is a failing test, not a review note.** `apps/daemon/src/effects.integration.test.ts` asserts that a protected actor still authorizes *and* still successfully changes another member's roles. Re-adding the actor-side check fails it. Verified by mutation at the time of writing.

**`docs/19` §5 is corrected in place.** The sentence describing `authorize()` as refusing protected principals no longer matches the code and would otherwise mislead the next person to read it.

**If the anti-nuke posture is wanted later**, it should be its own flag with its own name — `disarmed`, say — rather than an overload of `protected`. The two questions ("may the bot change this?" and "may this drive the bot?") have different answers for different principals, and one column cannot carry both without exactly the confusion this ADR resolves.
