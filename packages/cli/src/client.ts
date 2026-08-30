import net from 'node:net';
import { opsResponseSchema, OPS_MAX_LINE_BYTES, type OpsResponse } from '@bananasaurs/core';

/**
 * One request over the admin socket, one response back.
 *
 * Connect, write the request line, half-close, read until EOF. The half-close
 * is the protocol's "that is all I am sending"; the daemon answers and ends.
 *
 * **The client validates the response too.** Not symmetry for its own sake: the
 * socket path is configurable, so this connects to whatever is at
 * `BANANASAURS_SOCKET_PATH`, and a CLI that trusted arbitrary JSON from an
 * arbitrary path to be a well-formed response would be a strange place to stop
 * being careful.
 */

/** The socket could not be reached at all — as distinct from a command failing. */
export class SocketUnreachableError extends Error {
  override readonly name = 'SocketUnreachableError';
  constructor(socketPath: string, cause: NodeJS.ErrnoException) {
    super(explain(socketPath, cause));
  }
}

const explain = (socketPath: string, cause: NodeJS.ErrnoException): string => {
  switch (cause.code) {
    case 'ENOENT':
      return (
        `no Bananasaurs is listening at ${socketPath}.\n\n` +
        `  The daemon creates this socket at startup, so this usually means it is\n` +
        `  not running: \`systemctl status bananasaurs\`. If it is running with a\n` +
        `  different BANANASAURS_SOCKET_PATH, pass --socket.`
      );
    case 'ECONNREFUSED':
      return (
        `${socketPath} exists but nothing is listening on it.\n\n` +
        `  That is what a crashed daemon leaves behind. The next start reclaims it.`
      );
    case 'EACCES':
      return (
        `not permitted to open ${socketPath}.\n\n` +
        `  The socket is mode 0660, group bananasaurs-ops, and group membership is\n` +
        `  what grants access (docs/17 §2.1). Check \`id\`; a group added to your\n` +
        `  account does not apply to sessions that were already open.`
      );
    default:
      return `could not reach ${socketPath}: ${cause.message}`;
  }
};

export interface SendOptions {
  readonly socketPath: string;
  readonly request: unknown;
  /** Milliseconds before giving up. A hung daemon must not hang the terminal. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function sendRequest(options: SendOptions): Promise<OpsResponse> {
  const { socketPath, request } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<OpsResponse>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs);

    let buffer = '';
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    socket.on('connect', () => {
      socket.end(`${JSON.stringify(request)}\n`);
    });

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > OPS_MAX_LINE_BYTES) {
        settle(() => reject(new Error(`the daemon sent more than one response line's worth`)));
        return;
      }
      const index = buffer.indexOf('\n');
      if (index < 0) return;

      const line = buffer.slice(0, index);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        settle(() => reject(new Error(`the daemon sent something that is not JSON: ${line}`)));
        return;
      }
      const response = opsResponseSchema.safeParse(parsed);
      if (!response.success) {
        settle(() =>
          reject(
            new Error(
              `the daemon sent a response this CLI does not understand. ` +
                `A version mismatch between the CLI and the running daemon is the ` +
                `usual cause; both come from the same build.`,
            ),
          ),
        );
        return;
      }
      settle(() => resolve(response.data));
    });

    socket.on('timeout', () => {
      settle(() => reject(new Error(`the daemon did not answer within ${String(timeoutMs)}ms`)));
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      settle(() => reject(new SocketUnreachableError(socketPath, err)));
    });

    socket.on('close', () => {
      settle(() => reject(new Error(`the daemon closed the connection without answering`)));
    });
  });
}
