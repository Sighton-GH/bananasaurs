// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import type { RuleDetail } from '../api/automod.js';
import { renderWithSession, stubFetch } from '../test-support.js';
import { AutomodRulePage } from './automod-rule.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const detail = {
  ruleId: 'kw-one',
  kind: 'keyword_filter',
  name: 'Keyword one',
  enabled: true,
  config: '{}',
  configObject: {},
  countsAsViolation: true,
  createdAt: 1,
  updatedAt: 2,
  matchCount: 0,
  reviewedCount: 0,
  verdicts: { falsePositive: 0, truePositive: 0, unclear: 0 },
  exemptions: [],
  terms: [],
  allowlist: [],
  inviteAllowlist: [],
  linkDomains: [],
} as RuleDetail;

function open() {
  const mock = stubFetch([{ url: '/api/automod/rules/kw-one', body: detail }]);
  const { hook } = memoryLocation({ path: '/automod/kw-one' });
  renderWithSession(
    <Router hook={hook}>
      <Route path="/automod/:ruleId" component={AutomodRulePage} />
    </Router>,
  );
  return mock;
}

describe('R4 exemptions form layout contract', () => {
  it('stacks below sm, rows from sm, picker may shrink', async () => {
    const mock = open();
    await screen.findByRole('heading', { level: 2, name: 'Exemptions' });
    const form = screen.getByRole('button', { name: 'Add exemption' }).closest('form')!;
    const cls = form.className.split(/\s+/);
    expect(cls).toContain('flex-col');
    expect(cls).toContain('sm:flex-row');
    expect(cls).toContain('sm:items-end');
    expect(cls).not.toContain('flex-row');
    expect(cls).not.toContain('items-end');
    const typeCell = form.querySelector('fieldset')!.parentElement!;
    expect(typeCell.className).not.toMatch(/(^|\s)w-28(\s|$)/);
    expect(typeCell.className).toContain('sm:w-28');
    expect(typeCell.className).toContain('sm:shrink-0');
    const picker = typeCell.nextElementSibling as HTMLElement | null;
    expect(picker?.contains(screen.getByText('Search for the role this rule ignores.'))).toBe(true);
    expect(picker).toBeTruthy();
    expect(picker!.className.split(/\s+/)).toContain('w-full');
    expect(picker!.className.split(/\s+/)).toContain('min-w-0');
    expect(picker!.className.split(/\s+/)).toContain('sm:flex-1');
    // no writes on open
    expect(mock.mock.calls.every((c) => !c[1]?.method || c[1].method === 'GET')).toBe(true);
  });

  it('role and channel pickers both render in the stacked form', async () => {
    open();
    await screen.findByRole('heading', { level: 2, name: 'Exemptions' });
    expect(screen.getByText('Search for the role this rule ignores.')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Channel'));
    });
    expect(screen.getByText('Search for the channel this rule ignores.')).toBeTruthy();
  });
});
