import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';

/**
 * Every cryptographic primitive the dashboard uses, in one file.
 *
 * They are here together rather than beside their callers because the choices
 * between them are the interesting part: which values get Argon2id and which
 * get a plain SHA-256, and why those are not the same question.
 *
 * **Argon2id is for passwords, and only passwords.** A password is low-entropy
 * and guessable, so the work factor is the control — it is what makes an
 * offline attack on a stolen hash expensive.
 *
 * **SHA-256 is for the tokens we generate ourselves.** A session token and a
 * bootstrap token are 256 bits of uniform randomness from `randomBytes`. There
 * is no dictionary to slow down, so a work factor buys nothing against an
 * attacker — and it costs us on the hot path of every authenticated request,
 * which makes it a denial-of-service knob pointed at ourselves. The reason to
 * hash them at all is unchanged and is worth stating: a database backup, a
 * diagnostics bundle, or a `SELECT *` must not yield anything anyone can log in
 * with.
 */

/**
 * Argon2id parameters.
 *
 * The `@node-rs/argon2` defaults are already the OWASP-recommended second
 * option (19 MiB, t=2, p=1); these are named explicitly so a change is a change
 * to this line rather than to a dependency's default under us.
 */
const ARGON2 = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const hashPassword = (password: string): Promise<string> => argon2Hash(password, ARGON2);

/**
 * Verifies a password, returning `false` rather than throwing on a malformed
 * hash.
 *
 * A stored hash that will not parse is a corrupted row, not a correct password,
 * and the one thing it must not do is propagate an exception out of the login
 * handler where a generic 500 would distinguish it from a wrong password.
 */
export const verifyPassword = async (storedHash: string, password: string): Promise<boolean> => {
  try {
    return await argon2Verify(storedHash, password, ARGON2);
  } catch {
    return false;
  }
};

/**
 * An Argon2id hash of a value no one knows, verified against when a username
 * does not exist.
 *
 * The point is timing: without it, "no such account" returns in microseconds
 * and "wrong password" returns in tens of milliseconds, and the difference
 * answers "does this account exist" for anyone who can time a request. Computed
 * once at module load, because computing it per request would double the cost
 * of every failed login.
 */
export const dummyPasswordHashPromise: Promise<string> = hashPassword(
  randomBytes(32).toString('hex'),
);

/** 32 bytes, base64url. The value that goes in the cookie and is never stored. */
export const generateToken = (): string => randomBytes(32).toString('base64url');

/**
 * What is stored for a token: `sha256(token)`, hex.
 *
 * Used for both session tokens and bootstrap tokens. Same reasoning, same
 * function, so there is one place to look at when asking what the database
 * holds.
 */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * The CSRF token for a session, derived from the session token itself
 * (ADR 0029).
 *
 * Three properties, each of which ruled out an alternative:
 *
 * - **No column.** It cannot drift from the session it belongs to, and adding
 *   it needed no migration.
 * - **No server secret.** A key held in memory would invalidate every live
 *   session's CSRF token on every daemon restart — and sessions are DB-backed
 *   precisely so they survive one. A key in the environment would be another
 *   secret to manage for a control that does not need one.
 * - **One-way.** A leaked CSRF token does not yield the session token, so
 *   putting it in a response body and in a header is safe.
 *
 * The attacker this defends against — a cross-origin page submitting a form —
 * cannot read an `HttpOnly` cookie and therefore cannot compute this. The
 * domain separator stops the value being confusable with the session id hash,
 * which is `sha256` of the same input.
 */
export const csrfTokenFor = (rawSessionToken: string): string =>
  createHash('sha256').update(`bananasaurs.csrf:${rawSessionToken}`, 'utf8').digest('hex');

/**
 * Constant-time comparison for the CSRF check.
 *
 * `===` on strings short-circuits at the first differing byte, which leaks the
 * length of a correct prefix. That is a weak oracle here — the value is derived
 * from a secret the attacker does not have — but the check is one line and the
 * habit is worth more than the reasoning about when it is safe to skip.
 */
export const secretsMatch = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself be a leak
  // if it escaped; different lengths simply mean not equal.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};
