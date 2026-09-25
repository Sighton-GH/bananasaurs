import { describe, expect, it, vi } from 'vitest';
import { TOOL_CATALOGUE, type ClubResource } from '@bananasaurs/core';
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

  it('never drifts from TOOL_CATALOGUE: every declaration equals its catalogue entry', () => {
    const declared = toolDeclarations(ports());
    expect(declared).toHaveLength(TOOL_CATALOGUE.length);
    for (const entry of TOOL_CATALOGUE) {
      const declaration = declared.find((d) => d.name === entry.name);
      expect(declaration, entry.name).toBeDefined();
      expect(declaration).toEqual({
        name: entry.name,
        description: entry.description,
        parameters: entry.parameters,
      });
    }
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
      handles: ['handbook'],
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

  it('returns no handles except from open_resource', async () => {
    const p = ports();
    for (const call of [
      { name: 'search_archive', args: { query: 'battery' } },
      { name: 'server_info', args: {} },
      { name: 'current_time', args: {} },
      { name: 'my_reminders', args: {} },
      { name: 'web_search', args: { query: 'lipo storage' } },
    ] as const) {
      const result = await runAssistantTool(call, p);
      expect(result.ok).toBe(true);
      expect(result.handles).toBeUndefined();
    }
  });
});

const cachePorts = (over: Record<string, unknown> = {}) => {
  const resources = () => [
    resource(),
    resource({ id: 'rules', title: 'Club rules', kind: 'website' as const }),
  ];
  return ports({
    resources,
    cacheSearch: () => [],
    cacheChunk: () => undefined,
    cacheNeighbours: () => [],
    cacheOutline: () => [],
    cacheDocument: () => undefined,
    cacheResourceDocs: () => [],
    cacheResourceChunks: () => [],
    cacheFreshness: () => [],
    enqueueRefresh: () => true,
    ...over,
  } as Partial<AssistantToolPorts>);
};

describe('cache tools (Task 16)', () => {
  it('list_sources lists enabled resources with relative updated times, at most 30 lines', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `r${String(i)}`,
      guildId: '234567890123456789',
      title: `Resource ${String(i)} with a very long title to push line counts`,
      url: `https://example.com/${String(i)}`,
      kind: 'website' as const,
      enabled: true,
      reviewedAt: '2026-09-01T00:00:00.000Z',
    }));
    const p = cachePorts({
      resources: () => many,
      cacheFreshness: () => many.map((r) => ({ resourceId: r.id, fetchedAt: NOW - 3_600_000 })),
    });
    const result = await runAssistantTool({ name: 'list_sources', args: {} }, p);
    expect(result.ok).toBe(true);
    const lines = result.text.split('\n').filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(30);
    expect(result.text).toContain('r0 · Resource 0');
    expect(result.handles).toHaveLength(lines.length);
  });

  it('list_sources honours a filter and refuses an overlong one', async () => {
    const p = cachePorts({
      cacheFreshness: () => [{ resourceId: 'handbook', fetchedAt: NOW - 60_000 }],
    });
    const filtered = await runAssistantTool(
      { name: 'list_sources', args: { filter: 'hand' } },
      p,
    );
    expect(filtered.ok).toBe(true);
    expect(filtered.text).toContain('handbook');
    expect(filtered.text).not.toContain('rules');
    await expect(
      runAssistantTool({ name: 'list_sources', args: { filter: 'x'.repeat(81) } }, p),
    ).resolves.toMatchObject({ ok: false });
  });

  it('search_sources caps hits at 6 and total text at 2000 chars', async () => {
    const hits = Array.from({ length: 10 }, (_, i) => ({
      chunkId: `c_doc_${String(i)}`,
      docId: 'd_abc',
      resourceId: 'handbook',
      headingPath: `Guide › Part ${String(i)}`,
      snippet: 'x'.repeat(400),
    }));
    const p = cachePorts({ cacheSearch: () => hits });
    const result = await runAssistantTool(
      { name: 'search_sources', args: { query: 'battery care' } },
      p,
    );
    expect(result.ok).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(2_000);
    expect(result.text.split('\n').filter(Boolean).length).toBeLessThanOrEqual(6);
    for (const line of result.text.split('\n').filter(Boolean)) {
      const snippet = line.split(': ').slice(1).join(': ');
      expect(snippet.length).toBeLessThanOrEqual(300);
    }
    expect(result.handles).toContain('c_doc_0');
    expect(result.handles).toContain('d_abc');
  });

  it('search_sources answers no hits with the ruled sentence and refuses short queries', async () => {
    const p = cachePorts({ cacheSearch: () => [] });
    const empty = await runAssistantTool(
      { name: 'search_sources', args: { query: 'battery care' } },
      p,
    );
    expect(empty.ok).toBe(true);
    expect(empty.text).toBe('No matching passages. Try different words, or list_sources.');
    await expect(
      runAssistantTool({ name: 'search_sources', args: { query: 'x' } }, p),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      runAssistantTool(
        { name: 'search_sources', args: { query: 'battery', sourceIds: Array(11).fill('handbook') } },
        p,
      ),
    ).resolves.toMatchObject({ ok: false });
  });

  it('read_chunk returns the chunk with neighbours inside 4000 chars and unknown ids stay unknown', async () => {
    const big = 'y'.repeat(5_000);
    const p = cachePorts({
      cacheChunk: () => ({
        chunkId: 'c_d_0',
        docId: 'd_abc',
        resourceId: 'handbook',
        headingPath: 'Guide › Intro',
        text: big,
      }),
      cacheNeighbours: () => [
        {
          chunkId: 'c_d_0',
          docId: 'd_abc',
          resourceId: 'handbook',
          headingPath: 'Guide › Intro',
          text: big,
        },
      ],
    });
    const result = await runAssistantTool(
      { name: 'read_chunk', args: { chunkId: 'c_d_0' } },
      p,
    );
    expect(result.ok).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(4_000);
    expect(result.text).toContain('Guide › Intro');
    expect(result.text).toContain('https://example.com/handbook');
    expect(result.handles).toContain('c_d_0');
    expect(result.handles).toContain('d_abc');
    expect(result.sources).toEqual([
      { title: 'Club handbook', url: 'https://example.com/handbook' },
    ]);
    const unknown = await runAssistantTool(
      { name: 'read_chunk', args: { chunkId: 'c_other_guild_9' } },
      cachePorts(),
    );
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toContain('unknown id');
  });

  it('outline lists headings with chunk ids inside 1500 chars', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      chunkId: `c_d_${String(i)}`,
      headingPath: `Guide › Section ${String(i)} with a long heading ${'z'.repeat(60)}`,
    }));
    const p = cachePorts({
      cacheOutline: () => rows,
      cacheDocument: () => ({ docId: 'd_abc', resourceId: 'handbook' }),
    });
    const result = await runAssistantTool({ name: 'outline', args: { docId: 'd_abc' } }, p);
    expect(result.ok).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(1_500);
    expect(result.text).toContain('c_d_0');
    expect(result.handles).toContain('c_d_0');
    const unknown = await runAssistantTool({ name: 'outline', args: { docId: 'd_nope' } }, cachePorts());
    expect(unknown.text).toContain('unknown id');
  });

  it('open_resource returns the first cached chunks inside 4000 chars', async () => {
    const p = cachePorts({
      cacheResourceDocs: () => [
        { docId: 'd_abc', resourceId: 'handbook', title: 'Club handbook', url: 'https://example.com/handbook' },
      ],
      cacheResourceChunks: () => [
        { chunkId: 'c_d_abc_0', docId: 'd_abc', resourceId: 'handbook', headingPath: 'H', text: 'w'.repeat(5_000) },
      ],
    });
    const result = await runAssistantTool(
      { name: 'open_resource', args: { resourceId: 'handbook' } },
      p,
    );
    expect(result.ok).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(4_000);
    expect(result.handles).toContain('c_d_abc_0');
    expect(result.handles).toContain('d_abc');
  });

  it('open_resource on an unfetched resource asks for a refresh and enqueues once', async () => {
    const enqueueRefresh = vi.fn(() => true);
    const p = cachePorts({ cacheResourceDocs: () => [], enqueueRefresh });
    const result = await runAssistantTool(
      { name: 'open_resource', args: { resourceId: 'handbook' } },
      p,
    );
    expect(result.ok).toBe(true);
    expect(result.text).toBe("This source hasn't been fetched yet; an update has been requested.");
    expect(enqueueRefresh).toHaveBeenCalledWith('handbook');
  });

  it('refresh_source enqueues once per 10 minutes', async () => {
    const enqueueRefresh = vi.fn(() => true);
    const p = cachePorts({ enqueueRefresh });
    const first = await runAssistantTool(
      { name: 'refresh_source', args: { resourceId: 'handbook' } },
      p,
    );
    expect(first.text).toBe('Refresh started; updated content will be available in about a minute.');
    const deduped = await runAssistantTool(
      { name: 'refresh_source', args: { resourceId: 'handbook' } },
      cachePorts({ enqueueRefresh: () => false }),
    );
    expect(deduped.text).toBe('Already refreshed in the last 10 minutes.');
    const unknown = await runAssistantTool(
      { name: 'refresh_source', args: { resourceId: 'nope' } },
      cachePorts(),
    );
    expect(unknown.text).toContain('unknown id');
  });
});
