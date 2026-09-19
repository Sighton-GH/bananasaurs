import { z } from 'zod';

/**
 * Every number ADR 0029 settles, in one place.
 *
 * Constants rather than configuration, deliberately. Each of these is a
 * security decision with a recorded reason, and an environment variable would
 * turn "twelve hours, absolute, no renewal" into "whatever the last person put
 * in the env file" — with the ADR still claiming the first. Changing one is an
 * edit here and an amendment there.
 */
export const POLICY = {
  /** Absolute, from creation. Never extended — not by activity, not by re-auth. */
  sessionTtlMs: 12 * 60 * 60 * 1000,
  /** How recently a password must have been entered for a destructive action. */
  reauthWindowMs: 5 * 60 * 1000,
  /** Failed logins before the account locks. */
  maxFailedAttempts: 5,
  lockoutMs: 15 * 60 * 1000,
  /** `docs/19` §6.10 step 1, stated there as fifteen minutes. */
  bootstrapTtlMs: 15 * 60 * 1000,
} as const;

/**
 * Password rules. `docs/19` §6.10 step 3 says "Argon2id, length-checked".
 *
 * Twelve characters and no composition rules, which is the current NIST
 * guidance and the right trade for a single technically-capable owner: a
 * required symbol produces `Password1!`, a length floor does not.
 *
 * The **maximum** is the part that is not cosmetic. Argon2id's cost is bounded
 * by its parameters rather than by input length, but there is no reason to hash
 * a megabyte, and an unbounded field on an unauthenticated route is an easy way
 * to spend the daemon's CPU.
 */
export const passwordSchema = z
  .string()
  .min(12, 'a password must be at least 12 characters')
  .max(1024, 'a password must be at most 1024 characters');

/**
 * Usernames. Deliberately narrow: this is an owner-provisioned local account
 * (ADR 0012), not a public signup, so there is no case for unicode display
 * names and every case for a value that cannot be confused with another when
 * it appears in an audit row.
 */
export const usernameSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(
    /^[a-z0-9._-]+$/,
    'a username may contain lowercase letters, digits, dot, dash, underscore',
  );

export const loginBodySchema = z.object({
  username: usernameSchema,
  /**
   * Not `passwordSchema`. A login checks the password that exists, not the one
   * the rules would allow — applying the minimum here would refuse an old short
   * password with a validation error that reads differently from a wrong one,
   * which is both a worse experience and an oracle.
   */
  password: z.string().min(1).max(1024),
  /** Omitted when the account can reach exactly one guild. */
  guildId: z.string().optional(),
});

export const bootstrapBodySchema = z.object({
  token: z.string().min(1).max(512),
  username: usernameSchema,
  password: passwordSchema,
});

/**
 * The guild-switch body (S13-D8).
 *
 * A plain string, like `loginBodySchema.guildId` and unlike the snowflake
 * schemas elsewhere: a malformed value must be refused exactly like an
 * unreachable one (403 `no-guild-access`, no oracle), and a schema that
 * rejected it with 400 would be the oracle. Non-strings still fail here.
 */
export const sessionGuildBodySchema = z.object({
  guildId: z.string().min(1).max(64),
});
export const reauthBodySchema = z.object({
  password: z.string().min(1).max(1024),
});
