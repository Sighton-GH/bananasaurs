import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { oauthRepo } from '@bananasaurs/storage';
import { originMatchesHost, type HttpDeps, type RouteGuard } from '../server.js';
import { hashToken, secretsMatch } from '../secrets.js';
import { verifyAccountCredentials } from '../auth.js';
import {
  beginAuthorization,
  completeAuthorization,
  exchangeCode,
  refreshTokens,
  revokeByValue,
  OAUTH_SCOPES,
  type OAuthDeps,
  type OAuthFailure,
} from '../oauth/provider.js';
import { isAllowedRedirectUri } from '../oauth/redirect-uri.js';
import { renderConsentPage, renderErrorPage } from '../oauth/consent.js';
import { reachableGuilds } from '../oauth/reachable.js';
import { createRateLimiter } from '../oauth/rate-limit.js';

/**
 * The OAuth 2.1 authorization server (ADR 0045 D1): the two metadata
 * documents, authorize, token, register and revoke as native Fastify routes
 * with Zod at every boundary, implemented against Task 3's provider.
 *
 * Reads no cookie on any route — the consent page borrows the dashboard's
 * password verifier (ADR 0045 D6), never its session. A raw token, code or
 * nonce never appears in a log line, an error message, or a response body,
 * except the token response (tokens), the consent page (the nonce, in a
 * hidden input), and the redirect back to the client (the code, in the query
 * string — that is the protocol).
 */

const authorizeQuerySchema = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  response_type: z.string(),
  code_challenge: z.string().min(1),
  code_challenge_method: z.string(),
  scope: z.string(),
  state: z.string().optional(),
});

const authorizeFormSchema = z.object({
  requestId: z.string(),
  nonce: z.string(),
  username: z.string(),
  password: z.string(),
  decision: z.enum(['approve', 'deny']),
});

const tokenBaseSchema = z.object({ grant_type: z.string() });

const authorizationCodeGrantSchema = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string().min(1),
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  code_verifier: z.string().min(1),
});

const refreshTokenGrantSchema = z.object({
  grant_type: z.literal('refresh_token'),
  refresh_token: z.string().min(1),
  client_id: z.string().min(1),
});

const registerBodySchema = z.object({
  client_name: z.string().min(1).max(200),
  redirect_uris: z.array(z.string()).min(1).max(10),
  token_endpoint_auth_method: z.literal('none').optional(),
});

const revokeBodySchema = z.object({
  token: z.string(),
  client_id: z.string(),
});

/** Sends an HTML error page with the consent page's own headers. */
const htmlError = (reply: FastifyReply, status: number, message: string): void => {
  void reply
    .status(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('content-security-policy', "default-src 'none'")
    .header('cache-control', 'no-store')
    .send(renderErrorPage(message));
};

const tokenFailure = (reply: FastifyReply, failure: OAuthFailure): FastifyReply => {
  const status = failure.error === 'invalid_client' ? 401 : 400;
  return reply
    .status(status)
    .send({ error: failure.error, error_description: failure.description });
};

const redirectWith = (base: string, params: Record<string, string>): string => {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
};

export const registerOAuthRoutes = (
  app: FastifyInstance,
  guard: RouteGuard,
  deps: HttpDeps,
): void => {
  // Accepted for signature symmetry with the other route modules and
  // deliberately not used: these routes are not dashboard-session routes.
  void guard;

  // Ruling PR-116: without a public origin there is nothing truthful for the
  // metadata documents to say, so a daemon that has not opted in exposes no
  // authorization endpoints at all.
  const issuer = deps.mcpPublicUrl;
  if (issuer === undefined) return;

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 8 * 1024 },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err instanceof Error ? err : new Error('bad form body'), undefined);
      }
    },
  );

  // Ruling PR-97: behind the tunnel every request arrives from 127.0.0.1 and
  // trustProxy is not set, so an IP key would be one global bucket wearing a
  // disguise. This is one global bucket, said plainly. A stranger can exhaust
  // the hour; a registered client can do nothing until the owner types a
  // password at the consent page, and `mcp revoke-client` removes the junk.
  const registerLimiter = createRateLimiter({
    limit: 20,
    windowMs: 3_600_000,
    now: deps.now,
  });

  const oauthDeps: OAuthDeps = { scopes: deps.scopes, now: deps.now, guildIds: deps.guildIds };

  app.get('/.well-known/oauth-authorization-server', (_request, reply) => {
    return reply.status(200).send({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [...OAUTH_SCOPES],
    });
  });

  app.get('/.well-known/oauth-protected-resource', (_request, reply) => {
    return reply.status(200).send({
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      scopes_supported: [...OAUTH_SCOPES],
      bearer_methods_supported: ['header'],
    });
  });

  app.get('/oauth/authorize', (request, reply) => {
    const parsed = authorizeQuerySchema.safeParse(request.query);
    if (!parsed.success || parsed.data.response_type !== 'code') {
      // Never a redirect to an unvalidated `redirect_uri`: the failure is
      // rendered here, and the error code is named, not the URI.
      htmlError(reply, 200, 'invalid_request: the authorization request is malformed');
      return reply;
    }
    const result = beginAuthorization(oauthDeps, {
      clientId: parsed.data.client_id,
      redirectUri: parsed.data.redirect_uri,
      codeChallenge: parsed.data.code_challenge,
      codeChallengeMethod: parsed.data.code_challenge_method,
      scope: parsed.data.scope,
      state: parsed.data.state ?? null,
    });
    if (!result.ok) {
      htmlError(reply, 200, `${result.error}: ${result.description}`);
      return reply;
    }
    return reply
      .status(200)
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy', "default-src 'none'")
      .header('cache-control', 'no-store')
      .send(
        renderConsentPage({
          clientName: result.client.clientName,
          redirectUriHost: result.redirectUriHost,
          scopes: result.scopes,
          requestId: result.requestId,
          nonce: result.nonce,
        }),
      );
  });

  app.post('/oauth/authorize', async (request, reply) => {
    if (!originMatchesHost(request)) {
      htmlError(reply, 403, 'forbidden: the request origin does not match this server');
      return reply;
    }
    const parsed = authorizeFormSchema.safeParse(request.body);
    if (!parsed.success) {
      htmlError(reply, 400, 'invalid_request: the authorization form is malformed');
      return reply;
    }
    const instance = deps.scopes.instance();
    const now = deps.now();

    if (parsed.data.decision === 'deny') {
      // Consumed, not completed: the pending row must not stay spendable, and
      // there is deliberately no approval for the client to exchange.
      const row = oauthRepo.consumePendingAuthorization(instance, parsed.data.requestId, now);
      if (row === undefined) {
        htmlError(reply, 400, 'invalid_grant: the authorization request is unknown or expired');
        return reply;
      }
      if (!secretsMatch(hashToken(parsed.data.nonce), row.nonceHash)) {
        htmlError(reply, 400, 'invalid_grant: the authorization request does not match');
        return reply;
      }
      const params: Record<string, string> = { error: 'access_denied' };
      if (row.state !== null) params.state = row.state;
      return reply.redirect(redirectWith(row.redirectUri, params));
    }

    const checked = await verifyAccountCredentials(deps, {
      username: parsed.data.username,
      password: parsed.data.password,
      ip: request.ip ?? null,
    });
    if (!checked.ok) {
      // The pending row stays unconsumed, so the owner can resubmit the same
      // form once with the right password.
      htmlError(reply, 200, 'sign-in failed; start the authorization again from your client');
      return reply;
    }
    // Refusal (f): minting requires `mcp.authorize` in at least one guild the
    // account can reach, checked live — never stored, never frozen (PR-92).
    if (reachableGuilds(oauthDeps, checked.account.accountId).length === 0) {
      htmlError(
        reply,
        403,
        'no-grant: this account holds mcp.authorize in no guild this server serves',
      );
      return reply;
    }
    const done = completeAuthorization(oauthDeps, {
      requestId: parsed.data.requestId,
      nonce: parsed.data.nonce,
      accountId: checked.account.accountId,
    });
    if (!done.ok) {
      htmlError(reply, 400, `${done.error}: ${done.description}`);
      return reply;
    }
    deps.logger.info({ component: 'http' }, 'oauth authorization completed');
    const params: Record<string, string> = { code: done.code };
    if (done.state !== null) params.state = done.state;
    return reply.redirect(redirectWith(done.redirectUri, params));
  });

  app.post('/oauth/token', async (request, reply) => {
    const base = tokenBaseSchema.safeParse(request.body);
    if (!base.success) {
      return tokenFailure(reply, {
        ok: false,
        error: 'invalid_request',
        description: 'grant_type is required',
      });
    }
    if (base.data.grant_type === 'authorization_code') {
      const parsed = authorizationCodeGrantSchema.safeParse(request.body);
      if (!parsed.success) {
        return tokenFailure(reply, {
          ok: false,
          error: 'invalid_request',
          description: 'the authorization_code grant is malformed',
        });
      }
      const issued = exchangeCode(oauthDeps, {
        code: parsed.data.code,
        clientId: parsed.data.client_id,
        redirectUri: parsed.data.redirect_uri,
        codeVerifier: parsed.data.code_verifier,
      });
      if (!issued.ok) return tokenFailure(reply, issued);
      deps.logger.info(
        {
          component: 'http',
          oauthClientId: parsed.data.client_id,
          oauthTokenId: issued.accessTokenId,
        },
        'oauth code exchanged',
      );
      return reply
        .status(200)
        .header('cache-control', 'no-store')
        .header('pragma', 'no-cache')
        .send({
          access_token: issued.accessToken,
          refresh_token: issued.refreshToken,
          token_type: 'Bearer',
          expires_in: issued.expiresInSeconds,
          scope: issued.scopes.join(' '),
        });
    }
    if (base.data.grant_type === 'refresh_token') {
      const parsed = refreshTokenGrantSchema.safeParse(request.body);
      if (!parsed.success) {
        return tokenFailure(reply, {
          ok: false,
          error: 'invalid_request',
          description: 'the refresh_token grant is malformed',
        });
      }
      const issued = refreshTokens(oauthDeps, {
        refreshToken: parsed.data.refresh_token,
        clientId: parsed.data.client_id,
      });
      if (!issued.ok) return tokenFailure(reply, issued);
      deps.logger.info(
        {
          component: 'http',
          oauthClientId: parsed.data.client_id,
          oauthTokenId: issued.accessTokenId,
        },
        'oauth token refreshed',
      );
      return reply
        .status(200)
        .header('cache-control', 'no-store')
        .header('pragma', 'no-cache')
        .send({
          access_token: issued.accessToken,
          refresh_token: issued.refreshToken,
          token_type: 'Bearer',
          expires_in: issued.expiresInSeconds,
          scope: issued.scopes.join(' '),
        });
    }
    return tokenFailure(reply, {
      ok: false,
      error: 'unsupported_grant_type',
      description: 'only authorization_code and refresh_token are supported',
    });
  });

  app.post('/oauth/register', (request, reply) => {
    if (!registerLimiter.check('register')) {
      return reply.status(429).send({ error: 'too_many_requests' });
    }
    const parsed = registerBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request' });
    }
    for (const uri of parsed.data.redirect_uris) {
      if (!isAllowedRedirectUri(uri)) {
        return reply.status(400).send({ error: 'invalid_redirect_uri' });
      }
    }
    const clientId = `cli_${randomBytes(16).toString('hex')}`;
    oauthRepo.createClient(deps.scopes.instance(), {
      clientId,
      clientName: parsed.data.client_name,
      redirectUris: [...parsed.data.redirect_uris],
      createdAt: deps.now(),
      createdByAccountId: null,
      registrationSource: 'dynamic',
    });
    deps.logger.info({ component: 'http', oauthClientId: clientId }, 'oauth client registered');
    return reply.status(201).send({
      client_id: clientId,
      client_name: parsed.data.client_name,
      redirect_uris: [...parsed.data.redirect_uris],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  app.post('/oauth/revoke', (request, reply) => {
    const parsed = revokeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_request' });
    }
    const existing = oauthRepo.findTokenByHash(
      deps.scopes.instance(),
      hashToken(parsed.data.token),
    );
    revokeByValue(oauthDeps, { token: parsed.data.token, clientId: parsed.data.client_id });
    // RFC 7009: revocation always succeeds, even for an unknown token — and an
    // unknown token carries no id to log.
    if (existing !== undefined && existing.clientId === parsed.data.client_id) {
      deps.logger.info(
        { component: 'http', oauthClientId: existing.clientId, oauthTokenId: existing.tokenId },
        'oauth token revoked',
      );
    } else {
      deps.logger.info({ component: 'http' }, 'oauth token revoked');
    }
    return reply.status(200).send();
  });
};
