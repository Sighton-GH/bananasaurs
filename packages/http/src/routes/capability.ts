import type { FastifyReply } from 'fastify';
import { authorize, type Capability } from '@bananasaurs/core';
import { authzStoreFor } from '@bananasaurs/storage';
import type { SessionContext } from '../auth.js';

/**
 * The one place every dashboard route asks "is this session allowed to do
 * this" (`docs/decisions/0028-a-dashboard-account-is-a-principal.md`).
 *
 * Deliberately **not** folded into `RouteGuard`. `guard.require` answers "is
 * there a session and, for a write, did it carry a valid CSRF token" — two
 * checks with two failure statuses, 401 and 403-csrf. Capability is a third,
 * independent question with its own failure status, 403-no-grant, and a route
 * that got past the guard still has to ask it explicitly. Merging the two
 * would mean one function whose failure could be any of three things, which is
 * a worse signature for a caller to react to than two functions with one
 * failure mode each.
 *
 * `session.scope` and `session.guildId` and `session.actor` — never a
 * parameter from `request` — because those three are exactly what
 * `authenticate()` built from the row the database returned, and a route that
 * read any of them from the request would be trusting the caller to name its
 * own guild and identity.
 *
 * Answers the request itself (403) and returns `false` on denial, so the
 * calling route's `if (!requireCapability(...)) return reply;` reads the same
 * way `guard.require`'s `undefined` check does.
 */
export const requireCapability = (
  session: SessionContext,
  capability: Capability,
  reply: FastifyReply,
): boolean => {
  const result = authorize(
    { store: authzStoreFor(session.scope), guildId: session.guildId, actor: session.actor },
    capability,
  );
  if (!result.ok) {
    void reply.status(403).send({ error: 'no-grant' });
    return false;
  }
  return true;
};

/**
 * ADR 0129 §3: whether this session may see configuration-shaped text — the
 * prompt sections and the provider's short error message. The non-replying
 * `authorize` so a viewer without it still gets the run with the text
 * withheld, never a 403. Shared by the History and Conversations routes.
 */
export const canReadConfig = (session: SessionContext): boolean =>
  authorize(
    { store: authzStoreFor(session.scope), guildId: session.guildId, actor: session.actor },
    'config.read',
  ).ok;
