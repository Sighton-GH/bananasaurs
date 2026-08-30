import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  OPS_MAX_LINE_BYTES,
  OPS_PROTOCOL_VERSION,
  safeLogFields,
  type Logger,
  type OpsResponse,
} from '@bananasaurs/core';

/**
 * The admin socket (ADR 0013, `docs/19` §6.9).
 *
 * Moves bytes and nothing else. Every decision about what a request *means*
 * lives in `core`'s dispatcher, which is why the command surface is testable
 * without a socket and this file is testable without a database.
 *
 * **It also completes `docs/19` amendment 1's single-writer guard.** The
 * amendment specifies "socket bind **plus** an `O_EXCL` PID lockfile", and
 * `packages/storage/src/lock.ts` has documented the bind as if it existed since
 * slice 2a — nothing called `net.createServer` until this file. `index.ts`
 * therefore binds *before* opening the database, so the two guards run in the
 * order the amendment describes.
 *
 * That ordering is why `serve()` is separate from binding: the handler needs a
 * dispatcher, the dispatcher needs the database, and the database open is the
 * thing the bind is guarding. A request that lands in the window between is
 * refused, not queued.
 */

/** Another daemon is already listening on this path. */
export class SocketInUseError extends Error {
  override readonly name = 'SocketInUseError';
  constructor(socketPath: string) {
    super(
      `another Bananasaurs is already listening on ${socketPath}.\n\n` +
        `  Two daemons sharing one database is the corruption this guard exists to\n` +
        `  prevent (docs/19 amendment 1). Stop the running instance, or point this\n` +
        `  one at a different BANANASAURS_SOCKET_PATH and BANANASAURS_DB_PATH.`,
    );
  }
}

export type OpsHandler = (raw: unknown) => Promise<OpsResponse>;

export interface OpsSocketServer {
  readonly path: string;
  /**
   * Attaches the dispatcher, once the daemon is assembled.
   *
   * Separate from binding on purpose — see the note above about the guard's
   * ordering. Calling it twice replaces the handler, which is what a test
   * wants and what nothing in production does.
   */
  serve(handle: OpsHandler): void;
  close(): Promise<void>;
}

export interface OpsSocketDeps {
  readonly socketPath: string;
  readonly logger: Logger;
}

/** Mode 0660: owner and group read/write, nobody else (`docs/17` §2.1). */
const SOCKET_MODE = 0o660;

const errorResponse = (message: string, code: 'bad-request' | 'failed'): OpsResponse => ({
  v: OPS_PROTOCOL_VERSION,
  ok: false,
  command: '',
  code,
  message,
});

/**
 * Is something alive on this path, or is it a corpse?
 *
 * `listen()` on an existing socket **file** fails `EADDRINUSE` whether or not a
 * process is listening, so a crash leaves a path that looks occupied forever
 * and the bot never starts again. A connect attempt is what distinguishes the
 * two: `ECONNREFUSED` means the file outlived its process.
 */
const probe = (socketPath: string): Promise<'live' | 'stale' | 'absent'> =>
  new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) {
      resolve('absent');
      return;
    }
    const client = net.createConnection(socketPath);
    const settle = (verdict: 'live' | 'stale'): void => {
      client.destroy();
      resolve(verdict);
    };
    client.once('connect', () => settle('live'));
    client.once('error', (err: NodeJS.ErrnoException) => {
      // ECONNREFUSED: the file is there, nothing is behind it. ENOENT: it went
      // away between the check and the connect. Anything else — a permission
      // error, say — must fail safe as live, because "cannot tell" is not
      // "definitely free" when the cost of being wrong is two writers.
      settle(err.code === 'ECONNREFUSED' || err.code === 'ENOENT' ? 'stale' : 'live');
    });
  });

export async function bindOpsSocket(deps: OpsSocketDeps): Promise<OpsSocketServer> {
  const { socketPath, logger } = deps;
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });

  const verdict = await probe(socketPath);
  if (verdict === 'live') throw new SocketInUseError(socketPath);
  if (verdict === 'stale') {
    logger.warn(
      safeLogFields({ component: 'ops-socket', reason: 'stale-socket' }),
      `reclaiming a stale admin socket at ${socketPath}`,
    );
    fs.rmSync(socketPath, { force: true });
  }

  let handle: OpsHandler | undefined;

  /**
   * One chain for every connection, not one per connection.
   *
   * A write command runs inside `write()`, which is synchronous and cannot
   * interleave — but an async command (`panel sync`, `undo`) awaits Discord,
   * and two of those overlapping would race exactly as two gateway dispatches
   * would. `daemon.ts` already serialises per guild for that reason; this
   * serialises the operator surface for the same one.
   */
  let chain: Promise<unknown> = Promise.resolve();
  const run = async (raw: unknown): Promise<OpsResponse> => {
    const work = chain.then(async () => {
      if (handle === undefined) {
        return errorResponse('the daemon is still starting; try again in a moment', 'failed');
      }
      try {
        return await handle(raw);
      } catch (err) {
        // The dispatcher already catches a failing command. Reaching here means
        // the dispatcher itself threw, which must still not take the daemon
        // down: this runs on a socket connection, not on the gateway chain.
        logger.error(safeLogFields({ component: 'ops-socket', err }), 'ops handler threw');
        return errorResponse(err instanceof Error ? err.message : String(err), 'failed');
      }
    });
    chain = work.catch(() => undefined);
    return await work;
  };

  /**
   * `allowHalfOpen`, because the connection lifecycle is the protocol's.
   *
   * A client writes its request line, half-closes to say "that is all I am
   * sending", and reads until EOF. Without half-open, Node ends our side the
   * instant that FIN arrives — before the response, which is produced
   * asynchronously, has been written. With it, we finish the work, write the
   * answer, and close. The alternative (both sides holding the connection open
   * forever, waiting for the other to hang up) is how the first version of this
   * file deadlocked its own tests.
   */
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let refused = false;
    let clientDone = false;
    let inFlight = 0;

    /** Closes once the client has finished asking and we have finished answering. */
    const finishIfDone = (): void => {
      if (clientDone && inFlight === 0 && !socket.writableEnded) socket.end();
    };

    const reply = (response: OpsResponse): void => {
      if (socket.writableEnded) return;
      socket.write(`${JSON.stringify(response)}\n`);
    };

    socket.on('data', (chunk: string) => {
      if (refused) return;
      buffer += chunk;

      if (buffer.length > OPS_MAX_LINE_BYTES) {
        // Checked on the *pending* buffer rather than on a completed line, so a
        // peer that never sends a newline is refused instead of growing it.
        refused = true;
        reply(
          errorResponse(
            `request too large: over ${String(OPS_MAX_LINE_BYTES)} bytes without a newline`,
            'bad-request',
          ),
        );
        socket.end();
        return;
      }

      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (line.length === 0) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (err) {
          reply(
            errorResponse(
              `could not parse the request as JSON: ${err instanceof Error ? err.message : String(err)}`,
              'bad-request',
            ),
          );
          continue;
        }
        inFlight += 1;
        void run(parsed).then((response) => {
          reply(response);
          inFlight -= 1;
          finishIfDone();
        });
      }
    });

    socket.on('end', () => {
      clientDone = true;
      finishIfDone();
    });

    socket.on('error', (err) => {
      // A client that hangs up mid-write is ordinary — Ctrl-C in the CLI does
      // it — and must not be logged as a fault or propagate anywhere.
      logger.debug(safeLogFields({ component: 'ops-socket', err }), 'ops connection error');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  // Explicitly, rather than relying on the unit's `UMask=0007`. Both should be
  // right; `docs/19` §10 names socket permissions as the thing that is simple
  // in every part and easy to get wrong as a whole, and the failure mode is a
  // socket nobody can reach.
  fs.chmodSync(socketPath, SOCKET_MODE);
  const stat = fs.statSync(socketPath);
  logger.info(
    safeLogFields({
      component: 'ops-socket',
      // Rendered as a string: an octal mode printed as decimal is a support
      // ticket. `uid`/`gid` are numbers because names need a lookup the daemon
      // has no reason to do.
      mode: (stat.mode & 0o777).toString(8),
      uid: stat.uid,
      gid: stat.gid,
    }),
    `operator socket listening on ${socketPath}`,
  );

  let closed = false;
  return {
    path: socketPath,
    serve(next: OpsHandler) {
      handle = next;
    },
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Node unlinks on a clean close, but not on every path; removing it here
      // makes "a leftover file means a crash" true, which is what the stale
      // reclaim above is allowed to assume.
      fs.rmSync(socketPath, { force: true });
    },
  };
}
