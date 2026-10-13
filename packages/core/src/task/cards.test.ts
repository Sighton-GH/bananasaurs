import { describe, expect, it } from 'vitest';
import {
  buildUpdateModal,
  renderCheckinCard,
  renderClarifyCard,
  renderCompletePickerCard,
  renderDigestCard,
  renderPickCard,
  renderReminderCard,
  renderReviewDecisionCard,
  renderReviewRequestCard,
  renderTaskCard,
  renderTaskListCard,
  renderUpdateCard,
  type TaskCardView,
} from './cards.js';
import { countComponents, countText } from '../ui/discord/budget.js';

const TASK = '00000000-0000-4000-8000-000000000001';
const NOW = Date.UTC(2026, 9, 10, 16, 0);
const DAY = 86_400_000;
const MAYA = '111111111111111111';
const LEO = '222222222222222222';
const ROLE = '333333333333333333';
const sec = (ms: number) => Math.floor(ms / 1000);

const view = (over: Partial<TaskCardView> = {}): TaskCardView => ({
  taskId: TASK,
  version: 1,
  title: 'Wire the brake light harness',
  description: 'Run the harness from the rear bulkhead to both tail lights.',
  teamName: 'Car Team A',
  status: 'not_started',
  priority: 'normal',
  dueAt: NOW + 7 * DAY,
  now: NOW,
  audience: { kind: 'users', userIds: [MAYA, LEO] },
  links: [
    { label: 'Wiring diagram', url: 'https://drive.example/a.pdf' },
    { label: 'BOM sheet', url: 'https://docs.example/bom' },
  ],
  updatedAt: NOW,
  variant: 'announce',
  ...over,
});

const allText = (c: { components: readonly unknown[] }): string => {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v !== 'object' || v === null) return;
    const o = v as Record<string, unknown>;
    if (o['type'] === 10 && typeof o['content'] === 'string') out.push(o['content']);
    walk(o['components']);
    walk(o['accessory']);
  };
  walk(c.components);
  return out.join('\n');
};
const buttons = (c: { components: readonly unknown[] }): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v !== 'object' || v === null) return;
    const o = v as Record<string, unknown>;
    if (o['type'] === 2) out.push(o);
    walk(o['components']);
    walk(o['accessory']);
  };
  walk(c.components);
  return out;
};
const accent = (c: { components: readonly unknown[] }) =>
  (c.components[0] as { accent_color: number }).accent_color;

describe('renderTaskCard', () => {
  it('announces a new task with description, due, assignees, links, two buttons, art and pings', () => {
    const c = renderTaskCard(view());
    const t = allText(c);
    expect(t).toContain('-# 📋 NEW TASK · Car Team A');
    expect(t).toContain('**Wire the brake light harness**');
    expect(t).toContain('Run the harness from the rear bulkhead');
    expect(t).toContain(`Due <t:${sec(NOW + 7 * DAY)}:f> (<t:${sec(NOW + 7 * DAY)}:R>)`);
    expect(t).toContain(`For <@${MAYA}> <@${LEO}>`);
    expect(t).toContain('-# Reply to this card or use Post update to share progress.');
    const b = buttons(c);
    expect(b.filter((x) => x['style'] === 5).map((x) => x['label'])).toEqual([
      'Wiring diagram',
      'BOM sheet',
    ]);
    expect(b.find((x) => x['custom_id'] === `bs.task:start:${TASK}:1`)?.['style']).toBe(1);
    expect(b.find((x) => x['custom_id'] === `bs.task:update:${TASK}`)?.['style']).toBe(2);
    expect(b.filter((x) => x['style'] === 1)).toHaveLength(1);
    expect(c.art).toEqual(['saurThumb']);
    expect(c.allowedMentions).toEqual({ parse: [], users: [MAYA, LEO] });
    expect(accent(c)).toBe(0x2f5bd3);
  });

  it('pings the member role for a team task, and nobody when the team has no role', () => {
    expect(
      renderTaskCard(view({ audience: { kind: 'role', roleId: ROLE } })).allowedMentions,
    ).toEqual({ parse: [], roles: [ROLE] });
    const none = renderTaskCard(view({ audience: { kind: 'team' } }));
    expect(none.allowedMentions).toEqual({ parse: [] });
    expect(allText(none)).toContain('For the whole team');
  });

  it('a refresh never pings and shows freshness instead of the hint', () => {
    const c = renderTaskCard(view({ variant: 'refresh' }));
    expect(c.allowedMentions).toEqual({ parse: [] });
    expect(allText(c)).toContain(`-# Updated <t:${sec(NOW)}:R>`);
  });

  it('in progress: blue, picked-up and last-update lines, only Post update (primary)', () => {
    const c = renderTaskCard(
      view({
        status: 'in_progress',
        variant: 'refresh',
        pickedUp: { userId: MAYA, at: NOW - 3_600_000 },
        lastUpdate: { authorId: MAYA, at: NOW - 60_000, body: 'Left side done' },
      }),
    );
    const t = allText(c);
    expect(t).toContain('-# 🔧 IN PROGRESS · Car Team A');
    expect(t).toContain(`🔧 Picked up by <@${MAYA}> <t:${sec(NOW - 3_600_000)}:R>`);
    expect(t).toContain(
      `📝 Last update <t:${sec(NOW - 60_000)}:R> from <@${MAYA}>: “Left side done”`,
    );
    const actions = buttons(c).filter((x) => x['style'] !== 5);
    expect(actions.map((x) => x['custom_id'])).toEqual([`bs.task:update:${TASK}`]);
    expect(actions[0]?.['style']).toBe(1);
    expect(accent(c)).toBe(0x3b82f6);
  });

  it('overdue: red, "Was due", eyebrow says OVERDUE', () => {
    const c = renderTaskCard(view({ status: 'in_progress', dueAt: NOW - 3 * DAY }));
    expect(allText(c)).toContain('-# ⚠️ OVERDUE · Car Team A');
    expect(allText(c)).toContain('Was due');
    expect(accent(c)).toBe(0xd64545);
  });

  it('waiting for review and done have no action buttons; links stay', () => {
    for (const [status, colour, eyebrow] of [
      ['awaiting_approval', 0xe0a526, '👀 WAITING FOR REVIEW'],
      ['done', 0x2e9a62, '✅ DONE'],
    ] as const) {
      const c = renderTaskCard(view({ status, variant: 'refresh' }));
      expect(accent(c)).toBe(colour);
      expect(allText(c)).toContain(eyebrow);
      expect(buttons(c).every((x) => x['style'] === 5)).toBe(true);
    }
  });

  it('marks urgent tasks in the eyebrow', () => {
    expect(allText(renderTaskCard(view({ priority: 'urgent' })))).toContain(
      '-# 📋 NEW TASK · Car Team A · URGENT',
    );
  });

  it('neutralises hostile text and stays within budget', () => {
    const c = renderTaskCard(
      view({
        title: '@everyone **pwn** <@&333333333333333333>',
        description: `# heading\n${'line\n'.repeat(50)}${'x'.repeat(5000)}`,
        teamName: '@here team',
        lastUpdate: { authorId: MAYA, at: NOW, body: '@everyone [click](https://evil.example)' },
        status: 'in_progress',
      }),
    );
    const t = allText(c);
    expect(t).not.toMatch(/@everyone|@here|<@&3/);
    expect(t).toContain('\\*\\*pwn\\*\\*');
    expect(t).toContain('\\# heading');
    expect(t).not.toContain('[click]');
    expect(countText(c.components)).toBeLessThanOrEqual(4000);
    expect(countComponents(c.components)).toBeLessThanOrEqual(40);
    expect(t.split('\n').length).toBeLessThan(30);
  });

  it('truncates long link labels to 34 characters and shows at most five links', () => {
    const links = Array.from({ length: 7 }, (_, i) => ({
      label: `${'L'.repeat(40)}${i}`,
      url: `https://e.com/${i}`,
    }));
    const linkButtons = buttons(renderTaskCard(view({ links }))).filter((x) => x['style'] === 5);
    expect(linkButtons).toHaveLength(5);
    for (const b of linkButtons) expect(String(b['label']).length).toBeLessThanOrEqual(34);
  });

  it('has no separator or link row when there are no links and no actions', () => {
    const c = renderTaskCard(view({ links: [], status: 'done', variant: 'refresh' }));
    expect(buttons(c)).toEqual([]);
    expect(JSON.stringify(c.components)).not.toContain('"type":14');
  });
});

describe('the other task cards', () => {
  it('update card: author, escaped body, reply to the task card, no art, no pings', () => {
    const c = renderUpdateCard({
      taskTitle: 'Wire the brake light harness',
      teamName: 'Car Team A',
      authorId: MAYA,
      body: 'Left side done @everyone\n\nBlocked: waiting on connectors',
      replyTo: '999999999999999999',
    });
    const t = allText(c);
    expect(t).toContain('-# 📝 UPDATE · Car Team A');
    expect(t).toContain(`<@${MAYA}>: Left side done`);
    expect(t).not.toContain('@everyone');
    expect(c.replyTo).toBe('999999999999999999');
    expect(c.art).toEqual([]);
    expect(c.allowedMentions).toEqual({ parse: [] });
    expect(accent(c)).toBe(0x3b82f6);
  });

  it('update card from an organiser (non-snowflake author) says "an organiser"', () => {
    const c = renderUpdateCard({ taskTitle: 't', teamName: 'T', authorId: 'owner', body: 'x' });
    expect(allText(c)).toContain('an organiser: x');
  });

  it('review request: amber, Approve (success) and Send back, pings the reviewer role', () => {
    const c = renderReviewRequestCard({
      taskId: TASK,
      version: 4,
      taskTitle: 'Wire it',
      teamName: 'Car Team A',
      requestedBy: MAYA,
      reviewerRoleId: ROLE,
      latestUpdate: 'Both lights work',
    });
    const t = allText(c);
    expect(t).toContain('-# 👀 WAITING FOR REVIEW · Car Team A');
    expect(t).toContain(`Marked done by <@${MAYA}> · <@&${ROLE}> review this task`);
    expect(t).toContain('> Both lights work');
    expect(buttons(c).map((x) => [x['custom_id'], x['style']])).toEqual([
      [`bs.task:approve:${TASK}:4`, 3],
      [`bs.task:reject:${TASK}:4`, 2],
    ]);
    expect(c.allowedMentions).toEqual({ parse: [], roles: [ROLE] });
    expect(accent(c)).toBe(0xe0a526);
  });

  it('review decision: green approved / blue sent back, no buttons', () => {
    const ok = renderReviewDecisionCard({
      taskTitle: 'Wire it',
      teamName: 'A',
      decision: 'approved',
      deciderId: LEO,
      at: NOW,
    });
    expect(allText(ok)).toContain('-# ✅ APPROVED · A');
    expect(allText(ok)).toContain(`Approved by <@${LEO}>`);
    expect(accent(ok)).toBe(0x2e9a62);
    const back = renderReviewDecisionCard({
      taskTitle: 'Wire it',
      teamName: 'A',
      decision: 'sent-back',
      deciderId: LEO,
      at: NOW,
    });
    expect(allText(back)).toContain('-# ↩️ SENT BACK · A');
    expect(accent(back)).toBe(0x3b82f6);
    expect(buttons(back)).toEqual([]);
  });

  it('reminder: art, due line, pings, Post update; I’m on it only while not started', () => {
    const base = {
      taskId: TASK,
      version: 2,
      taskTitle: 'Upload CFD results',
      teamName: 'Aero',
      dueAt: NOW + 2 * DAY,
      now: NOW,
      audience: { kind: 'users' as const, userIds: [LEO] },
    };
    const c = renderReminderCard({ ...base, kind: 'pre_due', status: 'not_started' });
    expect(allText(c)).toContain('-# ⏰ DUE SOON · Aero');
    expect(c.art).toEqual(['saurThumb']);
    expect(c.allowedMentions).toEqual({ parse: [], users: [LEO] });
    expect(buttons(c).map((x) => x['custom_id'])).toEqual([
      `bs.task:update:${TASK}`,
      `bs.task:start:${TASK}:2`,
    ]);
    const custom = renderReminderCard({ ...base, kind: 'custom', status: 'in_progress' });
    expect(allText(custom)).toContain('-# ⏰ REMINDER · Aero');
    expect(buttons(custom).map((x) => x['custom_id'])).toEqual([`bs.task:update:${TASK}`]);
  });

  it('check-in: lists up to 10 tasks and counts the rest', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      title: `Task ${i}`,
      dueAt: NOW + i * DAY,
      who: `<@${MAYA}>`,
    }));
    const c = renderCheckinCard({ teamName: 'A', items, pingUsers: [MAYA], pingRoles: [] });
    const t = allText(c);
    expect(t).toContain('-# 👋 WEEKLY CHECK-IN · A');
    expect(t).toContain('Task 9');
    expect(t).not.toContain('Task 10');
    expect(t).toContain('and 2 more');
    expect(c.art).toEqual(['saurThumb']);
    expect(c.allowedMentions).toEqual({ parse: [], users: [MAYA] });
  });

  it('digest: banner art, counts in the title, sections, "No open tasks." when empty', () => {
    const c = renderDigestCard({
      teamName: 'Car Team A',
      weekOf: NOW,
      overdue: [{ title: 'Bearings', dueAt: NOW - DAY, who: `<@${LEO}>` }],
      dueThisWeek: [{ title: 'Harness', dueAt: NOW + DAY, who: `<@${MAYA}>` }],
      later: [],
      doneThisWeek: ['Seat welds', 'Pedal box'],
    });
    const t = allText(c);
    expect(t).toContain('-# 🗓️ WEEKLY DIGEST · Car Team A');
    expect(t).toContain('**Car Team A: 2 done, 1 due this week, 1 overdue**');
    expect(t).toContain('**⚠️ Overdue**');
    expect(t).toContain('**✅ Done this week**');
    expect(c.art).toEqual(['bannerDigest']);
    expect(c.allowedMentions).toEqual({ parse: [] });
    const empty = renderDigestCard({
      teamName: 'B',
      weekOf: NOW,
      overdue: [],
      dueThisWeek: [],
      later: [],
      doneThisWeek: [],
    });
    expect(allText(empty)).toContain('No open tasks.');
  });

  it('pick card: one secondary button per candidate, replying to the member', () => {
    const c = renderPickCard({
      choiceMessageId: '999999999999999999',
      candidates: [
        { taskId: TASK, title: 'A' },
        { taskId: '00000000-0000-4000-8000-000000000002', title: 'B' },
      ],
    });
    expect(buttons(c)).toHaveLength(2);
    expect(buttons(c).every((x) => x['style'] === 2)).toBe(true);
    expect(c.replyTo).toBe('999999999999999999');
    expect(allText(c)).toContain('**Which task is this update for?**');
  });

  it('clarify card escapes model text and replies', () => {
    const c = renderClarifyCard({ question: 'Which side? @everyone', replyTo: '9' });
    expect(allText(c)).not.toContain('@everyone');
    expect(allText(c)).toContain('Which side?');
    expect(c.replyTo).toBe('9');
  });

  it('task list groups by team, soonest first, caps at 10', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      teamName: i % 2 ? 'Aero' : 'Car',
      title: `Item${i}`,
      status: 'in_progress' as const,
      dueAt: NOW + (i - 1) * DAY,
    }));
    const t = allText(renderTaskListCard({ rows, now: NOW }));
    expect(t).toContain('-# 📋 YOUR TASKS · 12 open');
    expect(t).toContain('**Car**');
    expect(t).toContain('**Aero**');
    expect(t).toContain('and 2 more');
    expect(t).toContain('⚠️ Item0');
    expect(t).not.toContain('Item10');
  });

  it.each([
    ['not_started', 1, '📋'],
    ['in_progress', 1, '🔧'],
    ['not_started', -1, '⚠️'],
    ['in_progress', -1, '⚠️'],
    ['awaiting_approval', 1, '👀'],
    ['awaiting_approval', -1, '👀'],
  ] as const)('task list renders %s at day %s with %s', (status, days, icon) => {
    const dueAt = NOW + days * DAY;
    const t = allText(
      renderTaskListCard({
        rows: [{ teamName: 'Tech', title: 'Task status', status, dueAt }],
        now: NOW,
      }),
    );
    const label =
      status === 'awaiting_approval'
        ? 'waiting for review'
        : `due <t:${Math.floor(dueAt / 1000)}:R>`;
    expect(t).toContain(`- ${icon} Task status · ${label}`);
  });

  it('complete picker holds a select of up to 25 tasks', () => {
    const tasks = Array.from({ length: 30 }, (_, i) => ({
      taskId: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`,
      title: `T${i}`,
      dueLabel: 'due Oct 17',
    }));
    const json = JSON.stringify(renderCompletePickerCard({ tasks }).components);
    expect(json).toContain('"custom_id":"bs.task:complete"');
    expect((json.match(/"value":/g) ?? []).length).toBe(25);
  });

  it('complete picker keeps every option label and description within Discord limits', () => {
    const options: { label: string; value: string; description?: string }[] = [];
    const collect = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(collect);
      if (typeof v !== 'object' || v === null) return;
      const o = v as Record<string, unknown>;
      if (o['type'] === 3 && Array.isArray(o['options']))
        options.push(...(o['options'] as { label: string; value: string; description?: string }[]));
      collect(o['components']);
    };
    collect(
      renderCompletePickerCard({
        tasks: [
          {
            taskId: '00000000-0000-4000-8000-0000000000a1',
            title: `  ${'y'.repeat(150)}  `,
            dueLabel: 'd'.repeat(150),
          },
          { taskId: '00000000-0000-4000-8000-0000000000a2', title: '   ', dueLabel: 'due soon' },
        ],
      }).components,
    );
    expect(options).toHaveLength(2);
    for (const o of options) {
      // Discord rejects empty or over-100 select labels and descriptions.
      expect(o.label.length).toBeGreaterThan(0);
      expect(o.label.length).toBeLessThanOrEqual(100);
      expect(typeof o.description).toBe('string');
      expect(o.description?.length ?? 0).toBeGreaterThan(0);
      expect(o.description?.length ?? 0).toBeLessThanOrEqual(100);
    }
    const long = options.find((o) => o.value === '00000000-0000-4000-8000-0000000000a1');
    expect(long?.label.endsWith('…')).toBe(true);
    expect(long?.description?.endsWith('…')).toBe(true);
    const blank = options.find((o) => o.value === '00000000-0000-4000-8000-0000000000a2');
    expect(blank?.label).toBe('Task');
  });

  it('update modal: body required 3–1000, blocker optional ≤200, shows the task title', () => {
    const m = buildUpdateModal(TASK, 'Wire the brake light harness');
    expect(m.custom_id).toBe(`bs.task:update:${TASK}`);
    expect(m.title).toBe('Post an update');
    const json = JSON.stringify(m);
    expect(json).toContain('"custom_id":"body"');
    expect(json).toContain('"min_length":3');
    expect(json).toContain('"max_length":1000');
    expect(json).toContain('"custom_id":"blocker"');
    expect(json).toContain('"required":false');
    expect(json).toContain('Wire the brake light harness');
  });
});

describe('budget under worst-case input', () => {
  const nasty = (n: number) => `*_~${'x'.repeat(n)}`;
  const within = (c: { components: readonly unknown[] }) => {
    expect(countText(c.components)).toBeLessThanOrEqual(4000);
    expect(countComponents(c.components)).toBeLessThanOrEqual(40);
  };
  const who2 = `<@${MAYA}> <@${LEO}>`;
  const many = (n: number, title: number, who: string) =>
    Array.from({ length: n }, (_, i) => ({
      title: `${i}${nasty(title)}`,
      dueAt: NOW + i * DAY,
      who,
    }));

  it('digest with every section full does not throw and counts omitted rows exactly', () => {
    for (const title of [(n: number) => 'T'.repeat(n), nasty]) {
      const c = renderDigestCard({
        teamName: 'Car Team A',
        weekOf: NOW,
        overdue: many(6, 120, who2).map((i) => ({ ...i, title: title(120) })),
        dueThisWeek: many(6, 120, who2).map((i) => ({ ...i, title: title(120) })),
        later: many(6, 120, who2).map((i) => ({ ...i, title: title(120) })),
        doneThisWeek: Array.from({ length: 8 }, () => title(80)),
      });
      within(c);
      const t = allText(c);
      expect(t).toContain('**⚠️ Overdue**');
      expect(t).toContain('**Later**');
      expect(t).toContain('Done this week');
      expect(t).toContain('**Car Team A: 8 done, 6 due this week, 6 overdue**');
    }
  });

  it('digest keeps every section visible and reports omitted rows accurately', () => {
    const c = renderDigestCard({
      teamName: 'A',
      weekOf: NOW,
      overdue: many(40, 120, who2),
      dueThisWeek: many(40, 120, who2),
      later: many(40, 120, who2),
      doneThisWeek: Array.from({ length: 40 }, () => nasty(80)),
    });
    within(c);
    const t = allText(c);
    const shown = (t.match(/^- /gm) ?? []).length;
    const more = [...t.matchAll(/- and (\d+) more/g)].reduce((n, m) => n + Number(m[1]), 0);
    const doneShown = (t.split('Done this week**\n')[1] ?? '').split('\n')[0]?.split(', ').length;
    expect(shown - 3 + more).toBe(120);
    expect(doneShown).toBeGreaterThan(0);
    expect(t).toContain('**⚠️ Overdue**');
    expect(t).toContain('**Later**');
  });

  it('digest survives an enormous mention list', () => {
    const who = Array.from({ length: 200 }, () => `<@${MAYA}>`).join(' ');
    const c = renderDigestCard({
      teamName: 'A',
      weekOf: NOW,
      overdue: many(6, 120, who),
      dueThisWeek: many(6, 120, who),
      later: many(6, 120, who),
      doneThisWeek: ['a'],
    });
    within(c);
    expect(allText(c)).not.toMatch(/<@\d*$/m);
  });

  it('check-in with 10 tasks and 10 assignees each does not throw', () => {
    const who = Array.from({ length: 10 }, () => `<@${MAYA}>`).join(' ');
    const c = renderCheckinCard({
      teamName: nasty(200),
      items: many(12, 120, who),
      pingUsers: [MAYA],
      pingRoles: [],
    });
    within(c);
    expect(allText(c)).toMatch(/- and \d+ more/);
  });

  it('check-in counts omitted rows exactly', () => {
    const who = Array.from({ length: 10 }, () => `<@${MAYA}>`).join(' ');
    const t = allText(
      renderCheckinCard({ teamName: 'A', items: many(12, 120, who), pingUsers: [], pingRoles: [] }),
    );
    const shown = (t.match(/^- (?!and )/gm) ?? []).length;
    const omitted = Number(/- and (\d+) more/.exec(t)?.[1] ?? 0);
    expect(shown + omitted).toBe(12);
  });

  it('every other renderer stays within budget on worst-case text', () => {
    const big = nasty(5000);
    within(renderUpdateCard({ taskTitle: big, teamName: big, authorId: MAYA, body: big }));
    within(
      renderReviewRequestCard({
        taskId: TASK,
        version: 1,
        taskTitle: big,
        teamName: big,
        requestedBy: MAYA,
        reviewerRoleId: ROLE,
        latestUpdate: big,
      }),
    );
    within(
      renderReviewDecisionCard({
        taskTitle: big,
        teamName: big,
        decision: 'approved',
        deciderId: LEO,
        at: NOW,
      }),
    );
    within(
      renderReminderCard({
        taskId: TASK,
        version: 1,
        taskTitle: big,
        teamName: big,
        dueAt: NOW,
        now: NOW,
        audience: { kind: 'users', userIds: [MAYA, LEO] },
        kind: 'custom',
        status: 'not_started',
      }),
    );
    within(renderClarifyCard({ question: big, replyTo: '9' }));
    within(
      renderPickCard({
        choiceMessageId: '9',
        candidates: Array.from({ length: 9 }, (_, i) => ({
          taskId: `00000000-0000-4000-8000-00000000000${i}`,
          title: big,
        })),
      }),
    );
    const rows = Array.from({ length: 30 }, (_, i) => ({
      teamName: `${i}${nasty(200)}`,
      title: nasty(300),
      status: 'in_progress' as const,
      dueAt: NOW + i * DAY,
    }));
    within(renderTaskListCard({ rows, now: NOW }));
    within(
      renderTaskCard(
        view({
          title: big,
          description: big,
          teamName: big,
          audience: { kind: 'users', userIds: Array.from({ length: 40 }, () => MAYA) },
        }),
      ),
    );
  });
});

describe('digest budget edges', () => {
  const who = Array.from({ length: 200 }, () => `<@${MAYA}>`).join(' ');
  const rowsOf = (n: number, w: string) =>
    Array.from({ length: n }, (_, i) => ({ title: `Row${i}`, dueAt: NOW + i * DAY, who: w }));
  it('shows at least one row per section even with an enormous mention list', () => {
    const t = allText(
      renderDigestCard({
        teamName: 'A',
        weekOf: NOW,
        overdue: rowsOf(6, who),
        dueThisWeek: rowsOf(6, who),
        later: rowsOf(6, who),
        doneThisWeek: [],
      }),
    );
    for (const heading of ['Overdue**', 'Due this week**', 'Later**']) {
      const body = t.split(`${heading}\n`)[1]?.split('\n')[0] ?? '';
      expect(body).toContain('Row0');
    }
    expect(t).toMatch(/\+\d+ more/);
  });
  it('a single long section fills its share and its "and N more" line still fits', () => {
    const c = renderDigestCard({
      teamName: 'A',
      weekOf: NOW,
      overdue: Array.from({ length: 6 }, (_, i) => ({
        title: `${'z'.repeat(120)}${i}`,
        dueAt: NOW,
        who: Array.from({ length: 5 }, () => `<@${MAYA}>`).join(' '),
      })),
      dueThisWeek: [],
      later: [],
      doneThisWeek: Array.from({ length: 40 }, () => 'q'.repeat(80)),
    });
    expect(countText(c.components)).toBeLessThanOrEqual(4000);
    expect(allText(c)).toMatch(/and \d+ more/);
  });
});

describe('ordering and modal fields', () => {
  it('task list sorts soonest first even when the input is shuffled', () => {
    const mk = (title: string, days: number) => ({
      teamName: 'T',
      title,
      status: 'not_started' as const,
      dueAt: NOW + days * DAY,
    });
    const t = allText(
      renderTaskListCard({ rows: [mk('Third', 9), mk('First', 1), mk('Second', 5)], now: NOW }),
    );
    expect(t.indexOf('First')).toBeGreaterThan(-1);
    expect(t.indexOf('First')).toBeLessThan(t.indexOf('Second'));
    expect(t.indexOf('Second')).toBeLessThan(t.indexOf('Third'));
  });

  it('update modal fields: body and blocker, each pinned', () => {
    const fields: Record<string, unknown>[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (typeof v !== 'object' || v === null) return;
      const o = v as Record<string, unknown>;
      if (typeof o['custom_id'] === 'string' && o['custom_id'] !== '' && o['type'] === 4)
        fields.push(o);
      walk(o['components']);
      walk(o['component']);
    };
    walk(buildUpdateModal(TASK, undefined).components);
    const body = fields.find((f) => f['custom_id'] === 'body');
    const blocker = fields.find((f) => f['custom_id'] === 'blocker');
    expect(fields).toHaveLength(2);
    expect(body).toMatchObject({ style: 2, required: true, min_length: 3, max_length: 1000 });
    expect(blocker).toMatchObject({ style: 1, required: false, max_length: 200 });
    expect(blocker?.['min_length']).toBeUndefined();
  });
});

describe('digest and check-in budget, pinned tightly', () => {
  const mention = `<@${MAYA}>`;
  const whoOf = (n: number) => Array.from({ length: n }, () => mention).join(' ');
  const rowsOf = (n: number, title: string, who: string) =>
    Array.from({ length: n }, (_, i) => ({ title: `${i}${title}`, dueAt: NOW, who }));
  const sectionLines = (t: string, heading: string): string[] => {
    const body = t.split(`${heading}\n`)[1]?.split('\n-# ')[0] ?? '';
    const next = body.search(/\n\*\*/);
    return (next === -1 ? body : body.slice(0, next)).split('\n');
  };
  const full = () =>
    renderDigestCard({
      teamName: 'A',
      weekOf: NOW,
      overdue: rowsOf(6, 'z'.repeat(119), whoOf(5)),
      dueThisWeek: rowsOf(6, 'z'.repeat(119), whoOf(5)),
      later: rowsOf(6, 'z'.repeat(119), whoOf(5)),
      doneThisWeek: Array.from({ length: 8 }, (_, i) => `${i}${'q'.repeat(79)}`),
    });

  it('three full sections get the same share and shorten a row before dropping it', () => {
    const t = allText(full());
    for (const heading of ['⚠️ Overdue**', '⏰ Due this week**', 'Later**']) {
      const lines = sectionLines(t, heading);
      expect(lines).toHaveLength(5);
      expect(lines[0]).toContain(`0${'z'.repeat(119)}`);
      expect(lines[3]).toMatch(/^- 3z{20,60}… · /);
      expect(lines[3]?.length).toBeLessThan(lines[2]?.length ?? 0);
      expect(lines[4]).toBe('- and 2 more');
    }
    expect(countText(full().components)).toBeGreaterThanOrEqual(3600);
  });

  it('two long sections do not starve a short one', () => {
    const t = allText(
      renderDigestCard({
        teamName: 'A',
        weekOf: NOW,
        overdue: rowsOf(6, 'z'.repeat(119), whoOf(5)),
        dueThisWeek: rowsOf(6, 'z'.repeat(119), whoOf(5)),
        later: rowsOf(1, 'k', MAYA),
        doneThisWeek: [],
      }),
    );
    expect(sectionLines(t, 'Later**')).toHaveLength(1);
    expect(sectionLines(t, '⚠️ Overdue**')).toHaveLength(6);
    expect(sectionLines(t, '⏰ Due this week**')).toHaveLength(6);
  });

  it('done list: exact omitted count, by cap and by budget', () => {
    const doneLine = (titles: string[]) =>
      sectionLines(
        allText(
          renderDigestCard({
            teamName: 'A',
            weekOf: NOW,
            overdue: [],
            dueThisWeek: [],
            later: [],
            doneThisWeek: titles,
          }),
        ),
        '✅ Done this week**',
      )[0] ?? '';
    expect(doneLine(Array.from({ length: 12 }, (_, i) => `t${i}`))).toBe(
      't0, t1, t2, t3, t4, t5, t6, t7, and 4 more',
    );
    expect(doneLine(['a', 'b'])).toBe('a, b');
    const t = allText(full());
    expect(sectionLines(t, '✅ Done this week**')[0]).toMatch(/^0q{79}, 1q{79}/);
    const crowded = (n: number) =>
      allText(
        renderDigestCard({
          teamName: 'A',
          weekOf: NOW,
          overdue: rowsOf(6, 'z'.repeat(119), whoOf(5)),
          dueThisWeek: rowsOf(6, 'z'.repeat(119), whoOf(5)),
          later: rowsOf(6, 'z'.repeat(119), whoOf(5)),
          doneThisWeek: Array.from({ length: n }, (_, i) => `${i}${'q'.repeat(79)}`),
        }),
      );
    const line = sectionLines(crowded(8), '✅ Done this week**')[0] ?? '';
    expect(line.split(', ')).toHaveLength(8);
    const shortDone = sectionLines(crowded(8), '✅ Done this week**')[0] ?? '';
    expect(shortDone).not.toContain('more');
  });

  it('shortens done titles when its share is small', () => {
    const t = allText(
      renderDigestCard({
        teamName: 'A',
        weekOf: NOW,
        overdue: rowsOf(6, 'z'.repeat(119), whoOf(30)),
        dueThisWeek: rowsOf(6, 'z'.repeat(119), whoOf(30)),
        later: rowsOf(6, 'z'.repeat(119), whoOf(30)),
        doneThisWeek: Array.from({ length: 200 }, (_, i) => `${i}${'q'.repeat(79)}`),
      }),
    );
    const line = sectionLines(t, '✅ Done this week**')[0] ?? '';
    const m = /and (\d+) more$/.exec(line);
    const shown = line.replace(/, and \d+ more$/, '').split(', ');
    expect(Number(m?.[1]) + shown.length).toBe(200);
  });

  it('escaped length counts: titles that fit raw but not escaped are shortened or dropped', () => {
    const star = '*'.repeat(119);
    const t = allText(
      renderCheckinCard({
        teamName: 'A',
        items: rowsOf(10, star, whoOf(10)),
        pingUsers: [],
        pingRoles: [],
      }),
    );
    expect(t).not.toMatch(/(?<!\\)\*{2}\*/);
    expect(t).toContain('\\*');
    const c = renderDigestCard({
      teamName: 'A',
      weekOf: NOW,
      overdue: rowsOf(6, star, whoOf(5)),
      dueThisWeek: rowsOf(6, star, whoOf(5)),
      later: rowsOf(6, star, whoOf(5)),
      doneThisWeek: Array.from({ length: 8 }, () => '*'.repeat(80)),
    });
    expect(countText(c.components)).toBeLessThanOrEqual(4000);
    expect(countText(c.components)).toBeGreaterThanOrEqual(3400);
  });

  it('row titles are escaped in digest and check-in rows', () => {
    const item = { title: '@everyone *bold* <@&333333333333333333>', dueAt: NOW, who: mention };
    const d = allText(
      renderDigestCard({
        teamName: 'A',
        weekOf: NOW,
        overdue: [item],
        dueThisWeek: [item],
        later: [item],
        doneThisWeek: [item.title],
      }),
    );
    const k = allText(
      renderCheckinCard({ teamName: 'A', items: [item], pingUsers: [], pingRoles: [] }),
    );
    for (const t of [d, k]) {
      expect(t).not.toMatch(/@everyone|<@&3/);
      expect(t).toContain('\\*bold\\*');
    }
  });

  it('check-in budgets against its own head too (long team name)', () => {
    const c = renderCheckinCard({
      teamName: '*'.repeat(200),
      items: rowsOf(10, 'z'.repeat(119), whoOf(30)),
      pingUsers: [],
      pingRoles: [],
    });
    expect(countText(c.components)).toBeLessThanOrEqual(4000);

    const who = Array(5).fill('<@11111111111111111111>').join(' ');
    const c2 = renderCheckinCard({
      teamName: '*'.repeat(60),
      items: Array(10).fill({ title: '*'.repeat(120), who, dueAt: NOW }),
      pingUsers: [],
      pingRoles: [],
    });
    expect(countText(c2.components)).toBeLessThanOrEqual(4000);
  });

  it('check-in row joins count their newline separators against the budget', () => {
    const who = Array(5).fill('<@11111111111111111111>').join(' ');
    const items: { title: string; who: string; dueAt: number }[] = [];
    items.length = 1_000_000;
    for (let i = 0; i < 10; i += 1) items[i] = { title: '*'.repeat(116), who, dueAt: NOW };
    const c = renderCheckinCard({
      teamName: '*'.repeat(9),
      items,
      pingUsers: [],
      pingRoles: [],
    });
    expect(countText(c.components)).toBeLessThanOrEqual(4000);
  });

  it('a lone oversized mention is reported as 1 person, not "1 people"', () => {
    const who = Array.from({ length: 12 }, () => `<@&${MAYA}${MAYA}${MAYA}>`).join('');
    const t = allText(
      renderCheckinCard({
        teamName: 'A',
        items: rowsOf(1, 't', who),
        pingUsers: [],
        pingRoles: [],
      }),
    );
    expect(t).not.toContain('1 people');
  });

  it('caps the mention text at 120 characters including its "+N more" tail', () => {
    const t = allText(
      renderCheckinCard({
        teamName: 'A',
        items: rowsOf(3, 't', whoOf(200)),
        pingUsers: [],
        pingRoles: [],
      }),
    );
    const rows = t.split('\n').filter((l) => l.startsWith('- **'));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const who = row.split(' · ').at(-1) ?? '';
      expect(who.length).toBeLessThanOrEqual(120);
      expect(who).toMatch(/\+\d+ more$/);
    }
  });

  it('done titles shorten to 40 then 20 characters as the share runs out', () => {
    const t = allText(
      renderDigestCard({
        teamName: 'A',
        weekOf: NOW,
        overdue: rowsOf(6, 'z'.repeat(119), whoOf(30)),
        dueThisWeek: rowsOf(6, 'z'.repeat(119), whoOf(30)),
        later: rowsOf(6, 'z'.repeat(119), whoOf(30)),
        doneThisWeek: Array.from({ length: 200 }, () => `${'*'.repeat(70)}`),
      }),
    );
    const line = sectionLines(t, '✅ Done this week**')[0] ?? '';
    expect(line).toMatch(/^(\\\*){70}, (\\\*){70}, /);
    expect(line).toMatch(/, (\\\*){39}…, (\\\*){19}…, and 192 more$/);
  });

  it('seeded fuzz: never over 4,000, and some inputs come close to it', () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const title = () => {
      const len = 1 + rnd(130);
      const chars = ['x', '*', '_', '@', '#', '😀', 'é'];
      return Array.from({ length: len }, () => chars[rnd(chars.length)] ?? 'x').join('');
    };
    const items = (n: number) =>
      Array.from({ length: n }, () => ({ title: title(), dueAt: NOW, who: whoOf(1 + rnd(30)) }));
    let max = 0;
    for (let i = 0; i < 400; i += 1) {
      const c =
        i % 3 === 0
          ? renderCheckinCard({
              teamName: title(),
              items: items(rnd(14)),
              pingUsers: [],
              pingRoles: [],
            })
          : renderDigestCard({
              teamName: title(),
              weekOf: NOW,
              overdue: items(rnd(9)),
              dueThisWeek: items(rnd(9)),
              later: items(rnd(9)),
              doneThisWeek: Array.from({ length: rnd(12) }, title),
            });
      const n = countText(c.components);
      expect(n).toBeLessThanOrEqual(4000);
      max = Math.max(max, n);
    }
    expect(max).toBeGreaterThanOrEqual(3850);
  });
});
