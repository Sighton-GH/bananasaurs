import type { z } from 'zod';
import type { Actor } from '../authz.js';
import type { GuildId } from '../ids.js';
import type { OpsInstance, OpsPorts } from './ports.js';
import {
  OPS_PROTOCOL_VERSION,
  opsRequestSchema,
  type OpsErrorCode,
  type OpsResponse,
  type JsonValue,
} from './protocol.js';

/**
 * The command surface, as a pure function of a parsed request.
 *
 * No `net`, no database, no clock of its own. That is what makes the whole
 * operator surface unit-testable: the socket in `apps/daemon` moves bytes and
 * this decides what they mean, so a test of "does `--confirm` actually gate a
 * write" needs neither a socket path nor a running daemon.
 *
 * The guild-scope pattern is the one WP4 established for subscribers: a command
 * never receives a guild id it could vary. `contextFor` hands it a context that
 * is already a closure over one `GuildScope`, so there is no parameter through
 * which a command could reach another guild's rows even if it tried
 * (`CLAUDE.md` rule 2).
 */

/**
 * What a command can reach, bound to one guild.
 *
 * `ports` is supplied by the composition root as closures over that guild's
 * `GuildScope`, the same shape WP4's `LoggingPorts` and WP3's `ReconcilePorts`
 * already use. `core` cannot see a database handle and must not learn to.
 */
export interface OpsGuildContext {
  readonly guildId: GuildId;
  /** A property, not a method, so it is passed on by value like everywhere else. */
  readonly now: () => number;
  readonly ports: OpsPorts;
}

/** What a command actually receives: its guild context, the instance, and who is asking. */
export interface OpsContext extends OpsGuildContext {
  /**
   * Always `operator_cli` (ADR 0024). Its `unixUserClaimed` is recorded in the
   * audit trail and consulted for nothing — a control built on a field the
   * caller chose would be a control-shaped thing, not a control.
   */
  readonly actor: Actor;
  /**
   * Facts about the process rather than about a guild.
   *
   * Kept off `ports` deliberately: everything on `ports` is a guild-scoped
   * query and mixing an unscoped one in would make "does every query take a
   * guild id" a question you have to check field by field.
   */
  readonly instance: OpsInstance;
}

export interface OpsCommandResult {
  /** Rendered for a terminal. */
  readonly text: string;
  /** The same answer for `--json`, and therefore for an agent. */
  readonly data: JsonValue;
}

/** One positional argument, in the order the command takes them. */
export interface OpsParam {
  readonly name: string;
  readonly required: boolean;
  /** Shown in `--help`. One short line. */
  readonly describe: string;
}

/** One `--flag`, beyond the global `--guild`, `--json` and `--confirm`. */
export interface OpsFlag {
  readonly name: string;
  readonly kind: 'string' | 'number' | 'boolean';
  readonly describe: string;
}

export interface OpsCommand<A> {
  /** The full path, spelled as `docs/17` spells it: `log routing set`. */
  readonly name: string;
  /**
   * Whether this command changes anything. Drives the `--confirm` gate and,
   * from slice 13b, the audit row — so it is a property of the command rather
   * than a flag each handler remembers to check.
   */
  readonly write: boolean;
  readonly summary: string;
  /**
   * How the CLI turns a command line into `args`.
   *
   * Declared here, on the command, rather than in a table inside the CLI — so
   * the surface has exactly one definition. A CLI carrying its own copy is a
   * copy that drifts, and the drift shows up as a command that parses fine and
   * is then refused by a validator the operator cannot see.
   */
  readonly positional?: readonly OpsParam[];
  readonly flags?: readonly OpsFlag[];
  /** Untrusted input meets a Zod validator here, same as a form submission. */
  readonly args: z.ZodType<A>;
  run(ctx: OpsContext, args: A): OpsCommandResult | Promise<OpsCommandResult>;
}

/** The outcome of validating a command's arguments and, if they held, running it. */
export type ParsedRun =
  | { readonly ok: false; readonly issues: readonly z.ZodIssue[] }
  | { readonly ok: true; readonly result: OpsCommandResult | Promise<OpsCommandResult> };

/**
 * A command with its argument type erased, so a registry can hold commands
 * whose argument shapes differ.
 *
 * The erasure happens in `defineCommand` below, where `safeParse` produces the
 * exact type `run` wants — so there is **no cast anywhere**. An array of
 * `OpsCommand<never>` or `OpsCommand<any>` would have needed one, and a cast in
 * the one function whose job is to validate untrusted input is the last place
 * to put one.
 */
export interface RegisteredCommand {
  readonly name: string;
  readonly write: boolean;
  readonly summary: string;
  readonly positional: readonly OpsParam[];
  readonly flags: readonly OpsFlag[];
  runParsed(ctx: OpsContext, rawArgs: Record<string, unknown>): ParsedRun;
}

export const defineCommand = <A>(spec: OpsCommand<A>): RegisteredCommand => ({
  name: spec.name,
  write: spec.write,
  summary: spec.summary,
  positional: spec.positional ?? [],
  flags: spec.flags ?? [],
  runParsed(ctx, rawArgs) {
    const parsed = spec.args.safeParse(rawArgs);
    if (!parsed.success) return { ok: false, issues: parsed.error.issues };
    return { ok: true, result: spec.run(ctx, parsed.data) };
  },
});

export interface DispatcherDeps {
  readonly commands: readonly RegisteredCommand[];
  /** The allowlisted guilds, in configuration order. */
  readonly guildIds: readonly string[];
  /** One context per guild, or `undefined` for a guild with no runtime. */
  contextFor(guildId: string): OpsGuildContext | undefined;
  /** Process-level facts, shared by every guild. */
  readonly instance: OpsInstance;
}

export interface Dispatcher {
  dispatch(raw: unknown): Promise<OpsResponse>;
  commandNames(): readonly string[];
}

const fail = (command: string, code: OpsErrorCode, message: string): OpsResponse => ({
  v: OPS_PROTOCOL_VERSION,
  ok: false,
  command,
  code,
  message,
});

/**
 * Recognises storage's readonly refusal without importing it.
 *
 * `packages/core` may not depend on `@bananasaurs/storage` (ADR 0014), so the
 * `instanceof` check that would be cleaner is not available. Matching on
 * `name` is what the class's own `override readonly name = 'ReadonlyError'`
 * exists to make reliable — it survives minification and the prototype chain,
 * which a message match would not.
 */
const isReadonlyRefusal = (err: unknown): boolean =>
  err instanceof Error && err.name === 'ReadonlyError';

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : `a command failed with a non-Error: ${String(err)}`;

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const byName = new Map<string, RegisteredCommand>();
  for (const command of deps.commands) {
    if (byName.has(command.name)) {
      throw new Error(
        `two ops commands are both named "${command.name}"; the later one would ` +
          `silently shadow the earlier, so this is a build-time error instead`,
      );
    }
    byName.set(command.name, command);
  }

  const resolveGuild = (
    requested: string | undefined,
  ): { ok: true; context: OpsGuildContext } | { ok: false; message: string } => {
    // No guild named. One allowlisted guild is unambiguous; more than one is
    // not, and picking the first would silently act on the wrong server.
    const guildId = requested ?? (deps.guildIds.length === 1 ? deps.guildIds[0] : undefined);
    if (guildId === undefined) {
      return {
        ok: false,
        message:
          `this instance serves ${String(deps.guildIds.length)} guilds, so the command ` +
          `must say which: pass --guild <id>`,
      };
    }
    if (!deps.guildIds.includes(guildId)) {
      return { ok: false, message: `guild ${guildId} is not in BANANASAURS_GUILD_ALLOWLIST` };
    }
    const context = deps.contextFor(guildId);
    if (context === undefined) {
      return { ok: false, message: `guild ${guildId} is allowlisted but has no runtime` };
    }
    return { ok: true, context };
  };

  return {
    commandNames: () => [...byName.keys()].sort(),

    async dispatch(raw: unknown): Promise<OpsResponse> {
      const parsed = opsRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return fail('', 'bad-request', parsed.error.issues.map(describeIssue).join('; '));
      }
      const request = parsed.data;

      const command = byName.get(request.command);
      if (command === undefined) {
        return fail(request.command, 'unknown-command', `no such command: ${request.command}`);
      }

      const guild = resolveGuild(request.guildId);
      if (!guild.ok) return fail(request.command, 'unknown-guild', guild.message);

      // Before argument validation, deliberately. A write that arrives without
      // `--confirm` must report the missing confirmation, not a typo three
      // arguments later that the operator would fix and then be surprised by a
      // second refusal.
      if (command.write && !request.confirm) {
        return fail(
          request.command,
          'needs-confirm',
          `${request.command} changes state; re-run it with --confirm`,
        );
      }

      const actor: Actor = {
        // Not read from the request. The channel establishes the actor type
        // (ADR 0024); a caller that sent `actorType: 'owner'` would otherwise
        // be choosing how it is recorded in the audit trail.
        type: 'operator_cli',
        id: undefined,
        roleIds: [],
        unixUserClaimed: request.unixUserClaimed,
      };

      try {
        const run = command.runParsed(
          { ...guild.context, actor, instance: deps.instance },
          request.args,
        );
        if (!run.ok) {
          return fail(request.command, 'bad-request', run.issues.map(describeIssue).join('; '));
        }
        const result = await run.result;
        return {
          v: OPS_PROTOCOL_VERSION,
          ok: true,
          command: request.command,
          text: result.text,
          data: result.data,
        };
      } catch (err) {
        // A command that throws must not take the daemon down with it: this
        // runs on a socket connection, not on the gateway's event loop chain,
        // and the operator asking a bad question is not a reason to stop
        // serving the guild.
        if (isReadonlyRefusal(err)) {
          return fail(request.command, 'readonly', messageOf(err));
        }
        return fail(request.command, 'failed', messageOf(err));
      }
    },
  };
}

/** `path: message`, so a rejected field names itself. */
const describeIssue = (issue: z.ZodIssue): string =>
  issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
