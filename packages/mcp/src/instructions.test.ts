import { describe, expect, it } from 'vitest';
import { MCP_SERVER_INSTRUCTIONS } from './instructions.js';

/**
 * Slice 2, Task 1, Step 1: the `initialize` instructions name the tooling
 * contract (`get_server_overview`, `idempotencyKey`, `evidence`) and the
 * Discord Markdown subset (`<t:UNIX:R>`, the 2,000-character limit), in one
 * short static string. The server half — `initialize` returns this exact
 * text — is pinned in `server.test.ts`.
 */
describe('MCP_SERVER_INSTRUCTIONS', () => {
  it('names the first tool, idempotency keys and the evidence contract', () => {
    expect(MCP_SERVER_INSTRUCTIONS).toContain('get_server_overview');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('idempotencyKey');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('evidence');
  });

  it('covers Discord Markdown timestamps and the message length limit', () => {
    expect(MCP_SERVER_INSTRUCTIONS).toContain('<t:UNIX:R>');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('2,000');
  });

  it('stays a short static string', () => {
    // Slice 4 added the Roles section (seven lines for fourteen facts), so
    // the cap grew from 3000; the string is still one short static text.
    expect(MCP_SERVER_INSTRUCTIONS.length).toBeLessThan(3500);
  });

  it('has a Roles section with the grant policy, bulk preview rules and panel limits', () => {
    expect(MCP_SERVER_INSTRUCTIONS).toContain('Roles');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('100 members');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('single-use');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('10 minutes');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('invalidates the token');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('get_job');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('cannot be undone');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('{create}');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('colour');
  });

  it('has a Writes section naming keys, dry runs, undo, explicit pings and private threads', () => {
    expect(MCP_SERVER_INSTRUCTIONS).toContain('Writes');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('dryRun');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('undo_action');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('list_actions');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('pingRoles');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('pingUsers');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('Private threads');
  });
});
