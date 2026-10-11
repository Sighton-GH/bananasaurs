import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTER_RULES, orderChainByTier, routeRun, type RouteInput } from './router.js';

const input = (over: Partial<RouteInput> = {}): RouteInput => ({
  text: 'hi',
  hasAttachments: false,
  hasQuoteOrReply: false,
  earlierTurns: 0,
  ...over,
});

describe('routeRun (ADR 0144, spec 6e)', () => {
  it.each([
    ['hi', 'light'],
    ['thanks!', 'light'],
    ['remind me at 5', 'standard'],
    ['can you ping Sam L', 'standard'],
    ['search the web for TRIUMF tours', 'standard'],
    ['write a story about a racerbot', 'standard'],
  ] as const)('%s routes %s', (text, tier) => {
    expect(routeRun(input({ text }), DEFAULT_ROUTER_RULES).tier).toBe(tier);
  });
  it('routes an 81-character plain message to standard under the default 80', () => {
    const text = 'x'.repeat(81);
    expect(routeRun(input({ text }), DEFAULT_ROUTER_RULES)).toEqual({
      tier: 'standard',
      reason: 'long-message',
    });
  });
  it('routes attachments, quotes and long threads to standard', () => {
    expect(routeRun(input({ text: 'look at this' }), DEFAULT_ROUTER_RULES).tier).toBe('light');
    expect(
      routeRun(input({ text: 'look at this', hasAttachments: true }), DEFAULT_ROUTER_RULES),
    ).toEqual({
      tier: 'standard',
      reason: 'has-attachments',
    });
    expect(
      routeRun(input({ text: 'look at this', hasQuoteOrReply: true }), DEFAULT_ROUTER_RULES),
    ).toEqual({ tier: 'standard', reason: 'has-quote' });
    expect(routeRun(input({ text: 'and then?', earlierTurns: 5 }), DEFAULT_ROUTER_RULES)).toEqual({
      tier: 'standard',
      reason: 'long-thread',
    });
  });
  it('routes greetings with attachments or quotes to standard', () => {
    expect(routeRun(input({ text: 'hi', hasAttachments: true }), DEFAULT_ROUTER_RULES)).toEqual({
      tier: 'standard',
      reason: 'has-attachments',
    });
    expect(
      routeRun(input({ text: 'thanks', hasQuoteOrReply: true }), DEFAULT_ROUTER_RULES),
    ).toEqual({
      tier: 'standard',
      reason: 'has-quote',
    });
  });
  it('keeps a greeting light inside a long thread', () => {
    expect(routeRun(input({ text: 'thanks!', earlierTurns: 9 }), DEFAULT_ROUTER_RULES)).toEqual({
      tier: 'light',
      reason: 'greeting',
    });
  });
  it('always selects standard when disabled', () => {
    expect(routeRun(input({ text: 'hi' }), { ...DEFAULT_ROUTER_RULES, enabled: false })).toEqual({
      tier: 'standard',
      reason: 'router-off',
    });
  });
  it('pins the spec defaults', () => {
    expect(DEFAULT_ROUTER_RULES).toMatchObject({
      enabled: true,
      maxChars: 80,
      longThreadTurns: 4,
      escalateOnTool: true,
    });
    expect(DEFAULT_ROUTER_RULES.fullModelKeywords).toContain('remind');
    expect(DEFAULT_ROUTER_RULES.fullModelKeywords).toHaveLength(17);
  });
});

describe('orderChainByTier', () => {
  const entries = [
    { id: 's1', tier: 'standard' as const },
    { id: 'l1', tier: 'light' as const },
    { id: 's2', tier: 'standard' as const },
  ];
  it('tries light first on a light run, standard first on a standard run', () => {
    expect(orderChainByTier(entries, 'light').map((e) => e.id)).toEqual(['l1', 's1', 's2']);
    expect(orderChainByTier(entries, 'standard').map((e) => e.id)).toEqual(['s1', 's2', 'l1']);
  });
});
