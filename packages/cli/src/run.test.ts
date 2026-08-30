import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineCommand,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_UNAVAILABLE,
  EXIT_USAGE,
  OPS_PROTOCOL_VERSION,
  type OpsErrorCode,
  type OpsResponse,
  type RegisteredCommand,
} from '@bananasaurs/core';
import { run } from './run.js';
import type { sendRequest } from './client.js';

/** Every write command must report one; `OpsWriteResult` demands it. */
const AUDIT = { action: 'test.done', subjectType: 'guild' } as const;

const catalogue: readonly RegisteredCommand[] = [
  defineCommand<Record<string, never>>({
    name: 'status',
    write: false,
    summary: 'how things are',
    args: z.object({}),
    run: () => ({ text: '', data: null }),
  }),
  defineCommand<{ state: string }>({
    name: 'killswitch',
    write: true,
    summary: 'stop or start acting',
    positional: [{ name: 'state', required: true, describe: 'on or off' }],
    args: z.object({ state: z.string() }),
    run: () => ({ text: '', data: null, audit: AUDIT }),
  }),
];

interface Capture {
  out: string[];
  err: string[];
  sent: unknown[];
}

const drive = async (
  line: string,
  reply: OpsResponse | Error,
  env: Record<string, string | undefined> = {},
): Promise<{ code: number } & Capture> => {
  const capture: Capture = { out: [], err: [], sent: [] };
  const send: typeof sendRequest = (options) => {
    capture.sent.push(options.request);
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };
  const code = await run({
    argv: line.split(' ').filter(Boolean),
    env,
    unixUser: 'bryan',
    writeOut: (t) => capture.out.push(t),
    writeErr: (t) => capture.err.push(t),
    send,
    catalogue,
  });
  return { code, ...capture };
};

const okReply = (text: string, data: unknown = null): OpsResponse => ({
  v: OPS_PROTOCOL_VERSION,
  ok: true,
  command: 'status',
  text,
  data: data as never,
});

const errReply = (code: OpsErrorCode): OpsResponse => ({
  v: OPS_PROTOCOL_VERSION,
  ok: false,
  command: 'status',
  code,
  message: `refused: ${code}`,
});

describe('the CLI', () => {
  it('prints the daemon text and exits 0', async () => {
    const result = await drive('status', okReply('all good'));
    expect(result.code).toBe(EXIT_OK);
    expect(result.out.join('')).toBe('all good\n');
  });

  it('prints data rather than text under --json', async () => {
    const result = await drive('status --json', okReply('all good', { queued: 2 }));
    expect(result.out.join('')).toContain('"queued": 2');
    expect(result.out.join('')).not.toContain('all good');
  });

  it('sends the claimed unix user, which is a claim and nothing more', async () => {
    const result = await drive('status', okReply('ok'));
    expect(result.sent[0]).toMatchObject({ unixUserClaimed: 'bryan' });
  });

  it('does not send a confirm it was not given', async () => {
    const result = await drive('killswitch on', okReply('ok'));
    expect(result.sent[0]).toMatchObject({ confirm: false });
  });

  it('sends confirm when it was given', async () => {
    const result = await drive('killswitch on --confirm', okReply('ok'));
    expect(result.sent[0]).toMatchObject({ confirm: true });
  });

  describe('exit codes, because a script reads them', () => {
    it('exits 2 for a command the CLI could not parse, without contacting the daemon', async () => {
      const result = await drive('nonsense', okReply('never'));
      expect(result.code).toBe(EXIT_USAGE);
      expect(result.sent).toEqual([]);
    });

    it('exits 2 when the daemon calls it a bad request', async () => {
      expect((await drive('status', errReply('bad-request'))).code).toBe(EXIT_USAGE);
    });

    it('exits 3 when a write was refused for want of --confirm', async () => {
      expect((await drive('killswitch on', errReply('needs-confirm'))).code).toBe(EXIT_REFUSED);
    });

    it('exits 3 when the daemon is read-only', async () => {
      expect((await drive('status', errReply('readonly'))).code).toBe(EXIT_REFUSED);
    });

    it('exits 1 when the command ran and failed', async () => {
      expect((await drive('status', errReply('failed'))).code).toBe(EXIT_FAILED);
    });

    it('exits 69 when the daemon could not be reached at all', async () => {
      const result = await drive('status', new Error('no daemon there'));
      expect(result.code).toBe(EXIT_UNAVAILABLE);
      expect(result.err.join('')).toContain('no daemon there');
    });
  });

  it('reports a refusal as JSON under --json, so an agent can branch on it', async () => {
    const result = await drive('status --json', errReply('needs-confirm'));
    expect(JSON.parse(result.err.join(''))).toMatchObject({ ok: false, code: 'needs-confirm' });
  });

  describe('the socket path', () => {
    it('takes it from the environment', async () => {
      const capture: string[] = [];
      const send: typeof sendRequest = (options) => {
        capture.push(options.socketPath);
        return Promise.resolve(okReply('ok'));
      };
      await run({
        argv: ['status'],
        env: { BANANASAURS_SOCKET_PATH: '/run/bananasaurs/admin.sock' },
        unixUser: undefined,
        writeOut: () => undefined,
        writeErr: () => undefined,
        send,
        catalogue,
      });
      expect(capture).toEqual(['/run/bananasaurs/admin.sock']);
    });

    it('lets --socket win over the environment', async () => {
      const capture: string[] = [];
      const send: typeof sendRequest = (options) => {
        capture.push(options.socketPath);
        return Promise.resolve(okReply('ok'));
      };
      await run({
        argv: ['status', '--socket', '/tmp/other.sock'],
        env: { BANANASAURS_SOCKET_PATH: '/run/bananasaurs/admin.sock' },
        unixUser: undefined,
        writeOut: () => undefined,
        writeErr: () => undefined,
        send,
        catalogue,
      });
      expect(capture).toEqual(['/tmp/other.sock']);
    });
  });

  it('prints help and exits 0 without contacting the daemon', async () => {
    const result = await drive('--help', okReply('never'));
    expect(result.code).toBe(EXIT_OK);
    expect(result.sent).toEqual([]);
    expect(result.out.join('')).toContain('bananasaurs');
  });

  it('omits the claimed user entirely when there is no passwd entry', async () => {
    const capture: unknown[] = [];
    const send: typeof sendRequest = (options) => {
      capture.push(options.request);
      return Promise.resolve(okReply('ok'));
    };
    await run({
      argv: ['status'],
      env: {},
      unixUser: undefined,
      writeOut: () => undefined,
      writeErr: () => undefined,
      send,
      catalogue,
    });
    expect(JSON.stringify(capture[0])).not.toContain('unixUserClaimed');
  });
});
