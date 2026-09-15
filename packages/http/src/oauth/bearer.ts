import type { FastifyReply, FastifyRequest } from 'fastify';
import type { GuildId, Logger } from '@bananasaurs/core';
import { oauthRepo } from '@bananasaurs/storage';
import { hashToken } from '../secrets.js';
import { verifyAccessToken, type OAuthDeps, type OAuthScope } from './provider.js';
import { reachableGuilds } from './reachable.js';

export interface BearerPrincipal {
  readonly accountId: string;
  readonly clientId: string;
  readonly tokenId: string;
  readonly scopes: readonly OAuthScope[];
  /** ADR 0045 PR-92: computed on THIS request from the account's current grants. */
  readonly reachableGuilds: readonly GuildId[];
}

/**
 * The RFC 9728 challenge every unauthenticated `/mcp` request receives. The
 * `resource_metadata` URL is how a Claude client discovers where to start
 * the OAuth flow, so it must point at the document Task 4 serves.
 */
export const wwwAuthenticateFor = (mcpPublicUrl: string): string =>
  `Bearer resource_metadata="${mcpPublicUrl}/.well-known/oauth-protected-resource"`;

/** RFC 6750 §3: the scheme is case-insensitive. No `g` flag — this is stateless. */
const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

const unauthorized = (mcpPublicUrl: string, reply: FastifyReply): undefined => {
  void reply
    .status(401)
    .header('WWW-Authenticate', wwwAuthenticateFor(mcpPublicUrl))
    .send({ error: 'invalid_token' });
  return undefined;
};

/**
 * Verifies the `Authorization` header of one request and attaches the
 * principal, or answers 401 with the RFC 9728 challenge and returns
 * `undefined`. Mirrors `RouteGuard.require`'s "answers the reply itself,
 * returns undefined on refusal" contract so a route reads
 * `const p = requireBearer(...); if (p === undefined) return reply;`.
 *
 * Every call does a fresh `verifyAccessToken` and a fresh
 * `reachableGuilds`. Nothing here is memoised, and nothing may be added
 * that is.
 */
export const requireBearer = (
  deps: OAuthDeps & { readonly mcpPublicUrl: string; readonly logger: Logger },
  request: FastifyRequest,
  reply: FastifyReply,
): BearerPrincipal | undefined => {
  const header = request.headers.authorization;
  const raw =
    typeof header === 'string' ? (BEARER_PATTERN.exec(header)?.[1] ?? undefined) : undefined;
  if (raw === undefined) return unauthorized(deps.mcpPublicUrl, reply);
  const verified = verifyAccessToken(deps, raw);
  if (!verified.ok) {
    // The reason is not exposed in the response — "revoked" versus "expired"
    // versus "unknown" is an oracle. It IS logged, with the token id and
    // never the value, but only when the reason is one of `revoked`,
    // `account-gone`, `account-disabled`: a token that *was* valid being
    // presented after it stopped being is worth a line; a random unknown
    // string is not, and would let anyone fill the log.
    if (
      verified.reason === 'revoked' ||
      verified.reason === 'account-gone' ||
      verified.reason === 'account-disabled'
    ) {
      const row = oauthRepo.findTokenByHash(deps.scopes.instance(), hashToken(raw));
      if (row !== undefined) {
        deps.logger.info(
          { component: 'http', oauthTokenId: row.tokenId, reason: verified.reason },
          'oauth bearer refused',
        );
      }
    }
    return unauthorized(deps.mcpPublicUrl, reply);
  }
  return {
    accountId: verified.accountId,
    clientId: verified.clientId,
    tokenId: verified.tokenId,
    scopes: verified.scopes,
    reachableGuilds: reachableGuilds(deps, verified.accountId),
  };
};
