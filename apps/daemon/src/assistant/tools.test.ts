import { describe, expect, it, vi } from 'vitest';
import type { ClubResource } from '@bananasaurs/core';
import { runAssistantTool, toolDeclarations, type AssistantToolPorts } from './tools.js';

const NOW = Date.UTC(2026, 8, 23, 19, 30); // 12:30 in Vancouver (PDT)
const MEMBER = '456789012345678901';

const resource = (over: Partial<ClubResource> = {}): ClubResource => ({
  id: 'handbook',
  guildId: '234567890123456789',
  title: 'Club handbook',
  url: 'https://example.com/handbook',
  kind: 'document',
  enabled: true,
  reviewedAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

const ports = (over: Partial<AssistantToolPorts> = {}): AssistantToolPorts => ({
  userId: MEMBER,
  now: () => NOW,
  timeZone: 'America/Vancouver',
  searchArchive: vi.fn(async () => [
    {
      channelId: '111111111111111111',
      messageId: '222222222222222222',
      createdAt: NOW - 60_000,
      excerpt: 'The [battery] order ships Friday.',
    },
  ]),
  resources: () => [resource(), resource({ id: 'off', title: 'Old', enabled: false })],
  fetchResource: vi.fn(async () => ({
    ok: true as const,
    cache: 'miss' as const,
    evidence: {
      url: 'https://example.com/handbook',
      mediaType: 'text/html',
      text: 'Meetings are Mondays. Contact lead@example.com.',
      fetchedAt: NOW,
      trust: 'untrusted-reviewed-resource' as const,
    },
  })),
  webSearch: vi.fn(async () => [
    { title: 'Battery guide', url: 'https://batteries.example/guide', description: 'LiPo care.' },
  ]),
  serverCard: () => 'SFU Racerbot builds autonomous cars.',
  visibleChannels: vi.fn(async () => [{ id: '111111111111111111', name: 'general' }]),
  reminders: () => [
    {
      id: 'r1',
      guildId: '234567890123456789',
      creatorId: MEMBER,
      destinationId: '111111111111111111',
      text: 'Bring the charger',
      dueAt: NOW + 3_600_000,
      createdAt: NOW,
      status: 'scheduled',
      dedupeKey: 'k1',
    },
    {
      id: 'r2',
      guildId: '234567890123456789',
      creatorId: '999999999999999999',
      destinationId: '111111111111111111',
      text: 'Someone else',
      dueAt: NOW + 3_600_000,
      createdAt: NOW,
      status: 'scheduled',
      dedupeKey: 'k2',
    },
  ],
  ...over,
});

describe('toolDeclarations', () => {
  it('offers web_search only when search is available', () => {
    const names = (p: AssistantToolPorts) => toolDeclarations(p).map((tool) => tool.name);
    expect(names(ports())).toEqual([
      'search_archive',
      'open_resource',
      'web_search',
      'server_info',
      'current_time',
      'my_reminders',
    ]);
    expect(names(ports({ webSearch: undefined }))).not.toContain('web_search');
  });
});

describe('runAssistantTool', () => {
  it('refuses an unknown tool and malformed arguments without running anything', async () => {
    const p = ports();
    await expect(runAssistantTool({ name: 'delete_channel', args: {} }, p)).resolves.toMatchObject({
      ok: false,
      text: 'Unknown tool.',
    });
    await expect(
      runAssistantTool({ name: 'search_archive', args: { query: '' } }, p),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      runAssistantTool({ name: 'web_search', args: { query: 5 } }, p),
    ).resolves.toMatchObject({ ok: false });
    expect(p.searchArchive).not.toHaveBeenCalled();
    expect(p.webSearch).not.toHaveBeenCalled();
  });

  it('searches the archive as the asking member and links each hit', async () => {
    const p = ports();
    const result = await runAssistantTool(
      { name: 'search_archive', args: { query: 'battery' } },
      p,
    );
    expect(p.searchArchive).toHaveBeenCalledWith('battery');
    expect(result.ok).toBe(true);
    expect(result.text).toContain('The [battery] order ships Friday.');
    expect(result.text).toContain('<#111111111111111111>');
  });

  it('opens only an enabled resource, redacted like other evidence', async () => {
    const p = ports();
    const opened = await runAssistantTool(
      { name: 'open_resource', args: { resourceId: 'handbook' } },
      p,
    );
    expect(opened).toMatchObject({
      ok: true,
      sources: [{ title: 'Club handbook', url: 'https://example.com/handbook' }],
    });
    expect(opened.text).toContain('Meetings are Mondays.');
    expect(opened.text).not.toContain('lead@example.com');
    await expect(
      runAssistantTool({ name: 'open_resource', args: { resourceId: 'off' } }, p),
    ).resolves.toMatchObject({ ok: false, text: 'No enabled resource has that id.' });
  });

  it('returns web results with their links as sources and marks them as Brave results', async () => {
    const result = await runAssistantTool(
      { name: 'web_search', args: { query: 'lipo storage' } },
      ports(),
    );
    expect(result).toMatchObject({
      ok: true,
      web: true,
      sources: [{ title: 'Battery guide', url: 'https://batteries.example/guide' }],
    });
    expect(result.text).toContain('LiPo care.');
  });

  it('refuses a web query that looks like it carries personal data or a secret', async () => {
    const p = ports();
    const result = await runAssistantTool(
      { name: 'web_search', args: { query: 'who owns lead@example.com' } },
      p,
    );
    expect(result).toMatchObject({ ok: false });
    expect(p.webSearch).not.toHaveBeenCalled();
  });

  it('reports a failed web search as a tool error, not a thrown request', async () => {
    const result = await runAssistantTool(
      { name: 'web_search', args: { query: 'lipo' } },
      ports({
        webSearch: vi.fn(async () => {
          throw new Error('HTTP 429');
        }),
      }),
    );
    expect(result).toMatchObject({ ok: false, text: 'Web search failed: HTTP 429' });
  });

  it('gives the time in the club time zone', async () => {
    const result = await runAssistantTool({ name: 'current_time', args: {} }, ports());
    expect(result.text).toContain('12:30');
    expect(result.text).toContain('America/Vancouver');
  });

  it("lists only the asking member's own upcoming reminders", async () => {
    const result = await runAssistantTool({ name: 'my_reminders', args: {} }, ports());
    expect(result.text).toContain('Bring the charger');
    expect(result.text).not.toContain('Someone else');
  });

  it('gives the server card and the channels the member can view', async () => {
    const result = await runAssistantTool({ name: 'server_info', args: {} }, ports());
    expect(result.text).toContain('SFU Racerbot builds autonomous cars.');
    expect(result.text).toContain('#general');
  });
});
