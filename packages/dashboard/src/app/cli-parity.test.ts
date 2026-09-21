import { describe, expect, it } from 'vitest';
import { OPERATOR_COMMANDS } from '@bananasaurs/core';
import { CLI_WEB_PARITY } from './cli-parity.js';

describe('CLI-to-web parity (owner acceptance standard, 2026-09-20)', () => {
  it('every operator command is covered by a page/control or a reasoned exception', () => {
    const missing = OPERATOR_COMMANDS.filter((command) => !(command.name in CLI_WEB_PARITY));
    expect(missing.map((command) => command.name)).toEqual([]);
  });

  it('no stale entries survive a renamed or removed command', () => {
    const names = new Set(OPERATOR_COMMANDS.map((command) => command.name));
    const stale = Object.keys(CLI_WEB_PARITY).filter((name) => !names.has(name));
    expect(stale).toEqual([]);
  });

  it('exceptions name their reason; covered entries name page and control', () => {
    for (const [name, entry] of Object.entries(CLI_WEB_PARITY)) {
      if (entry.kind === 'exception') {
        expect(entry.reason.length, name).toBeGreaterThan(20);
      } else {
        expect(entry.page.length, name).toBeGreaterThan(0);
        expect(entry.control.length, name).toBeGreaterThan(0);
      }
    }
  });
});
