import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OPS_MAX_LINE_BYTES, OPS_PROTOCOL_VERSION, type OpsResponse } from '@bananasaurs/core';
import { bindOpsSocket, SocketInUseError, type OpsSocketServer } from './socket.js';

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  fatal: () => undefined,
  trace: () => undefined,
} as unknown as Parameters<typeof bindOpsSocket>[0]['logger'];

let dir: string;
let socketPath: string;
const open: OpsSocketServer[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bananasaurs-ops-'));
  socketPath = path.join(dir, 'admin.sock');
});

afterEach(async () => {
  for (const server of open.splice(0)) await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const bind = async (over: Partial<Parameters<typeof bindOpsSocket>[0]> = {}) => {
  const server = await bindOpsSocket({ socketPath, logger: silent, ...over });
  open.push(server);
  return server;
};

const ok = (command: string, text: string): OpsResponse => ({
  v: OPS_PROTOCOL_VERSION,
  ok: true,
  command,
  text,
  data: null,
});

/** Sends raw bytes and collects every response line until the server closes. */
const sendRaw = (payload: string): Promise<string[]> =>
  new Promise((resolve, reject) => {
    const lines: string[] = [];
    let buffer = '';
    const client = net.createConnection(socketPath);
    client.setEncoding('utf8');
    // Write, then half-close: "that is all I am sending". The server answers
    // and ends, which is what makes `close` the natural end of the exchange.
    client.on('connect', () => client.end(payload));
    client.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        lines.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    });
    client.on('error', reject);
    client.on('close', () => {
      resolve(lines);
    });
  });

const sendOne = async (request: unknown): Promise<unknown> => {
  const lines = await sendRaw(`${JSON.stringify(request)}\n`);
  expect(lines.length).toBeGreaterThan(0);
  return JSON.parse(lines[0] ?? 'null');
};

describe('the operator socket', () => {
  it('binds before a handler exists, which is what lets it guard the database open', async () => {
    const server = await bind();
    expect(fs.existsSync(socketPath)).toBe(true);
    expect(server.path).toBe(socketPath);
  });

  it('refuses a request that arrives before the daemon has finished starting', async () => {
    await bind();
    const res = (await sendOne({ v: 1, command: 'status' })) as { ok: boolean; code: string };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('failed');
  });

  it('carries a request to the handler and its response back', async () => {
    const server = await bind();
    const seen: unknown[] = [];
    server.serve((raw) => {
      seen.push(raw);
      return Promise.resolve(ok('status', 'all good'));
    });
    const res = (await sendOne({ v: 1, command: 'status' })) as { text: string };
    expect(seen).toEqual([{ v: 1, command: 'status' }]);
    expect(res.text).toBe('all good');
  });

  it('creates the socket mode 0660, so only the ops group can reach it', async () => {
    await bind();
    // Masked to the permission bits; the file type bits are not ours to set.
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o660);
  });

  it('handles two requests on one connection, in order', async () => {
    const server = await bind();
    server.serve((raw) => {
      const command = (raw as { command: string }).command;
      return Promise.resolve(ok(command, `ran ${command}`));
    });
    const lines = await sendRaw(
      `${JSON.stringify({ v: 1, command: 'one' })}\n${JSON.stringify({ v: 1, command: 'two' })}\n`,
    );
    expect(lines.map((l) => (JSON.parse(l) as { text: string }).text)).toEqual([
      'ran one',
      'ran two',
    ]);
  });

  it('answers unparseable JSON with a bad-request rather than closing silently', async () => {
    const server = await bind();
    server.serve(() => Promise.resolve(ok('x', 'never')));
    const lines = await sendRaw('{not json\n');
    const res = JSON.parse(lines[0] ?? 'null') as { ok: boolean; code: string };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('bad-request');
  });

  it('ignores a blank line rather than treating it as a request', async () => {
    const server = await bind();
    server.serve(() => Promise.resolve(ok('x', 'ran')));
    const lines = await sendRaw(`\n\n${JSON.stringify({ v: 1, command: 'x' })}\n`);
    expect(lines).toHaveLength(1);
  });

  it('refuses a line larger than the cap instead of buffering without bound', async () => {
    const server = await bind();
    server.serve(() => Promise.resolve(ok('x', 'ran')));
    // No newline anywhere: a peer that never terminates a line is the DoS the
    // cap exists for, and it is reachable by anyone in the ops group.
    const lines = await sendRaw('x'.repeat(OPS_MAX_LINE_BYTES + 1));
    const res = JSON.parse(lines[0] ?? 'null') as { ok: boolean; code: string; message: string };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('bad-request');
    expect(res.message).toMatch(/too large/i);
  });

  it('survives a handler that throws, and answers rather than dying', async () => {
    const server = await bind();
    server.serve(() => Promise.reject(new Error('handler exploded')));
    const res = (await sendOne({ v: 1, command: 'x' })) as { ok: boolean; code: string };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('failed');
  });

  it('serialises concurrent requests, so two writes never interleave', async () => {
    const server = await bind();
    const order: string[] = [];
    let release: (() => void) | undefined;
    server.serve(async (raw) => {
      const command = (raw as { command: string }).command;
      order.push(`start ${command}`);
      if (command === 'slow') await new Promise<void>((r) => (release = r));
      order.push(`end ${command}`);
      return ok(command, 'done');
    });

    const slow = sendOne({ v: 1, command: 'slow' });
    // Give the first request time to be read and started before the second.
    await new Promise((r) => setTimeout(r, 20));
    const fast = sendOne({ v: 1, command: 'fast' });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['start slow']);
    release?.();
    await Promise.all([slow, fast]);
    expect(order).toEqual(['start slow', 'end slow', 'start fast', 'end fast']);
  });

  describe('the single-writer guard (docs/19 amendment 1)', () => {
    it('refuses to start when another daemon is already listening on the path', async () => {
      await bind();
      await expect(bind()).rejects.toBeInstanceOf(SocketInUseError);
    });

    it('names the socket path in the refusal, so the operator knows which instance', async () => {
      await bind();
      await expect(bind()).rejects.toThrow(socketPath);
    });

    it('reclaims a stale socket file left by a crash', async () => {
      const stale = await bind();
      await stale.close();
      // A crash leaves the file behind; listen() on it fails EADDRINUSE even
      // though nothing is listening, which is why a bare retry is not enough.
      fs.writeFileSync(socketPath, '');
      const server = await bind();
      server.serve(() => Promise.resolve(ok('x', 'reclaimed')));
      const res = (await sendOne({ v: 1, command: 'x' })) as { text: string };
      expect(res.text).toBe('reclaimed');
    });

    it('reports the reclaim rather than doing it silently', async () => {
      fs.writeFileSync(socketPath, '');
      const warnings: string[] = [];
      await bind({
        logger: {
          ...silent,
          warn: (_fields: unknown, message: string) => {
            warnings.push(message);
          },
        } as unknown as Parameters<typeof bindOpsSocket>[0]['logger'],
      });
      expect(warnings.join(' ')).toMatch(/stale/i);
    });

    it('creates the parent directory rather than failing on a fresh host', async () => {
      const nested = path.join(dir, 'run', 'bananasaurs', 'admin.sock');
      const server = await bind({ socketPath: nested });
      expect(fs.existsSync(nested)).toBe(true);
      await server.close();
    });
  });

  it('removes the socket file on close, so a restart is not a reclaim', async () => {
    const server = await bind();
    await server.close();
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('is idempotent on close, because shutdown paths call it more than once', async () => {
    const server = await bind();
    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
  });
});
