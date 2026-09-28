import { describe, expect, it, vi } from 'vitest';
import { clipHeading, TOOL_CATALOGUE, type ClubResource, type Reminder } from '@bananasaurs/core';
import { runAssistantTool, toolDeclarations, type AssistantToolPorts } from './tools.js';
import type { assistantRepo } from '@bananasaurs/storage';

type StoredReminder = assistantRepo.StoredReminder;

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

const storedReminder = (over: Partial<StoredReminder> = {}): StoredReminder => ({
  id: 'rem_msg1_0',
  guildId: '234567890123456789',
  creatorId: MEMBER,
  destinationId: '111111111111111111',
  text: 'Bring the charger',
  dueAt: NOW + 3_600_000,
  createdAt: NOW,
  status: 'scheduled',
  dedupeKey: 'reminder:msg1:0',
  mentions: { userIds: [], roleIds: [], everyone: false, here: false },
  deliveredCount: 0,
  ...over,
});

const ports = (over: Partial<AssistantToolPorts> = {}): AssistantToolPorts => ({
  userId: MEMBER,
  now: () => NOW,
  timeZone: 'America/Vancouver',
  isOwner: false,
  skillAllowed: () => true,
  invocationKey: 'msg1',
  currentChannelId: '111111111111111111',
  resolveReminderTargets: vi.fn(async () => ({
    ok: true as const,
    targets: {
      channelId: '111111111111111111',
      channelName: 'general',
      mentions: { userIds: [], roleIds: [], everyone: false, here: false },
      memberNames: [],
      roleNames: [],
    },
  })),
  reminderStore: {
    insert: () => 'created' as const,
    get: () => undefined,
    update: () => 'not-found' as const,
    cancel: () => false,
    listForCreator: () => [],
    listAll: () => [],
  },
  proposeDraft: () => 'created' as const,
  recordSkillActivity: vi.fn(),
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
      'set_reminder',
      'edit_reminder',
      'cancel_reminder',
      'propose_memory',
      'propose_decision',
      'list_sources',
      'search_sources',
      'read_chunk',
      'outline',
      'refresh_source',
    ]);
    expect(names(ports({ webSearch: undefined }))).not.toContain('web_search');
  });

  it('hides acting tools when their skill is not allowed', () => {
    const p = ports({ skillAllowed: (skill) => skill !== 'reminders' });
    const names = toolDeclarations(p).map((tool) => tool.name);
    expect(names).not.toContain('set_reminder');
    expect(names).not.toContain('edit_reminder');
    expect(names).not.toContain('cancel_reminder');
    expect(names).not.toContain('my_reminders');
    expect(names).toContain('propose_memory');
    const q = ports({ skillAllowed: () => false });
    const hidden = toolDeclarations(q).map((tool) => tool.name);
    expect(hidden).not.toContain('propose_memory');
    expect(hidden).not.toContain('propose_decision');
    expect(hidden).toContain('search_archive');
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

  it('opens only an enabled resource from the cache, redacted like other evidence', async () => {
    const p = ports({
      cacheResourceDocs: () => [
        {
          docId: 'd_handbook',
          resourceId: 'handbook',
          title: 'Club handbook',
          url: 'https://example.com/handbook',
        },
      ],
      cacheResourceChunks: () => [
        {
          chunkId: 'c_d_handbook_0',
          docId: 'd_handbook',
          resourceId: 'handbook',
          headingPath: 'Guide',
          text: 'Meetings are Mondays. Contact lead@example.com.',
        },
      ],
    });
    const opened = await runAssistantTool(
      { name: 'open_resource', args: { resourceId: 'handbook' } },
      p,
    );
    expect(opened).toMatchObject({
      ok: true,
      sources: [{ title: 'Club handbook', url: 'https://example.com/handbook' }],
    });
    expect(opened.handles).toContain('c_d_handbook_0');
    expect(opened.handles).toContain('d_handbook');
    expect(opened.text).toContain('Meetings are Mondays.');
    expect(opened.text).not.toContain('lead@example.com');
    await expect(
      runAssistantTool({ name: 'open_resource', args: { resourceId: 'off' } }, p),
    ).resolves.toMatchObject({ ok: false, text: 'unknown id' });
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

  it("lists only the asking member's own unfinished reminders", async () => {
    const mine = storedReminder({ id: 'r1', text: 'Bring the charger' });
    const theirs = storedReminder({
      id: 'r2',
      creatorId: '999999999999999999',
      text: 'Someone else',
    });
    const finished = storedReminder({ id: 'r3', status: 'delivered', text: 'Done already' });
    const p = ports({
      reminderStore: {
        insert: () => 'created' as const,
        get: () => undefined,
        update: () => 'not-found' as const,
        cancel: () => false,
        listForCreator: () => [mine, finished],
        listAll: () => [mine, theirs, finished],
      },
    });
    const result = await runAssistantTool({ name: 'my_reminders', args: {} }, p);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('Bring the charger');
    expect(result.text).not.toContain('Someone else');
    expect(result.text).not.toContain('Done already');
    expect(result.text).toContain('r1 ·');
  });

  it('lets the owner list everyone with all=true, members see only their own', async () => {
    const mine = storedReminder({ id: 'r1', text: 'Bring the charger' });
    const theirs = storedReminder({
      id: 'r2',
      creatorId: '999999999999999999',
      text: 'Someone else',
    });
    const store = {
      insert: () => 'created' as const,
      get: () => undefined,
      update: () => 'not-found' as const,
      cancel: () => false,
      listForCreator: () => [mine],
      listAll: () => [mine, theirs],
    };
    const owner = ports({ isOwner: true, reminderStore: store });
    const all = await runAssistantTool({ name: 'my_reminders', args: { all: true } }, owner);
    expect(all.text).toContain('Bring the charger');
    expect(all.text).toContain('Someone else');
    const member = ports({ isOwner: false, reminderStore: store });
    const own = await runAssistantTool({ name: 'my_reminders', args: { all: true } }, member);
    expect(own.text).toContain('Bring the charger');
    expect(own.text).not.toContain('Someone else');
  });

  it('records a my_reminders throw as failed', async () => {
    const p = ports({
      reminderStore: {
        insert: () => 'created' as const,
        get: () => undefined,
        update: () => 'not-found' as const,
        cancel: () => false,
        listForCreator: () => {
          throw new Error('db down');
        },
        listAll: () => [],
      },
    });
    const result = await runAssistantTool({ name: 'my_reminders', args: {} }, p);
    expect(result).toMatchObject({
      ok: false,
      text: 'Something went wrong saving that. Nothing was changed.',
    });
    expect(p.recordSkillActivity).toHaveBeenCalledWith(
      'reminders',
      'failed',
      'Something went wrong saving that. Nothing was changed.',
    );
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

describe('acting tools (B2a)', () => {
  const reminderPorts = (over: Partial<AssistantToolPorts> = {}) => {
    const rows = new Map<string, StoredReminder>();
    return {
      p: ports({
        reminderStore: {
          insert: (reminder: Omit<Reminder, 'guildId'>) => {
            if ([...rows.values()].some((r) => r.dedupeKey === reminder.dedupeKey))
              return 'duplicate';
            rows.set(reminder.id, storedReminder({ ...reminder }));
            return 'created';
          },
          get: (id: string) => rows.get(id),
          update: (id: string, patch: Record<string, unknown>) => {
            const row = rows.get(id);
            if (row === undefined) return 'not-found' as const;
            if (row.status !== 'scheduled') return 'not-editable' as const;
            const next = storedReminder({ ...row, ...(patch as object), updatedAt: NOW });
            if ((patch as { recurrence?: unknown }).recurrence === null) {
              const rest = { ...next };
              delete rest.recurrence;
              rows.set(id, storedReminder(rest));
            } else rows.set(id, next);
            return 'updated' as const;
          },
          cancel: (id: string) => {
            const row = rows.get(id);
            if (row === undefined || row.status !== 'scheduled') return false;
            rows.set(id, storedReminder({ ...row, status: 'cancelled' }));
            return true;
          },
          listForCreator: (creatorId: string) =>
            [...rows.values()].filter((r) => r.creatorId === creatorId),
          listAll: () => [...rows.values()],
        },
        ...over,
      }),
      rows,
    };
  };

  it('refuses a gated call and records it as denied', async () => {
    const p = ports({ skillAllowed: () => false });
    const result = await runAssistantTool(
      { name: 'set_reminder', args: { text: 'hi', when: '2026-09-24T12:30:00-07:00' } },
      p,
    );
    expect(result).toMatchObject({ ok: false, text: "You're not allowed to use that here." });
    expect(p.recordSkillActivity).toHaveBeenCalledWith('reminders', 'denied');
  });

  it('sets a reminder with a code-written summary', async () => {
    const { p } = reminderPorts();
    const result = await runAssistantTool(
      {
        name: 'set_reminder',
        args: { text: 'Bring the charger', when: '2026-09-24T12:30:00-07:00' },
      },
      p,
    );
    expect(result.ok).toBe(true);
    expect(result.text).toContain('✅ Reminder set: **Bring the charger**');
    expect(result.actionSummary).toBe(result.text);
    expect(result.actionSummary).toContain('#general');
    expect(p.recordSkillActivity).toHaveBeenCalledWith('reminders', 'completed');
  });

  it('refuses a when without an offset, a past time and an overlong context', async () => {
    const { p } = reminderPorts();
    await expect(
      runAssistantTool(
        { name: 'set_reminder', args: { text: 'hi', when: '2026-09-24 12:30:00' } },
        p,
      ),
    ).resolves.toMatchObject({ ok: false, text: 'Give the time as ISO 8601 with its UTC offset.' });
    await expect(
      runAssistantTool(
        { name: 'set_reminder', args: { text: 'hi', when: '2026-09-20T12:30:00-07:00' } },
        p,
      ),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      runAssistantTool(
        {
          name: 'set_reminder',
          args: { text: 'hi', when: '2026-09-24T12:30:00-07:00', context: 'x'.repeat(301) },
        },
        p,
      ),
    ).resolves.toMatchObject({ ok: false });
  });

  it('refuses an invalid repeat without storing anything', async () => {
    const insert = vi.fn(() => 'created' as const);
    const p = ports({
      reminderStore: {
        insert,
        get: () => undefined,
        update: () => 'not-found' as const,
        cancel: () => false,
        listForCreator: () => [],
        listAll: () => [],
      },
    });
    await expect(
      runAssistantTool(
        {
          name: 'set_reminder',
          args: { text: 'hi', when: '2026-09-24T12:30:00-07:00', repeat: { kind: 'weekly' } },
        },
        p,
      ),
    ).resolves.toMatchObject({ ok: false, text: 'The repeat pattern was not valid.' });
    expect(insert).not.toHaveBeenCalled();
  });

  it('refuses overlong text, members, roles and empty text without storing anything', async () => {
    const insert = vi.fn(() => 'created' as const);
    const p = ports({
      reminderStore: {
        insert,
        get: () => undefined,
        update: () => 'not-found' as const,
        cancel: () => false,
        listForCreator: () => [],
        listAll: () => [],
      },
    });
    const when = '2026-09-24T12:30:00-07:00';
    const cases = [
      { text: 'x'.repeat(1501), when },
      { text: '', when },
      { text: 'hi', when, members: Array(26).fill('user') },
      { text: 'hi', when, roles: Array(11).fill('role') },
    ];
    for (const args of cases) {
      await expect(runAssistantTool({ name: 'set_reminder', args }, p)).resolves.toMatchObject({
        ok: false,
        text: 'The tool arguments were not valid.',
      });
    }
    expect(insert).not.toHaveBeenCalled();
  });

  it('passes a target problem through without inserting', async () => {
    const insert = vi.fn(() => 'created' as const);
    const p = ports({
      reminderStore: {
        insert,
        get: () => undefined,
        update: () => 'not-found' as const,
        cancel: () => false,
        listForCreator: () => [],
        listAll: () => [],
      },
      resolveReminderTargets: vi.fn(async () => ({
        ok: false as const,
        problem: 'I can\'t find a channel called "nope".',
      })),
    });
    const result = await runAssistantTool(
      {
        name: 'set_reminder',
        args: { text: 'hi', when: '2026-09-24T12:30:00-07:00', channel: 'nope' },
      },
      p,
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain("can't find a channel");
    expect(insert).not.toHaveBeenCalled();
  });

  it('is idempotent on identical content and unique across different calls', async () => {
    const inserted: Omit<Reminder, 'guildId'>[] = [];
    const storeFor = () => ({
      insert: (reminder: Omit<Reminder, 'guildId'>) => {
        if (inserted.some((r) => r.dedupeKey === reminder.dedupeKey)) return 'duplicate' as const;
        inserted.push(reminder);
        return 'created' as const;
      },
      get: (id: string) => inserted.find((r) => r.id === id) as StoredReminder | undefined,
      update: () => 'not-found' as const,
      cancel: () => false,
      listForCreator: () => [],
      listAll: () => [],
    });
    const p = ports({ reminderStore: storeFor() });
    const args = { text: 'hi', when: '2026-09-24T12:30:00-07:00' };
    const first = await runAssistantTool({ name: 'set_reminder', args }, p);
    expect(first.ok).toBe(true);
    expect(inserted).toHaveLength(1);
    // A replay with a fresh ports object but the same key hits the dedupe key
    // and returns the same success summary built from the stored row.
    const replay = ports({ invocationKey: 'msg1', reminderStore: storeFor() });
    const second = await runAssistantTool({ name: 'set_reminder', args }, replay);
    expect(second.ok).toBe(true);
    expect(second.actionSummary).toBe(first.actionSummary);
    expect(second.text).toBe(first.text);
    expect(inserted).toHaveLength(1);
    // Two identical calls on the same ports object also dedupe to one row.
    const samePorts = await runAssistantTool({ name: 'set_reminder', args }, p);
    expect(samePorts.actionSummary).toBe(first.actionSummary);
    expect(inserted).toHaveLength(1);
    // Different content gets a different key and a second row.
    const third = await runAssistantTool(
      { name: 'set_reminder', args: { text: 'bye', when: '2026-09-24T12:30:00-07:00' } },
      p,
    );
    expect(third.ok).toBe(true);
    expect(inserted).toHaveLength(2);
    expect(inserted[0]?.id).not.toBe(inserted[1]?.id);
    expect(inserted[0]?.dedupeKey).not.toBe(inserted[1]?.dedupeKey);
  });

  it('builds a weekly recurrence from days', async () => {
    const inserted: Omit<Reminder, 'guildId'>[] = [];
    const p = ports({
      reminderStore: {
        insert: (reminder: Omit<Reminder, 'guildId'>) => {
          inserted.push(reminder);
          return 'created';
        },
        get: () => undefined,
        update: () => 'not-found' as const,
        cancel: () => false,
        listForCreator: () => [],
        listAll: () => [],
      },
    });
    const result = await runAssistantTool(
      {
        name: 'set_reminder',
        args: {
          text: 'Standup',
          when: '2026-09-24T12:30:00-07:00',
          repeat: { kind: 'weekly', days: [2, 4] },
        },
      },
      p,
    );
    expect(result.ok).toBe(true);
    expect(inserted[0]?.recurrence?.pattern).toMatchObject({ kind: 'weekly', days: [2, 4] });
    expect(result.actionSummary).toContain('every Tuesday and Thursday');
  });

  it('treats a midnight until as the end of that day', async () => {
    const inserted: Omit<Reminder, 'guildId'>[] = [];
    const p = ports({
      reminderStore: {
        insert: (reminder: Omit<Reminder, 'guildId'>) => {
          inserted.push(reminder);
          return 'created';
        },
        get: () => undefined,
        update: () => 'not-found' as const,
        cancel: () => false,
        listForCreator: () => [],
        listAll: () => [],
      },
    });
    const result = await runAssistantTool(
      {
        name: 'set_reminder',
        args: {
          text: 'Standup',
          when: '2026-09-24T12:30:00-07:00',
          repeat: { kind: 'daily', until: '2026-12-31T00:00:00-07:00' },
        },
      },
      p,
    );
    expect(result.ok).toBe(true);
    // Dec 31 itself is included: the end is 23:59:59.999 local, past its noon.
    expect(inserted[0]?.recurrence?.endAt).toBe(Date.parse('2026-12-31T23:59:59.999-07:00'));
  });

  it('trims and collapses the stored context, omitting it when empty', async () => {
    const inserted: Omit<Reminder, 'guildId'>[] = [];
    const store = {
      insert: (reminder: Omit<Reminder, 'guildId'>) => {
        inserted.push(reminder);
        return 'created' as const;
      },
      get: () => undefined,
      update: () => 'not-found' as const,
      cancel: () => false,
      listForCreator: () => [],
      listAll: () => [],
    };
    const messy = await runAssistantTool(
      {
        name: 'set_reminder',
        args: { text: 'hi', when: '2026-09-24T12:30:00-07:00', context: '  why\n\n it\tmatters  ' },
      },
      ports({ reminderStore: store }),
    );
    expect(messy.ok).toBe(true);
    expect(inserted[0]?.context).toBe('why it matters');
    const blank = await runAssistantTool(
      {
        name: 'set_reminder',
        args: { text: 'hi', when: '2026-09-25T12:30:00-07:00', context: '   ' },
      },
      ports({ reminderStore: store }),
    );
    expect(blank.ok).toBe(true);
    expect(inserted[1]?.context).toBeUndefined();
  });

  it('refuses an edit by a non-creator and allows the owner', async () => {
    const { p, rows } = reminderPorts();
    rows.set('rem1', storedReminder({ id: 'rem1', creatorId: MEMBER, text: 'old' }));
    const stranger = ports({
      userId: '999999999999999999',
      reminderStore: p.reminderStore,
    });
    await expect(
      runAssistantTool(
        { name: 'edit_reminder', args: { reminderId: 'rem1', text: 'new' } },
        stranger,
      ),
    ).resolves.toMatchObject({ ok: false, text: 'You can only change reminders you set.' });
    const owner = ports({
      userId: '999999999999999999',
      isOwner: true,
      reminderStore: p.reminderStore,
    });
    const result = await runAssistantTool(
      { name: 'edit_reminder', args: { reminderId: 'rem1', text: 'new' } },
      owner,
    );
    expect(result.ok).toBe(true);
    expect(result.actionSummary).toContain('✏️ Reminder updated: **new**');
    await expect(
      runAssistantTool({ name: 'edit_reminder', args: { reminderId: 'missing', text: 'x' } }, p),
    ).resolves.toMatchObject({ ok: false, text: "I couldn't find that reminder." });
  });

  it('omits Where and Pings from an edit summary when the targets did not change', async () => {
    const { p, rows } = reminderPorts();
    rows.set('rem1', storedReminder({ id: 'rem1', creatorId: MEMBER, text: 'old' }));
    const result = await runAssistantTool(
      { name: 'edit_reminder', args: { reminderId: 'rem1', text: 'new' } },
      p,
    );
    expect(result.ok).toBe(true);
    expect(result.actionSummary).toContain('✏️ Reminder updated: **new**');
    expect(result.actionSummary).not.toContain('• Where:');
    expect(result.actionSummary).not.toContain('• Pings:');
    expect(result.actionSummary).not.toContain('111111111111111111');
  });

  it('stops repeating and maps not-editable', async () => {
    const { p, rows } = reminderPorts();
    rows.set(
      'repeating',
      storedReminder({
        id: 'repeating',
        recurrence: {
          pattern: { kind: 'daily' },
          timeZone: 'America/Vancouver',
        },
      }),
    );
    const stopped = await runAssistantTool(
      { name: 'edit_reminder', args: { reminderId: 'repeating', stopRepeating: true } },
      p,
    );
    expect(stopped.ok).toBe(true);
    expect(rows.get('repeating')?.recurrence).toBeUndefined();
    rows.set('gone', storedReminder({ id: 'gone', status: 'delivered' }));
    await expect(
      runAssistantTool({ name: 'edit_reminder', args: { reminderId: 'gone', text: 'x' } }, p),
    ).resolves.toMatchObject({
      ok: false,
      text: 'That reminder is already being sent or has finished.',
    });
  });

  it('cancels an owned reminder and refuses a finished one', async () => {
    const { p, rows } = reminderPorts();
    rows.set('rem1', storedReminder({ id: 'rem1', text: 'Bring the charger' }));
    const result = await runAssistantTool(
      { name: 'cancel_reminder', args: { reminderId: 'rem1' } },
      p,
    );
    expect(result.ok).toBe(true);
    expect(result.actionSummary).toContain('🗑️ Reminder cancelled: **Bring the charger**');
    const again = await runAssistantTool(
      { name: 'cancel_reminder', args: { reminderId: 'rem1' } },
      p,
    );
    expect(again).toMatchObject({ ok: false, text: "That reminder can't be cancelled now." });
  });

  it('refuses a cancel by another member and keeps the reminder scheduled', async () => {
    const { p, rows } = reminderPorts();
    rows.set('rem1', storedReminder({ id: 'rem1', text: 'Bring the charger' }));
    const stranger = ports({
      userId: '999999999999999999',
      reminderStore: p.reminderStore,
    });
    await expect(
      runAssistantTool({ name: 'cancel_reminder', args: { reminderId: 'rem1' } }, stranger),
    ).resolves.toMatchObject({ ok: false, text: 'You can only change reminders you set.' });
    expect(rows.get('rem1')?.status).toBe('scheduled');
  });

  it('refuses a cancel for a missing id', async () => {
    const { p } = reminderPorts();
    await expect(
      runAssistantTool({ name: 'cancel_reminder', args: { reminderId: 'missing' } }, p),
    ).resolves.toMatchObject({ ok: false, text: "I couldn't find that reminder." });
  });

  it('files memory and decision proposals with review wording', async () => {
    const proposed: { id: string; kind: string; summary: string }[] = [];
    const p = ports({
      proposeDraft: (input: {
        id: string;
        kind: 'memory' | 'decision' | 'review-plan';
        summary: string;
      }) => {
        if (proposed.some((d) => d.id === input.id)) return 'duplicate';
        proposed.push({ ...input });
        return 'created';
      },
    });
    const memory = await runAssistantTool(
      { name: 'propose_memory', args: { content: 'Ava leads the pit crew', section: 'team' } },
      p,
    );
    expect(memory.actionSummary).toBe(
      '📝 Memory proposal filed for owner review. Nothing is remembered until it is approved.',
    );
    expect(proposed[0]?.summary).toBe('team: Ava leads the pit crew');
    const decision = await runAssistantTool(
      { name: 'propose_decision', args: { summary: 'Race on Sunday', kind: 'decision' } },
      p,
    );
    expect(decision.actionSummary).toBe(
      '📝 Draft filed for owner review. It is not club policy until an owner saves it.',
    );
    expect(proposed[1]?.id).toContain('decision:msg1:');
    const replay = await runAssistantTool(
      { name: 'propose_memory', args: { content: 'Ava leads the pit crew', section: 'team' } },
      ports({
        invocationKey: 'msg1',
        proposeDraft: (input: {
          id: string;
          kind: 'memory' | 'decision' | 'review-plan';
          summary: string;
        }) => {
          if (proposed.some((d) => d.id === input.id)) return 'duplicate';
          proposed.push({ ...input });
          return 'created';
        },
      }),
    );
    expect(replay.actionSummary).toBe(memory.actionSummary);
  });

  it('records a throw as failed', async () => {
    const p = ports({
      resolveReminderTargets: vi.fn(async () => {
        throw new Error('discord down');
      }),
    });
    const result = await runAssistantTool(
      { name: 'set_reminder', args: { text: 'hi', when: '2026-09-24T12:30:00-07:00' } },
      p,
    );
    expect(result.ok).toBe(false);
    expect(result.text).toBe('Something went wrong saving that. Nothing was changed.');
    expect(p.recordSkillActivity).toHaveBeenCalledWith(
      'reminders',
      'failed',
      'Something went wrong saving that. Nothing was changed.',
    );
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
  });
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
    const filtered = await runAssistantTool({ name: 'list_sources', args: { filter: 'hand' } }, p);
    expect(filtered.ok).toBe(true);
    expect(filtered.text).toContain('handbook');
    expect(filtered.text).not.toContain('rules');
    await expect(
      runAssistantTool({ name: 'list_sources', args: { filter: 'x'.repeat(81) } }, p),
    ).resolves.toMatchObject({ ok: false });
  });

  it('search_sources refuses an unknown or disabled sourceId with unknown id', async () => {
    const cacheSearch = vi.fn(() => []);
    const unknown = await runAssistantTool(
      { name: 'search_sources', args: { query: 'battery care', sourceIds: ['nope'] } },
      cachePorts({ cacheSearch }),
    );
    expect(unknown).toMatchObject({ ok: false, text: 'unknown id' });
    expect(cacheSearch).not.toHaveBeenCalled();
    const disabled = await runAssistantTool(
      { name: 'search_sources', args: { query: 'battery care', sourceIds: ['off'] } },
      cachePorts({ cacheSearch }),
    );
    expect(disabled).toMatchObject({ ok: false, text: 'unknown id' });
    expect(cacheSearch).not.toHaveBeenCalled();
  });

  it('search_sources without sourceIds searches only enabled resources and hides disabled hits', async () => {
    const cacheSearch = vi.fn(() => [
      {
        chunkId: 'c_on',
        docId: 'd_on',
        resourceId: 'handbook',
        headingPath: 'Guide',
        snippet: 'meetings are Mondays',
      },
      {
        chunkId: 'c_off',
        docId: 'd_off',
        resourceId: 'off',
        headingPath: 'Old',
        snippet: 'archived minutes',
      },
    ]);
    // ports() lists the disabled 'off' resource alongside 'handbook'.
    const result = await runAssistantTool(
      { name: 'search_sources', args: { query: 'battery care' } },
      ports({ cacheSearch }),
    );
    expect(cacheSearch).toHaveBeenCalledWith({
      query: 'battery care',
      resourceIds: ['handbook'],
      limit: 6,
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('c_on');
    expect(result.text).not.toContain('c_off');
    expect(result.text).not.toContain('archived minutes');
    expect(result.handles).not.toContain('c_off');
    expect(result.handles).not.toContain('d_off');
  });

  it('read_chunk on a disabled resource answers unknown id', async () => {
    const p = ports({
      cacheChunk: () => ({
        chunkId: 'c_off_0',
        docId: 'd_off',
        resourceId: 'off',
        headingPath: 'Old',
        text: 'archived minutes',
      }),
      cacheNeighbours: () => [],
    });
    await expect(
      runAssistantTool({ name: 'read_chunk', args: { chunkId: 'c_off_0' } }, p),
    ).resolves.toMatchObject({ ok: false, text: 'unknown id' });
  });

  it('outline on a disabled resource answers unknown id', async () => {
    const p = ports({
      cacheOutline: () => [{ chunkId: 'c_off_0', headingPath: 'Old › Notes' }],
      cacheDocument: () => ({
        docId: 'd_off',
        resourceId: 'off',
        title: 'Old',
        url: 'https://example.com/old',
      }),
    });
    await expect(
      runAssistantTool({ name: 'outline', args: { docId: 'd_off' } }, p),
    ).resolves.toMatchObject({ ok: false, text: 'unknown id' });
  });

  it('list_sources answers no match with the ruled sentence', async () => {
    const p = cachePorts({
      cacheFreshness: () => [{ resourceId: 'handbook', fetchedAt: NOW - 60_000 }],
    });
    const result = await runAssistantTool(
      { name: 'list_sources', args: { filter: 'zzz-no-such-source' } },
      p,
    );
    expect(result.ok).toBe(true);
    expect(result.text).toBe('No sources match that filter.');
    expect(result.handles).toBeUndefined();
  });

  it('list_sources shows never-fetched sources as not fetched yet', async () => {
    const p = cachePorts({ cacheFreshness: () => [] });
    const result = await runAssistantTool({ name: 'list_sources', args: {} }, p);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('not fetched yet');
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
        {
          name: 'search_sources',
          args: { query: 'battery', sourceIds: Array(11).fill('handbook') },
        },
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
    const result = await runAssistantTool({ name: 'read_chunk', args: { chunkId: 'c_d_0' } }, p);
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
    const unknown = await runAssistantTool(
      { name: 'outline', args: { docId: 'd_nope' } },
      cachePorts(),
    );
    expect(unknown.text).toContain('unknown id');
  });

  it('outline on a known doc with no chunks answers No headings cached.', async () => {
    const p = cachePorts({
      cacheOutline: () => [],
      cacheDocument: () => ({
        docId: 'd_abc',
        resourceId: 'handbook',
        title: 'Club handbook',
        url: 'https://example.com/handbook',
      }),
    });
    const result = await runAssistantTool({ name: 'outline', args: { docId: 'd_abc' } }, p);
    expect(result.ok).toBe(true);
    expect(result.text).toBe('No headings cached.');
  });

  it('open_resource returns the first cached chunks inside 4000 chars', async () => {
    const p = cachePorts({
      cacheResourceDocs: () => [
        {
          docId: 'd_abc',
          resourceId: 'handbook',
          title: 'Club handbook',
          url: 'https://example.com/handbook',
        },
      ],
      cacheResourceChunks: () => [
        {
          chunkId: 'c_d_abc_0',
          docId: 'd_abc',
          resourceId: 'handbook',
          headingPath: 'H',
          text: 'w'.repeat(5_000),
        },
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
    expect(first.text).toBe(
      'Refresh started; updated content will be available in about a minute.',
    );
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

  it('search_sources clips a 9000-char heading path so both hits still appear', async () => {
    const longPath = 'H'.repeat(9_000);
    const cacheSearch = vi.fn(() => [
      {
        chunkId: 'c_long',
        docId: 'd_long',
        resourceId: 'handbook',
        headingPath: longPath,
        snippet: 'first snippet here',
      },
      {
        chunkId: 'c_short',
        docId: 'd_short',
        resourceId: 'handbook',
        headingPath: 'Guide › Intro',
        snippet: 'second snippet here',
      },
    ]);
    const result = await runAssistantTool(
      { name: 'search_sources', args: { query: 'battery care' } },
      cachePorts({ cacheSearch }),
    );
    expect(result.ok).toBe(true);
    expect(result.text).toContain('second snippet here');
    expect(result.text).toContain('c_long');
    expect(result.text).toContain('c_short');
    const expected = clipHeading(longPath, 200);
    expect(expected.endsWith('…')).toBe(true);
    expect(expected.length).toBeLessThanOrEqual(200);
    expect(result.text).toContain(expected);
    expect(result.text).not.toContain(longPath);
  });

  it('search_sources skips an over-budget line instead of stopping', async () => {
    const bigTitle = 'B'.repeat(2_100);
    const big = resource({ id: 'big', title: bigTitle });
    const cacheSearch = vi.fn(() => [
      {
        chunkId: 'c_big',
        docId: 'd_big',
        resourceId: 'big',
        headingPath: 'Guide',
        snippet: 'first snippet',
      },
      {
        chunkId: 'c_small',
        docId: 'd_small',
        resourceId: 'handbook',
        headingPath: 'Guide › Intro',
        snippet: 'second snippet here',
      },
    ]);
    const result = await runAssistantTool(
      { name: 'search_sources', args: { query: 'battery care' } },
      cachePorts({ resources: () => [big, resource()], cacheSearch }),
    );
    expect(result.ok).toBe(true);
    expect(result.text).not.toBe('No matching passages. Try different words, or list_sources.');
    expect(result.text).toContain('second snippet here');
    expect(result.text).toContain('c_small');
    expect(result.text).not.toContain('c_big');
    expect(result.handles).toContain('c_small');
    expect(result.handles).not.toContain('c_big');
  });

  it('outline and read_chunk clip a long heading path with an ellipsis', async () => {
    const longPath = 'H'.repeat(9_000);
    const outlineResult = await runAssistantTool(
      { name: 'outline', args: { docId: 'd_abc' } },
      cachePorts({
        cacheOutline: () => [{ chunkId: 'c_long_0', headingPath: longPath }],
        cacheDocument: () => ({ docId: 'd_abc', resourceId: 'handbook' }),
      }),
    );
    expect(outlineResult.ok).toBe(true);
    const expected = clipHeading(longPath, 200);
    expect(expected.endsWith('…')).toBe(true);
    expect(outlineResult.text).toContain(expected);
    expect(outlineResult.text).not.toContain(longPath);

    const readResult = await runAssistantTool(
      { name: 'read_chunk', args: { chunkId: 'c_long_0' } },
      cachePorts({
        cacheChunk: () => ({
          chunkId: 'c_long_0',
          docId: 'd_abc',
          resourceId: 'handbook',
          headingPath: longPath,
          text: 'some text',
        }),
        cacheNeighbours: () => [],
      }),
    );
    expect(readResult.ok).toBe(true);
    expect(readResult.text).toContain(expected);
    expect(readResult.text).not.toContain(longPath);
  });

  it('open_resource clips a long heading path with an ellipsis', async () => {
    const longPath = 'H'.repeat(9_000);
    const result = await runAssistantTool(
      { name: 'open_resource', args: { resourceId: 'handbook' } },
      cachePorts({
        cacheResourceDocs: () => [
          {
            docId: 'd_abc',
            resourceId: 'handbook',
            title: 'Club handbook',
            url: 'https://example.com/handbook',
          },
        ],
        cacheResourceChunks: () => [
          {
            chunkId: 'c_long_0',
            docId: 'd_abc',
            resourceId: 'handbook',
            headingPath: longPath,
            text: 'some text',
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    const expected = clipHeading(longPath, 200);
    expect(expected.endsWith('…')).toBe(true);
    expect(result.text).toContain(expected);
    expect(result.text).not.toContain(longPath);
  });
});
