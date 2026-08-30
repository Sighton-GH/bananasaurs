import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineCommand, OPERATOR_COMMANDS, type RegisteredCommand } from '@bananasaurs/core';
import { parseArgv } from './args.js';

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
  defineCommand<{ on: boolean }>({
    name: 'killswitch',
    write: true,
    summary: 'stop or start acting',
    positional: [{ name: 'state', required: true, describe: 'on or off' }],
    args: z.object({ on: z.boolean() }),
    run: () => ({ text: '', data: null, audit: AUDIT }),
  }),
  // Deliberately nested: `log` is a command in its own right *and* a prefix of
  // `log routing set`. Without a pair like this, "longest match wins" is a rule
  // no test can distinguish from "any match wins" — which is how mutation 120
  // survived the first version of this file.
  defineCommand<Record<string, never>>({
    name: 'log',
    write: false,
    summary: 'the log module',
    args: z.object({}),
    run: () => ({ text: '', data: null }),
  }),
  defineCommand<{ eventKind: string; channelId: string }>({
    name: 'log routing set',
    write: true,
    summary: 'route an event kind to a channel',
    positional: [
      { name: 'eventKind', required: true, describe: 'the event kind' },
      { name: 'channelId', required: true, describe: 'the channel' },
    ],
    args: z.object({ eventKind: z.string(), channelId: z.string() }),
    run: () => ({ text: '', data: null, audit: AUDIT }),
  }),
  defineCommand<{ limit: number; failed: boolean }>({
    name: 'audit tail',
    write: false,
    summary: 'the audit trail',
    flags: [
      { name: 'n', kind: 'number', describe: 'how many' },
      { name: 'failed', kind: 'boolean', describe: 'only failures' },
    ],
    args: z.object({ limit: z.number(), failed: z.boolean() }),
    run: () => ({ text: '', data: null }),
  }),
];

const parse = (line: string) => parseArgv(line.split(' ').filter(Boolean), catalogue);

describe('the CLI argument parser', () => {
  it('finds a one-word command', () => {
    const parsed = parse('status');
    expect(parsed.kind).toBe('request');
    if (parsed.kind !== 'request') return;
    expect(parsed.request.command).toBe('status');
    expect(parsed.request.args).toEqual({});
  });

  it('prefers the longest matching command name over a shorter one that also matches', () => {
    // `log` is itself a command here, so a parser that took the first or the
    // shortest match would read this as `log` with four stray arguments — and
    // would then report a usage error about arguments the operator did give.
    const parsed = parse('log routing set message_delete 123');
    expect(parsed.kind).toBe('request');
    if (parsed.kind !== 'request') return;
    expect(parsed.request.command).toBe('log routing set');
    expect(parsed.request.args).toEqual({ eventKind: 'message_delete', channelId: '123' });
  });

  it('still finds the shorter command when the longer one does not match', () => {
    const parsed = parse('log');
    expect(parsed.kind).toBe('request');
    if (parsed.kind !== 'request') return;
    expect(parsed.request.command).toBe('log');
  });

  it('reports an unknown command rather than sending it to the daemon', () => {
    const parsed = parse('rm -rf');
    expect(parsed.kind).toBe('usage');
    if (parsed.kind !== 'usage') return;
    expect(parsed.message).toMatch(/rm/);
  });

  it('reports a missing required positional', () => {
    const parsed = parse('log routing set message_delete --confirm');
    expect(parsed.kind).toBe('usage');
    if (parsed.kind !== 'usage') return;
    expect(parsed.message).toMatch(/channelId/);
  });

  it('reports an extra positional rather than dropping it silently', () => {
    const parsed = parse('status extra');
    expect(parsed.kind).toBe('usage');
    if (parsed.kind !== 'usage') return;
    expect(parsed.message).toMatch(/extra/);
  });

  describe('the global flags', () => {
    it('carries --guild through to the request', () => {
      const parsed = parse('status --guild 123456789012345678');
      expect(parsed.kind).toBe('request');
      if (parsed.kind !== 'request') return;
      expect(parsed.request.guildId).toBe('123456789012345678');
    });

    it('omits guildId entirely when --guild was not given', () => {
      const parsed = parse('status');
      expect(parsed.kind).toBe('request');
      if (parsed.kind !== 'request') return;
      expect(parsed.request.guildId).toBeUndefined();
    });

    it('carries --confirm through as a boolean', () => {
      const parsed = parse('killswitch on --confirm');
      expect(parsed.kind).toBe('request');
      if (parsed.kind !== 'request') return;
      expect(parsed.request.confirm).toBe(true);
    });

    it('defaults confirm to false, so a write is refused unless it is asked for', () => {
      const parsed = parse('killswitch on');
      expect(parsed.kind).toBe('request');
      if (parsed.kind !== 'request') return;
      expect(parsed.request.confirm).toBe(false);
    });

    it('records --json on the invocation, not in the request', () => {
      // Output format is the client's business; the daemon always answers both.
      const parsed = parse('status --json');
      expect(parsed.kind).toBe('request');
      if (parsed.kind !== 'request') return;
      expect(parsed.json).toBe(true);
      expect(JSON.stringify(parsed.request)).not.toContain('json');
    });

    it('carries --socket, which is not part of the request either', () => {
      const parsed = parse('status --socket /run/x/admin.sock');
      expect(parsed.kind).toBe('request');
      if (parsed.kind !== 'request') return;
      expect(parsed.socketPath).toBe('/run/x/admin.sock');
    });

    it('reports a global flag that was given without its value', () => {
      const parsed = parse('status --guild');
      expect(parsed.kind).toBe('usage');
      if (parsed.kind !== 'usage') return;
      expect(parsed.message).toMatch(/--guild/);
    });
  });

  describe('per-command flags', () => {
    it('coerces a number flag', () => {
      const parsed = parse('audit tail -n 50');
      expect(parsed.kind).toBe('request');
      if (parsed.kind !== 'request') return;
      expect(parsed.request.args).toEqual({ n: 50 });
    });

    it('accepts a boolean flag with no value', () => {
      const parsed = parse('audit tail --failed');
      expect(parsed.kind).toBe('request');
      if (parsed.kind !== 'request') return;
      expect(parsed.request.args).toEqual({ failed: true });
    });

    it('refuses a number flag that is not a number, rather than sending NaN', () => {
      const parsed = parse('audit tail -n lots');
      expect(parsed.kind).toBe('usage');
      if (parsed.kind !== 'usage') return;
      expect(parsed.message).toMatch(/-n/);
    });

    it('refuses a flag the command does not declare', () => {
      const parsed = parse('status --wat 1');
      expect(parsed.kind).toBe('usage');
      if (parsed.kind !== 'usage') return;
      expect(parsed.message).toMatch(/--wat/);
    });
  });

  describe('help', () => {
    it('prints the surface with no arguments at all', () => {
      const parsed = parse('');
      expect(parsed.kind).toBe('help');
    });

    it('prints the surface for --help', () => {
      expect(parse('--help').kind).toBe('help');
    });

    it('prints help for one command', () => {
      const parsed = parse('log routing set --help');
      expect(parsed.kind).toBe('help');
      if (parsed.kind !== 'help') return;
      expect(parsed.text).toContain('log routing set');
      expect(parsed.text).toContain('eventKind');
    });

    it('marks a write command as needing --confirm in its help', () => {
      const parsed = parse('--help');
      expect(parsed.kind).toBe('help');
      if (parsed.kind !== 'help') return;
      expect(parsed.text).toMatch(/killswitch.*--confirm/s);
    });
  });

  it('parses the real command surface, so the catalogue and the CLI cannot drift', () => {
    for (const command of OPERATOR_COMMANDS) {
      const words = command.name.split(' ');
      const positional = command.positional.filter((p) => p.required).map(() => 'x');
      const argv = [...words, ...positional, ...(command.write ? ['--confirm'] : [])];
      const parsed = parseArgv(argv, OPERATOR_COMMANDS);
      expect(parsed.kind, `${command.name} did not parse: ${JSON.stringify(parsed)}`).toBe(
        'request',
      );
    }
  });
});
