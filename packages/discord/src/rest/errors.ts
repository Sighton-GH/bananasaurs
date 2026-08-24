import { DiscordAPIError, HTTPError, RateLimitError } from 'discord.js';
import { DiscordApiError, DiscordErrorCode } from '@bananasaurs/core';

/**
 * Every failure this port raises is a `DiscordApiError`.
 *
 * `packages/core/src/discord/errors.ts` already names the failures Release 1
 * branches on — `isGone`, `isPermissionDenied`, `isExpiredInteraction`,
 * `isRateLimit`. The adapter's job is to translate into that vocabulary, not to
 * invent a second one: the effect gateway must never have to know which library
 * produced an error, and a string match on a discord.js message would break on
 * a wording change nobody would notice.
 */
export function toDiscordApiError(err: unknown): DiscordApiError {
  if (err instanceof DiscordApiError) return err;

  /**
   * ADR 0018 turns every rate limit into this rather than a silent wait. It
   * arrives *before* a request is sent when the bucket is already exhausted, so
   * there is no response to read a code from — 429 with `retryAfter` and
   * `global` is exactly what `DiscordApiError` was given those fields for.
   */
  if (err instanceof RateLimitError) {
    return new DiscordApiError(429, DiscordErrorCode.RateLimited, 'You are being rate limited.', {
      // discord.js reports milliseconds; our vocabulary is seconds, as Discord
      // sends it on the wire.
      retryAfter: err.timeToReset / 1_000,
      global: err.global,
    });
  }

  if (err instanceof DiscordAPIError) {
    return new DiscordApiError(
      err.status,
      // `code` is a string for OAuth errors, which this bot never makes.
      typeof err.code === 'number' ? err.code : undefined,
      err.message,
    );
  }

  // A transport failure: DNS, TLS, a socket reset, or the 15s abort. It has no
  // Discord error code because Discord never answered.
  if (err instanceof HTTPError) {
    return new DiscordApiError(err.status, undefined, err.message);
  }

  if (err instanceof Error && err.name === 'AbortError') {
    return new DiscordApiError(0, undefined, `request aborted: ${err.message}`);
  }

  return new DiscordApiError(0, undefined, err instanceof Error ? err.message : String(err));
}

/**
 * Runs a REST call and maps whatever comes out.
 *
 * Deliberately not a retry helper. ADR 0018: the effect gateway owns retries,
 * because it is the thing holding the breaker, the rate cap and the idempotency
 * key. Retrying here would retry without any of them.
 */
export async function mapErrors<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw toDiscordApiError(err);
  }
}
