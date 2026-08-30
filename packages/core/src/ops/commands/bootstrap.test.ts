import { describe, expect, it } from 'vitest';
import { createDispatcher } from '../dispatch.js';
import { fakeOpsInstance, fakeOpsPorts, FIXTURE_GUILD_ID } from '../test-fixtures.js';
import type { OpsAuditWrite, OpsBootstrapReissue, OpsPorts } from '../ports.js';
import { bootstrapReissueCommand } from './bootstrap.js';
import { OPERATOR_COMMANDS } from '../registry.js';

const NOW = 1_700_000_000_000;
const TOKEN = 'pretend-this-came-from-randomBytes';

type Dispatched = Awaited<ReturnType<ReturnType<typeof createDispatcher>['dispatch']>>;

const armed: OpsBootstrapReissue = {
  ok: true,
  token: TOKEN,
  expiresAt: NOW + 15 * 60 * 1000,
  port: 8787,
};

interface Harness {
  run(confirm?: boolean): Promise<Dispatched>;
  readonly audit: OpsAuditWrite[];
  readonly calls: number[];
}

const harness = (outcome: OpsBootstrapReissue = armed): Harness => {
  const audit: OpsAuditWrite[] = [];
  const calls: number[] = [];
  const ports: Partial<OpsPorts> = {
    recordAudit: (input) => {
      audit.push(input);
    },
  };
  const dispatcher = createDispatcher({
    commands: [bootstrapReissueCommand],
    guildIds: [FIXTURE_GUILD_ID],
    contextFor: () => ({
      guildId: FIXTURE_GUILD_ID,
      now: () => NOW,
      ports: fakeOpsPorts(ports),
    }),
    instance: fakeOpsInstance({
      reissueBootstrapToken: () => {
        calls.push(1);
        return outcome;
      },
    }),
  });
  return {
    audit,
    calls,
    run: (confirm = true) =>
      dispatcher.dispatch({ v: 1, command: 'bootstrap reissue', args: {}, confirm }),
  };
};

describe('bootstrap reissue is registered on the operator surface (ADR 0012)', () => {
  it('appears in the command list, so `--help` shows it and the CLI can parse it', () => {
    expect(OPERATOR_COMMANDS.map((c) => c.name)).toContain('bootstrap reissue');
  });

  it('is a write, so the dispatcher demands --confirm and records an audit row', () => {
    const command = OPERATOR_COMMANDS.find((c) => c.name === 'bootstrap reissue');
    expect(command?.write).toBe(true);
  });
});

describe('bootstrap reissue', () => {
  it('refuses without --confirm, and does not reach the port', async () => {
    const h = harness();
    const response = await h.run(false);
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.code).toBe('needs-confirm');
    expect(h.calls).toHaveLength(0);
  });

  it('returns the plaintext token to the operator who asked', async () => {
    const h = harness();
    const response = await h.run();
    expect(response.ok).toBe(true);
    expect(response.ok && response.text).toContain(TOKEN);
    expect(response.ok && JSON.stringify(response.data)).toContain(TOKEN);
  });

  it('prints the URL against the configured dashboard port', async () => {
    const h = harness({ ...armed, port: 9999 });
    const response = await h.run();
    expect(response.ok && response.text).toContain('http://127.0.0.1:9999/bootstrap?token=');
  });

  it('says the daemon must be restarted, because /bootstrap is registered at startup', async () => {
    // The failure this exists to prevent: an operator reissues, opens the link
    // against the running daemon, gets a 404, and concludes the command did
    // not work. It did; the route was decided at construction.
    const h = harness();
    const response = await h.run();
    expect(response.ok && response.text).toMatch(/restart the daemon/i);
    expect(response.ok && JSON.stringify(response.data)).toContain('restartRequired');
  });

  it('tells the operator how to reach 127.0.0.1 from a laptop', async () => {
    // docs/19 §6.10: "the dashboard doesn't load" is otherwise a confusing
    // first experience, and the fix is not to change the bind.
    const h = harness();
    const response = await h.run();
    expect(response.ok && response.text).toContain('ssh -L 8787:127.0.0.1:8787');
  });

  it('reports the expiry in minutes off the injected clock', async () => {
    const h = harness();
    const response = await h.run();
    expect(response.ok && response.text).toContain('Expires in 15 minutes');
  });

  it('records an audit row', async () => {
    const h = harness();
    await h.run();
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]?.action).toBe('dashboard.bootstrap_reissued');
    expect(h.audit[0]?.subjectType).toBe('instance');
  });

  it('keeps the token out of the audit row entirely', async () => {
    // An audit row is exactly the sort of thing that ends up in an export. It
    // records that the setup page was re-armed, not the credential.
    const h = harness();
    await h.run();
    expect(JSON.stringify(h.audit[0])).not.toContain(TOKEN);
  });

  it('refuses while any dashboard account exists', async () => {
    // Re-arming on a provisioned instance would let anyone with shell access
    // mint a second owner account, with the trail showing only an issuance.
    const h = harness({ ok: false, reason: 'accounts-exist', accountCount: 2 });
    const response = await h.run();
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.message).toContain('2 dashboard account(s)');
  });

  it('records no audit row when it refuses', async () => {
    const h = harness({ ok: false, reason: 'accounts-exist', accountCount: 1 });
    await h.run();
    expect(h.audit).toHaveLength(0);
  });

  it('tells the operator what to do instead when accounts exist', async () => {
    const h = harness({ ok: false, reason: 'accounts-exist', accountCount: 1 });
    const response = await h.run();
    expect(response.ok === false && response.message).toMatch(/change it from the dashboard/);
  });

  it('refuses under BANANASAURS_READONLY and names the variable', async () => {
    const h = harness({ ok: false, reason: 'readonly' });
    const response = await h.run();
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.message).toContain('BANANASAURS_READONLY');
  });

  it('is refused by the default fixture, so a passing test had to arrange it', () => {
    // `fakeOpsInstance` returns `accounts-exist` unless a test says otherwise.
    expect(fakeOpsInstance().reissueBootstrapToken()).toMatchObject({
      ok: false,
      reason: 'accounts-exist',
    });
  });
});
