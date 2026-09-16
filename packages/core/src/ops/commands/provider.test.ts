import { describe, expect, it } from 'vitest';
import { createDispatcher } from '../dispatch.js';
import { fakeOpsInstance, fakeOpsPorts, FIXTURE_GUILD_ID } from '../test-fixtures.js';
import type { OpsAuditWrite, OpsProviderReview } from '../ports.js';
import { OPERATOR_COMMANDS } from '../registry.js';
import { providerReviewCommand } from './provider.js';

const NOW = 1_700_000_000_000;
const REVIEWED_AT = 1_789_344_000_000;

type Dispatched = Awaited<ReturnType<ReturnType<typeof createDispatcher>['dispatch']>>;

interface Harness {
  run(args?: Record<string, unknown>, confirm?: boolean): Promise<Dispatched>;
  readonly audit: OpsAuditWrite[];
  readonly calls: string[];
}

const harness = (
  review: (provider: string) => OpsProviderReview | 'no-such-provider',
): Harness => {
  const audit: OpsAuditWrite[] = [];
  const calls: string[] = [];
  const dispatcher = createDispatcher({
    commands: [providerReviewCommand],
    guildIds: [FIXTURE_GUILD_ID],
    contextFor: () => ({
      guildId: FIXTURE_GUILD_ID,
      now: () => NOW,
      ports: fakeOpsPorts({
        recordAudit: (input) => {
          audit.push(input);
        },
      }),
    }),
    instance: fakeOpsInstance({
      providerReview: (provider) => {
        calls.push(provider);
        return review(provider);
      },
    }),
  });
  return {
    audit,
    calls,
    run: (args = { provider: 'anthropic-consumer-mcp' }, confirm = true) =>
      dispatcher.dispatch({ v: 1, command: 'provider review', args, confirm }),
  };
};

const reviewed = (
  over: Partial<OpsProviderReview> = {},
): OpsProviderReview => ({
  provider: 'anthropic-consumer-mcp',
  trainsOnInput: 'no',
  evidenceUrl: 'https://claude.ai/settings/data-privacy-controls',
  productionUseAllowed: true,
  reviewedAt: REVIEWED_AT,
  previouslyReviewedAt: REVIEWED_AT - 10 * 24 * 60 * 60 * 1000,
  ...over,
});

describe('provider review is registered on the operator surface', () => {
  it('appears in the command list as a write', () => {
    expect(OPERATOR_COMMANDS.map((c) => c.name)).toContain('provider review');
    expect(OPERATOR_COMMANDS.find((c) => c.name === 'provider review')?.write).toBe(true);
  });
});

describe('provider review', () => {
  it('writes the review and audits what was confirmed', async () => {
    const h = harness(() => reviewed());
    const response = await h.run();
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.ok && response.text).toContain('anthropic-consumer-mcp');
    expect(response.ok && response.text).toContain('cleared');
    expect(h.calls).toEqual(['anthropic-consumer-mcp']);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: 'provider.reviewed',
      subjectType: 'provider',
      subjectId: 'anthropic-consumer-mcp',
      before: { reviewedAt: reviewed().previouslyReviewedAt },
      after: {
        reviewedAt: REVIEWED_AT,
        trainsOnInput: 'no',
        productionUseAllowed: true,
      },
    });
  });

  it('throws for an unknown provider, and audits nothing', async () => {
    const h = harness(() => 'no-such-provider');
    const response = await h.run({ provider: 'ghost' });
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.message).toContain('ghost');
    expect(h.audit).toHaveLength(0);
  });

  it('refuses without --confirm and never reaches the instance', async () => {
    const h = harness(() => reviewed());
    const response = await h.run({ provider: 'anthropic-consumer-mcp' }, false);
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.code).toBe('needs-confirm');
    expect(h.calls).toHaveLength(0);
    expect(h.audit).toHaveLength(0);
  });

  it("warns on a not-'no' row, and does not claim the warning is cleared", async () => {
    const h = harness(() => reviewed({ trainsOnInput: 'yes' }));
    const response = await h.run();
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.ok && response.text).toContain('WARNING');
    expect(response.ok && response.text).not.toContain('cleared');
    expect(h.audit).toHaveLength(1);
  });

  it('says production use is still not allowed on a not-production row', async () => {
    const h = harness(() => reviewed({ productionUseAllowed: false }));
    const response = await h.run();
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.ok && response.text).toContain('production use is still not allowed');
    expect(h.audit).toHaveLength(1);
  });
});
