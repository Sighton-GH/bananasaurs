/**
 * The member-facing fallback sentences shared by the invoke job (the Discord
 * path) and the assistant service (the dashboard Try-it path), kept in one
 * place so the two paths cannot drift apart.
 */

/** Every assistant model is busy, rate-limited or timed out: try again in a minute. */
export const BUSY_REPLY = 'The AI is busy right now, so nothing was done. Try again in a minute.';

/** Midnight UTC after `nowMs`, when a `:free` daily allowance resets. */
export const nextUtcMidnight = (nowMs: number): number => {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
};

/**
 * ADR 0077: when a `:free` model's daily request allowance is exhausted, a
 * retry cannot help — it does not reset for up to 24 hours — so the member
 * is told exactly when it resets instead of being told to try again in a
 * minute.
 */
export const dailyQuotaReply = (resetAt: number | undefined, nowMs: number): string => {
  const unix = Math.floor((resetAt ?? nextUtcMidnight(nowMs)) / 1000);
  return `Today's free AI allowance is used up, so nothing was done. It resets <t:${unix}:t>.`;
};
