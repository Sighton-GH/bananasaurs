import { z } from 'zod';

/**
 * Snowflake identity, refused at the parse boundary.
 *
 * The failure this exists to prevent is not a malformed id — a malformed id is
 * easy and every layer catches it. It is a *correct-looking* one.
 *
 * Every real Discord snowflake exceeds Number.MAX_SAFE_INTEGER, so parsing one
 * as a JS number corrupts it before it reaches any storage:
 *
 *     Number(1234567890123456789n)   ->  1234567890123456800
 *     String(1234567890123456800)    ->  "1234567890123456800"
 *
 * That string is nineteen digits, matches every format check we could write,
 * and is the wrong user. Nothing downstream can distinguish it from a real id:
 * not a CHECK constraint, not a STRICT column, not code review. The corruption
 * is only still visible at the point where the value was a number, so that is
 * the only place it can be refused — which is why this lives at the parse
 * boundary and not in the schema.
 *
 * Discord itself sends snowflakes as JSON *strings* for exactly this reason, so
 * anything arriving from the gateway is safe by construction. The realistic
 * source of a numeric snowflake is our own code: a job payload round-tripped
 * through JSON.parse, a hand-written config value, an HTTP body, a CLI argument.
 */

const SNOWFLAKE_RE = /^[0-9]{17,20}$/;

const NUMBER_REFUSAL =
  'snowflake arrived as a number, so it was already corrupted before this check — ' +
  'JS numbers cannot hold a snowflake and the original digits are unrecoverable. ' +
  'Keep snowflakes as strings from the moment they are parsed; a numeric literal ' +
  'in JSON is the usual culprit.';

const BIGINT_REFUSAL =
  'snowflake arrived as a bigint. The canonical form is a string; a bigint is ' +
  'either a needless conversion or the residue of a number that was already ' +
  'corrupted, and the two are indistinguishable here.';

const refuseLossyNumerics: z.ZodErrorMap = (issue, ctx) => {
  if (issue.code === z.ZodIssueCode.invalid_type) {
    if (issue.received === z.ZodParsedType.number) return { message: NUMBER_REFUSAL };
    if (issue.received === z.ZodParsedType.bigint) return { message: BIGINT_REFUSAL };
  }
  return { message: ctx.defaultError };
};

/**
 * A Discord snowflake that has been through this validator.
 *
 * Branded, so it cannot be produced by annotation. The brand is not a security
 * boundary — `as unknown as SnowflakeId` defeats it — which is why the lint rule
 * in `eslint.config.js` bans casts onto it. The brand's job is to make the
 * parse impossible to *forget*, which is the failure that actually happens.
 */
export const snowflakeIdSchema = z
  .string({ errorMap: refuseLossyNumerics })
  .regex(SNOWFLAKE_RE, 'a snowflake is 17 to 20 digits')
  .brand<'SnowflakeId'>();

export type SnowflakeId = z.infer<typeof snowflakeIdSchema>;

/**
 * A snowflake that names a guild.
 *
 * Distinct from `SnowflakeId` so the mandatory partition key cannot be
 * satisfied by passing a user or role id that happens to be in scope. Every
 * `GuildId` is a `SnowflakeId`; the reverse does not hold.
 */
export const guildIdSchema = snowflakeIdSchema.brand<'GuildId'>();

export type GuildId = z.infer<typeof guildIdSchema>;

/** Throws a ZodError naming the reason. Use at any boundary. */
export const parseSnowflakeId = (value: unknown): SnowflakeId => snowflakeIdSchema.parse(value);

/** Throws a ZodError naming the reason. Use at any boundary. */
export const parseGuildId = (value: unknown): GuildId => guildIdSchema.parse(value);

/** Non-throwing form, for code that already has a failure path. */
export const isSnowflakeId = (value: unknown): value is SnowflakeId =>
  typeof value === 'string' && SNOWFLAKE_RE.test(value);
