import { OPS_PROTOCOL_VERSION, type OpsRequest, type RegisteredCommand } from '@bananasaurs/core';

/**
 * Turning a command line into a request.
 *
 * A pure function of `argv` and the command catalogue, so every parsing rule is
 * testable without a socket, and so `--help` works with no daemon running —
 * which matters the first time someone installs this and the service is not up
 * yet.
 *
 * **The catalogue comes from `@bananasaurs/core`, not from a table here.** The
 * CLI knowing a different set of commands from the daemon is the failure this
 * avoids: it would parse happily and then be refused by a validator the
 * operator cannot see.
 *
 * The CLI does no authorization and enforces no control. `--confirm` is carried
 * to the daemon, which is where the gate is (ADR 0024) — a client is not a
 * control, and the socket accepts requests from anything in the ops group.
 */

/** The request, plus the parts of the invocation that are the client's own business. */
export interface ParsedInvocation {
  readonly kind: 'request';
  readonly request: OpsRequest;
  /** `--json`: print `data`, not `text`. Never sent; the daemon answers both. */
  readonly json: boolean;
  /** `--socket`, overriding `BANANASAURS_SOCKET_PATH`. */
  readonly socketPath: string | undefined;
}

export type ParseResult =
  | ParsedInvocation
  | { readonly kind: 'help'; readonly text: string }
  | { readonly kind: 'usage'; readonly message: string };

/** Flags the CLI itself understands, on every command. */
const GLOBAL_FLAGS = new Set(['guild', 'json', 'confirm', 'socket', 'help']);
const GLOBAL_TAKING_VALUE = new Set(['guild', 'socket']);

const usage = (message: string): ParseResult => ({ kind: 'usage', message });

/** `--guild` and `-n` both name a flag; the dashes are punctuation. */
const flagName = (token: string): string => token.replace(/^--?/, '');

const isFlag = (token: string): boolean => token.startsWith('-') && token !== '-';

const renderCommandHelp = (command: RegisteredCommand): string => {
  const line = [
    'bananasaurs',
    command.name,
    ...command.positional.map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`)),
    ...command.flags.map((f) => (f.kind === 'boolean' ? `[--${f.name}]` : `[--${f.name} <value>]`)),
    ...(command.write ? ['--confirm'] : []),
  ].join(' ');

  const details = [
    ...command.positional.map((p) => `  ${p.name.padEnd(14)}${p.describe}`),
    ...command.flags.map((f) => `  --${f.name.padEnd(12)}${f.describe}`),
  ];

  return [
    line,
    '',
    `  ${command.summary}`,
    ...(details.length > 0 ? ['', ...details] : []),
    ...(command.write
      ? ['', '  This command changes state, so the daemon refuses it without --confirm.']
      : []),
  ].join('\n');
};

const renderOverview = (catalogue: readonly RegisteredCommand[]): string => {
  const width = Math.max(...catalogue.map((c) => c.name.length)) + 2;
  return [
    'bananasaurs — the Bananasaurs operator CLI',
    '',
    '  Talks to the running daemon over its Unix socket. It never opens the',
    '  database (ADR 0013), so it can do nothing the application itself cannot.',
    '',
    'Commands:',
    ...catalogue.map(
      (c) => `  ${c.name.padEnd(width)}${c.summary}${c.write ? '   [needs --confirm]' : ''}`,
    ),
    '',
    'Global flags:',
    '  --guild <id>   which guild; optional when the instance serves exactly one',
    '  --json         machine-readable output',
    '  --confirm      required by every command that changes state',
    '  --socket <p>   override BANANASAURS_SOCKET_PATH',
    '  --help         this, or `bananasaurs <command> --help`',
  ].join('\n');
};

/**
 * The longest command name matching the leading words.
 *
 * Longest wins because the surface is hierarchical: `log routing set` must not
 * be read as a command `log` that happens to take three arguments.
 */
const matchCommand = (
  words: readonly string[],
  catalogue: readonly RegisteredCommand[],
): { command: RegisteredCommand; consumed: number } | undefined => {
  let best: { command: RegisteredCommand; consumed: number } | undefined;
  for (const command of catalogue) {
    const parts = command.name.split(' ');
    if (parts.length > words.length) continue;
    if (!parts.every((part, i) => words[i] === part)) continue;
    if (best === undefined || parts.length > best.consumed) {
      best = { command, consumed: parts.length };
    }
  }
  return best;
};

export function parseArgv(
  argv: readonly string[],
  catalogue: readonly RegisteredCommand[],
): ParseResult {
  if (argv.length === 0) return { kind: 'help', text: renderOverview(catalogue) };

  const leading: string[] = [];
  for (const token of argv) {
    if (isFlag(token)) break;
    leading.push(token);
  }

  const wantsHelp = argv.some((token) => flagName(token) === 'help' && isFlag(token));
  const matched = matchCommand(leading, catalogue);

  if (matched === undefined) {
    if (wantsHelp || leading.length === 0) {
      return { kind: 'help', text: renderOverview(catalogue) };
    }
    return usage(
      `no such command: ${leading.join(' ')}\n\nRun \`bananasaurs --help\` for the list.`,
    );
  }
  if (wantsHelp) return { kind: 'help', text: renderCommandHelp(matched.command) };

  const declaredFlags = new Map(matched.command.flags.map((f) => [f.name, f]));
  const rest = argv.slice(matched.consumed);

  const positional: string[] = [];
  const args: Record<string, unknown> = {};
  let guildId: string | undefined;
  let socketPath: string | undefined;
  let json = false;
  let confirm = false;

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] ?? '';
    if (!isFlag(token)) {
      positional.push(token);
      continue;
    }

    const name = flagName(token);
    const takeValue = (): string | undefined => {
      const next = rest[i + 1];
      if (next === undefined || isFlag(next)) return undefined;
      i += 1;
      return next;
    };

    if (GLOBAL_FLAGS.has(name)) {
      if (GLOBAL_TAKING_VALUE.has(name)) {
        const value = takeValue();
        if (value === undefined) return usage(`--${name} needs a value`);
        if (name === 'guild') guildId = value;
        else socketPath = value;
      } else if (name === 'json') json = true;
      else if (name === 'confirm') confirm = true;
      continue;
    }

    const declared = declaredFlags.get(name);
    if (declared === undefined) {
      return usage(
        `${matched.command.name} has no flag ${token}\n\n` +
          `Run \`bananasaurs ${matched.command.name} --help\`.`,
      );
    }
    if (declared.kind === 'boolean') {
      args[declared.name] = true;
      continue;
    }
    const value = takeValue();
    if (value === undefined) return usage(`${token} needs a value`);
    if (declared.kind === 'number') {
      const asNumber = Number(value);
      // `Number('')` is 0 and `Number('lots')` is NaN; sending either onward
      // would make the daemon's validator report a confusing second error.
      if (!Number.isFinite(asNumber)) return usage(`${token} needs a number, not "${value}"`);
      args[declared.name] = asNumber;
    } else {
      args[declared.name] = value;
    }
  }

  const params = matched.command.positional;
  if (positional.length > params.length) {
    return usage(
      `${matched.command.name} takes ${String(params.length)} argument(s); ` +
        `did not expect "${positional[params.length] ?? ''}"`,
    );
  }
  for (const [index, param] of params.entries()) {
    const value = positional[index];
    if (value === undefined) {
      if (param.required) return usage(`${matched.command.name} needs <${param.name}>`);
      continue;
    }
    args[param.name] = value;
  }

  return {
    kind: 'request',
    json,
    socketPath,
    request: {
      v: OPS_PROTOCOL_VERSION,
      command: matched.command.name,
      args,
      confirm,
      // `exactOptionalPropertyTypes` is on, so an absent guild is an absent
      // key rather than an explicit `undefined` the daemon would have to
      // distinguish from "not given".
      ...(guildId === undefined ? {} : { guildId }),
    },
  };
}
