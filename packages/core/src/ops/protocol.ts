import { z } from 'zod';

/**
 * The operator socket's wire protocol (ADR 0013, `docs/19` §6.9).
 *
 * Newline-delimited JSON, one request per line, one response per line. Chosen
 * over anything framed or binary because the whole point of the CLI is that a
 * human — or an agent the human is driving — can drive it, and a protocol you
 * can drive with `socat` while debugging is worth more here than four bytes of
 * length prefix.
 *
 * **Everything in a request is untrusted.** The socket is reachable by anyone
 * in `bananasaurs-ops` (ADR 0024) and by anything that process runs; a request
 * is parsed by these schemas before any of it reaches a command, exactly as a
 * form submission would be (`CLAUDE.md` rule 3). In particular `unixUserClaimed`
 * is a string the caller chose — it is recorded, never consulted.
 */

/** Bumped only for a breaking change; a mismatch is refused, never guessed at. */
export const OPS_PROTOCOL_VERSION = 1;

/**
 * The maximum bytes of one request line.
 *
 * A socket peer that never sends a newline would otherwise grow a buffer
 * without bound, which is a denial of service reachable by anyone in the ops
 * group. Generous enough for any command this surface has (`config set` on a
 * long value is the largest) and small enough that the failure is a refusal.
 */
export const OPS_MAX_LINE_BYTES = 64 * 1024;

export const opsRequestSchema = z
  .object({
    v: z.literal(OPS_PROTOCOL_VERSION),
    /**
     * The full command path as one string — `status`, `log routing set`. The
     * same spelling `docs/17` uses, so the surface reads identically in the
     * documentation, on the wire, and in an audit row.
     */
    command: z.string().min(1).max(64),
    /** Omitted when the instance has exactly one allowlisted guild. */
    guildId: z.string().min(1).max(32).optional(),
    args: z.record(z.unknown()).default({}),
    /**
     * `--confirm`. Enforced by the daemon, not by the CLI's argument parser: a
     * client is not a control, and the socket accepts requests from anything in
     * the ops group, not only from our own binary.
     */
    confirm: z.boolean().default(false),
    /**
     * An **assertion**, not a kernel-verified fact (amendment 2). Stored as
     * `actor_unix_user_claimed` and rendered as claimed.
     */
    unixUserClaimed: z.string().min(1).max(64).optional(),
  })
  // Unknown keys are dropped rather than refused: a newer CLI talking to an
  // older daemon should fail on the fields it needs, not on ones it sent.
  .strip();

export type OpsRequest = z.infer<typeof opsRequestSchema>;

/**
 * Why a request did not succeed.
 *
 * A closed set rather than free text, because the CLI maps it to an exit code
 * and a script reads that exit code. Adding a case is a deliberate act.
 */
export const OPS_ERROR_CODES = [
  /** Malformed envelope, unparseable arguments, or a version we do not speak. */
  'bad-request',
  'unknown-command',
  /** No such guild in the allowlist, or none named where one was required. */
  'unknown-guild',
  /** A write command arrived without `--confirm`. */
  'needs-confirm',
  /** The daemon is running with `BANANASAURS_READONLY=1`. */
  'readonly',
  /** The command ran and failed. */
  'failed',
] as const;

export type OpsErrorCode = (typeof OPS_ERROR_CODES)[number];

/**
 * A JSON value, so `--json` output is typed rather than `any`.
 *
 * `unknown` would push a cast onto every command; `any` would disable the
 * checking that makes the rest of this package worth having.
 */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface OpsOk {
  readonly v: typeof OPS_PROTOCOL_VERSION;
  readonly ok: true;
  readonly command: string;
  /** For a terminal. Already formatted; the CLI prints it verbatim. */
  readonly text: string;
  /** For `--json`, and therefore for an agent. */
  readonly data: JsonValue;
}

export interface OpsError {
  readonly v: typeof OPS_PROTOCOL_VERSION;
  readonly ok: false;
  readonly command: string;
  readonly code: OpsErrorCode;
  readonly message: string;
}

export type OpsResponse = OpsOk | OpsError;

/**
 * Process exit codes, so a script can branch without parsing text.
 *
 * `2` for anything the caller got wrong, `3` for a refusal by a control, `1`
 * for a command that ran and failed — the distinction a caller actually needs
 * is "fix your command" versus "the daemon said no" versus "it tried".
 */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_REFUSED = 3;
/** EX_UNAVAILABLE, as `apps/daemon/src/index.ts` already uses it. */
export const EXIT_UNAVAILABLE = 69;

export const exitCodeFor = (code: OpsErrorCode): number => {
  switch (code) {
    case 'bad-request':
    case 'unknown-command':
    case 'unknown-guild':
      return EXIT_USAGE;
    case 'needs-confirm':
    case 'readonly':
      return EXIT_REFUSED;
    case 'failed':
      return EXIT_FAILED;
  }
};

/**
 * JSON, recursively.
 *
 * `z.unknown()` would have been shorter and would have forced a cast at the one
 * place the client turns a validated value back into an `OpsResponse` — a cast
 * inside the function whose job is to not trust what came off the socket.
 */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

/**
 * The response schema, used by the **client** to validate what came back.
 *
 * Symmetry is the point: the daemon does not trust the CLI, and the CLI does
 * not trust whatever is listening on a socket path it was pointed at.
 */
export const opsResponseSchema = z.union([
  z.object({
    v: z.literal(OPS_PROTOCOL_VERSION),
    ok: z.literal(true),
    command: z.string(),
    text: z.string(),
    data: jsonValueSchema,
  }),
  z.object({
    v: z.literal(OPS_PROTOCOL_VERSION),
    ok: z.literal(false),
    command: z.string(),
    code: z.enum(OPS_ERROR_CODES),
    message: z.string(),
  }),
]);
