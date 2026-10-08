import { describe, expect, it } from 'vitest';
import type { AssistantTrace } from '@bananasaurs/core';
import { PROVIDER_FAILURE_LOG_REASON, failureLogReason } from './provider-failure.js';

describe('failureLogReason', () => {
  const attempt = (
    over: Partial<AssistantTrace['attempts'][number]> = {},
  ): AssistantTrace['attempts'][number] => ({
    provider: 'openrouter',
    model: 'stealth/space-bunny-alpha',
    outcome: 'error',
    ms: 5,
    ...over,
  });

  it('names the last failed attempt title and model, never provider text', () => {
    expect(
      failureLogReason([
        attempt({
          outcome: 'error',
          code: 'provider-bad-model',
          httpStatus: 404,
          providerMessage: 'No endpoints found',
        }),
      ]),
    ).toBe('This model is not available on this key — stealth/space-bunny-alpha');
  });

  it('falls back when no attempt has a known code', () => {
    expect(failureLogReason([])).toBe(PROVIDER_FAILURE_LOG_REASON);
  });

  it('uses a lone skipped local-limit attempt', () => {
    expect(
      failureLogReason([attempt({ outcome: 'skipped', code: 'local-rpm-limit', model: 'm-a' })]),
    ).toBe('This model reached its per-minute limit — m-a');
  });
});
