import {
  exitCodeFor,
  EXIT_OK,
  EXIT_UNAVAILABLE,
  EXIT_USAGE,
  OPERATOR_COMMANDS,
  type RegisteredCommand,
} from '@bananasaurs/core';
import { parseArgv } from './args.js';
import { sendRequest } from './client.js';

/**
 * The CLI, as a function of its inputs.
 *
 * `bin.ts` supplies `process.argv`, `process.env`, the real username and the
 * real socket; this decides what happens, so every exit code and every message
 * is testable without spawning a process.
 */

export interface RunDeps {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * The Unix user this invocation **claims** to be.
   *
   * `os.userInfo().username` in production. It is sent to the daemon, recorded
   * as `actor_unix_user_claimed`, and consulted for nothing (ADR 0024,
   * amendment 2) — the socket's group permissions are the access control.
   */
  readonly unixUser: string | undefined;
  writeOut(text: string): void;
  writeErr(text: string): void;
  /** Injected so a test can drive the whole CLI without a socket. */
  send?: typeof sendRequest;
  catalogue?: readonly RegisteredCommand[];
}

const DEFAULT_SOCKET_PATH = './run/admin.sock';

export async function run(deps: RunDeps): Promise<number> {
  const catalogue = deps.catalogue ?? OPERATOR_COMMANDS;
  const parsed = parseArgv(deps.argv, catalogue);

  if (parsed.kind === 'help') {
    deps.writeOut(`${parsed.text}\n`);
    return EXIT_OK;
  }
  if (parsed.kind === 'usage') {
    deps.writeErr(`${parsed.message}\n`);
    return EXIT_USAGE;
  }

  const socketPath =
    parsed.socketPath ?? deps.env['BANANASAURS_SOCKET_PATH'] ?? DEFAULT_SOCKET_PATH;

  const request = {
    ...parsed.request,
    // Added here rather than in the parser, because it is an environmental
    // fact rather than something the operator typed.
    ...(deps.unixUser === undefined ? {} : { unixUserClaimed: deps.unixUser }),
  };

  let response;
  try {
    response = await (deps.send ?? sendRequest)({ socketPath, request });
  } catch (err) {
    // Could not reach the daemon at all, which is a different thing from a
    // command that ran and failed — and the exit code says so.
    deps.writeErr(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_UNAVAILABLE;
  }

  if (response.ok) {
    deps.writeOut(`${parsed.json ? JSON.stringify(response.data, null, 2) : response.text}\n`);
    return EXIT_OK;
  }

  // A failure is machine-readable too: an agent driving this reads the code,
  // not the prose. `docs/17` §3.2 is explicit that parsing beats screen-scraping.
  if (parsed.json) {
    deps.writeErr(
      `${JSON.stringify({ ok: false, code: response.code, message: response.message }, null, 2)}\n`,
    );
  } else {
    deps.writeErr(`${response.message}\n`);
  }
  return exitCodeFor(response.code);
}
