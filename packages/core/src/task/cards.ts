import {
  actionRow,
  ART,
  artUrl,
  button,
  card,
  clampLines,
  escapeInline,
  escapeText,
  gallery,
  ICON,
  label,
  linkButton,
  mentionRole,
  mentionUser,
  modal,
  section,
  selectRow,
  separator,
  stringSelect,
  subtext,
  text,
  textInput,
  thumbnail,
  truncate,
  ts,
  type Button,
  type CardMessage,
  type ContainerChild,
  type LinkButton,
  type Modal,
  type Tone,
} from '../ui/discord/index.js';
import { buildTaskCustomId } from './components.js';

export type TaskStatus = 'not_started' | 'in_progress' | 'awaiting_approval' | 'done';
export type TaskAudience =
  | { readonly kind: 'users'; readonly userIds: readonly string[] }
  | { readonly kind: 'role'; readonly roleId: string }
  | { readonly kind: 'team' };

export interface TaskCardView {
  readonly taskId: string;
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly teamName: string;
  readonly status: TaskStatus;
  readonly priority: 'normal' | 'urgent';
  readonly dueAt: number;
  readonly now: number;
  readonly audience: TaskAudience;
  readonly links: readonly { readonly label: string; readonly url: string }[];
  readonly pickedUp?: { readonly userId: string; readonly at: number };
  readonly lastUpdate?: { readonly authorId: string; readonly at: number; readonly body: string };
  readonly updatedAt: number;
  /** `announce`: the first post (pings, hint footer). `refresh`: an edit (no pings). */
  readonly variant: 'announce' | 'refresh';
}

const SNOWFLAKE = /^\d{17,20}$/;
/** A member mention for a Discord id; dashboard and MCP actors read as "an organiser". */
export const actorLabel = (id: string): string =>
  SNOWFLAKE.test(id) ? mentionUser(id) : 'an organiser';

const teamText = (name: string): string => escapeInline(truncate(name, 60));
const titleLine = (title: string): string => `**${escapeInline(truncate(title, 180))}**`;
const eyebrow = (icon: string, kind: string, context: string): string =>
  subtext(`${icon} ${kind} · ${context}`);
const quoteBlock = (raw: string, max: number, lines: number): string =>
  escapeText(clampLines(truncate(raw.trim(), max), lines))
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

const audienceText = (audience: TaskAudience): string =>
  audience.kind === 'users'
    ? `For ${audience.userIds.map(mentionUser).join(' ')}`
    : audience.kind === 'role'
      ? `For ${mentionRole(audience.roleId)}`
      : 'For the whole team';
const audiencePings = (audience: TaskAudience) => ({
  pingUsers: audience.kind === 'users' ? audience.userIds : [],
  pingRoles: audience.kind === 'role' ? [audience.roleId] : [],
});

const isOverdue = (v: { status: TaskStatus; dueAt: number; now: number }): boolean =>
  v.status !== 'done' && v.dueAt < v.now;

const taskTone = (v: TaskCardView): Tone =>
  v.status === 'done'
    ? 'ok'
    : v.status === 'awaiting_approval'
      ? 'hold'
      : isOverdue(v)
        ? 'danger'
        : v.status === 'in_progress'
          ? 'progress'
          : 'accent';

const taskEyebrow = (v: TaskCardView): string => {
  const [icon, kind] =
    v.status === 'done'
      ? [ICON.done, 'DONE']
      : v.status === 'awaiting_approval'
        ? [ICON.review, 'WAITING FOR REVIEW']
        : isOverdue(v)
          ? [ICON.overdue, 'OVERDUE']
          : v.status === 'in_progress'
            ? [ICON.inProgress, 'IN PROGRESS']
            : [ICON.task, 'NEW TASK'];
  return eyebrow(
    icon,
    kind,
    `${teamText(v.teamName)}${v.priority === 'urgent' ? ' · URGENT' : ''}`,
  );
};

const dueText = (v: { status: TaskStatus; dueAt: number; now: number }): string =>
  v.status === 'done'
    ? `Due ${ts(v.dueAt, 'D')}`
    : `${isOverdue(v) ? 'Was due' : 'Due'} ${ts(v.dueAt, 'f')} (${ts(v.dueAt, 'R')})`;

const linkRow = (links: TaskCardView['links']): ContainerChild[] =>
  links.length === 0
    ? []
    : [
        actionRow(
          links
            .slice(0, 5)
            .map((l) => linkButton({ url: l.url, label: truncate(l.label.trim(), 34) })),
        ),
      ];

const startButton = (taskId: string, version: number, primary: boolean): Button =>
  button({
    customId: buildTaskCustomId({ action: 'start', taskId, version }),
    label: "I'm on it",
    emoji: ICON.inProgress,
    style: primary ? 'primary' : 'secondary',
  });
const updateButton = (taskId: string, primary: boolean): Button =>
  button({
    customId: buildTaskCustomId({ action: 'update', taskId }),
    label: 'Post update',
    emoji: ICON.update,
    style: primary ? 'primary' : 'secondary',
  });

const thumb = () => thumbnail(artUrl('saurThumb'), ART.saurThumb.alt);

export const renderTaskCard = (view: TaskCardView): CardMessage => {
  const head = text(`${taskEyebrow(view)}\n${titleLine(view.title)}`);
  const description = view.description.trim();
  const body =
    description === '' ? [] : [text(escapeText(clampLines(truncate(description, 600), 6)))];
  const facts = text(`${dueText(view)} · ${audienceText(view.audience)}`);
  const children: ContainerChild[] = [section([head, ...body, facts], thumb())];

  const activity: string[] = [];
  if (view.status === 'in_progress' && view.pickedUp !== undefined)
    activity.push(
      `${ICON.inProgress} Picked up by ${actorLabel(view.pickedUp.userId)} ${ts(view.pickedUp.at, 'R')}`,
    );
  if (view.lastUpdate !== undefined)
    activity.push(
      `${ICON.update} Last update ${ts(view.lastUpdate.at, 'R')} from ${actorLabel(view.lastUpdate.authorId)}: “${escapeInline(truncate(view.lastUpdate.body, 140))}”`,
    );
  if (activity.length > 0) children.push(text(activity.join('\n')));

  const actions: (Button | LinkButton)[] =
    view.status === 'not_started'
      ? [startButton(view.taskId, view.version, true), updateButton(view.taskId, false)]
      : view.status === 'in_progress'
        ? [updateButton(view.taskId, true)]
        : [];
  const links = linkRow(view.links);
  if (links.length > 0 || actions.length > 0) children.push(separator());
  children.push(...links);
  if (actions.length > 0) children.push(actionRow(actions));
  children.push(
    text(
      view.variant === 'announce' && view.status !== 'done'
        ? subtext('Reply to this card or use Post update to share progress.')
        : subtext(`Updated ${ts(view.updatedAt, 'R')}`),
    ),
  );

  return card({
    tone: taskTone(view),
    children,
    art: ['saurThumb'],
    ...(view.variant === 'announce' ? audiencePings(view.audience) : {}),
  });
};

export interface UpdateCardView {
  readonly taskTitle: string;
  readonly teamName: string;
  readonly authorId: string;
  readonly body: string;
  readonly replyTo?: string;
}

export const renderUpdateCard = (view: UpdateCardView): CardMessage =>
  card({
    tone: 'progress',
    children: [
      text(
        `${eyebrow(ICON.update, 'UPDATE', teamText(view.teamName))}\n${titleLine(view.taskTitle)}`,
      ),
      text(
        `${actorLabel(view.authorId)}: ${escapeText(clampLines(truncate(view.body.trim(), 1500), 12))}`,
      ),
    ],
    ...(view.replyTo === undefined ? {} : { replyTo: view.replyTo }),
  });

export interface ReviewRequestView {
  readonly taskId: string;
  readonly version: number;
  readonly taskTitle: string;
  readonly teamName: string;
  readonly requestedBy: string;
  readonly reviewerRoleId?: string;
  readonly latestUpdate?: string;
}

export const renderReviewRequestCard = (view: ReviewRequestView): CardMessage => {
  const who = `Marked done by ${actorLabel(view.requestedBy)}${
    view.reviewerRoleId === undefined
      ? ''
      : ` · ${mentionRole(view.reviewerRoleId)} review this task`
  }`;
  const children: ContainerChild[] = [
    text(
      `${eyebrow(ICON.review, 'WAITING FOR REVIEW', teamText(view.teamName))}\n${titleLine(view.taskTitle)}\n${who}`,
    ),
  ];
  if (view.latestUpdate !== undefined && view.latestUpdate.trim() !== '')
    children.push(text(quoteBlock(view.latestUpdate, 600, 6)));
  children.push(
    separator(),
    actionRow([
      button({
        customId: buildTaskCustomId({
          action: 'approve',
          taskId: view.taskId,
          version: view.version,
        }),
        label: 'Approve',
        emoji: ICON.done,
        style: 'success',
      }),
      button({
        customId: buildTaskCustomId({
          action: 'reject',
          taskId: view.taskId,
          version: view.version,
        }),
        label: 'Send back',
        emoji: ICON.sentBack,
        style: 'secondary',
      }),
    ]),
  );
  return card({
    tone: 'hold',
    children,
    ...(view.reviewerRoleId === undefined ? {} : { pingRoles: [view.reviewerRoleId] }),
  });
};

export interface ReviewDecisionView {
  readonly taskTitle: string;
  readonly teamName: string;
  readonly decision: 'approved' | 'sent-back';
  readonly deciderId: string;
  readonly at: number;
}

export const renderReviewDecisionCard = (view: ReviewDecisionView): CardMessage => {
  const approved = view.decision === 'approved';
  return card({
    tone: approved ? 'ok' : 'progress',
    children: [
      text(
        `${eyebrow(approved ? ICON.done : ICON.sentBack, approved ? 'APPROVED' : 'SENT BACK', teamText(view.teamName))}\n${titleLine(view.taskTitle)}\n${approved ? 'Approved' : 'Sent back'} by ${actorLabel(view.deciderId)} ${ts(view.at, 'R')}`,
      ),
    ],
  });
};

export interface ReminderCardView {
  readonly taskId: string;
  readonly version: number;
  readonly taskTitle: string;
  readonly teamName: string;
  readonly dueAt: number;
  readonly now: number;
  readonly audience: TaskAudience;
  readonly kind: 'pre_due' | 'custom';
  readonly status: TaskStatus;
}

export const renderReminderCard = (view: ReminderCardView): CardMessage => {
  const head = text(
    `${eyebrow(ICON.due, view.kind === 'pre_due' ? 'DUE SOON' : 'REMINDER', teamText(view.teamName))}\n${titleLine(view.taskTitle)}`,
  );
  const facts = text(`${dueText(view)} · ${audienceText(view.audience)}`);
  const actions: Button[] = [updateButton(view.taskId, true)];
  if (view.status === 'not_started') actions.push(startButton(view.taskId, view.version, false));
  return card({
    tone: 'accent',
    children: [section([head, facts], thumb()), actionRow(actions)],
    art: ['saurThumb'],
    ...audiencePings(view.audience),
  });
};

export interface DigestItem {
  readonly title: string;
  readonly dueAt: number;
  /** Mention text built by the caller: `<@id> <@id>`, `<@&role>`, or `whole team`. */
  readonly who: string;
}

/** Text Display characters Discord allows across one message. */
const TEXT_BUDGET = 4000;
/** Room kept for the closing "and N more" line. */
const MORE_RESERVE = 24;
const TITLE_STEPS = [120, 60, 30, 15] as const;

const textLength = (c: ContainerChild): number => {
  if (c.type === 10) return c.content.length;
  if (c.type === 9) return c.components.reduce((n, t) => n + t.content.length, 0);
  return 0;
};

/** Whole mentions only, so a cut never leaves half a mention. */
const capWho = (who: string, max: number): string => {
  if (who.length <= max) return who;
  const tokens = who.split(' ');
  const kept: string[] = [];
  let used = 0;
  for (const token of tokens) {
    const next = used + token.length + (kept.length > 0 ? 1 : 0);
    if (next > max - 12) break;
    kept.push(token);
    used = next;
  }
  const rest = tokens.length - kept.length;
  return kept.length === 0
    ? `${rest} ${rest === 1 ? 'person' : 'people'}`
    : `${kept.join(' ')} +${rest} more`;
};

/**
 * Rows that fit `budget` characters of escaped text. Each row is tried with a shorter title
 * until it fits; once one cannot fit, the rest are counted in the closing line.
 */
const fitList = (
  items: readonly DigestItem[],
  maxRows: number,
  budget: number,
  render: (item: DigestItem, titleMax: number) => string,
): string => {
  const lines: string[] = [];
  let used = 0;
  for (const item of items.slice(0, maxRows)) {
    const fit = TITLE_STEPS.map((max) => `- ${render(item, max)}`).find(
      (line) => used + line.length + 1 + MORE_RESERVE <= budget,
    );
    if (fit === undefined) break;
    lines.push(fit);
    used += fit.length + 1;
  }
  const omitted = items.length - lines.length;
  if (omitted > 0) lines.push(`- and ${omitted} more`);
  return lines.join('\n');
};

const fitTitles = (titles: readonly string[], maxShown: number, budget: number): string => {
  const shown: string[] = [];
  let used = 0;
  for (const title of titles.slice(0, maxShown)) {
    const fit = [80, 40, 20]
      .map((max) => escapeInline(truncate(title, max)))
      .find((t) => used + t.length + 2 + MORE_RESERVE <= budget);
    if (fit === undefined) break;
    shown.push(fit);
    used += fit.length + 2;
  }
  const omitted = titles.length - shown.length;
  return `${shown.join(', ')}${omitted > 0 ? `${shown.length > 0 ? ', ' : ''}and ${omitted} more` : ''}`;
};

const itemLine = (i: DigestItem, titleMax: number): string =>
  `**${escapeInline(truncate(i.title, titleMax))}** · due ${ts(i.dueAt, 'R')} · ${capWho(i.who, 120)}`;

export interface CheckinCardView {
  readonly teamName: string;
  readonly items: readonly DigestItem[];
  readonly pingUsers: readonly string[];
  readonly pingRoles: readonly string[];
}

export const renderCheckinCard = (view: CheckinCardView): CardMessage => {
  const head = section(
    [
      text(
        `${eyebrow(ICON.checkin, 'WEEKLY CHECK-IN', teamText(view.teamName))}\n**How are these going?**`,
      ),
      text("Reply to this card with an update, or use Post update on the task's own card."),
    ],
    thumb(),
  );
  const budget = TEXT_BUDGET - textLength(head);
  return card({
    tone: 'accent',
    children: [head, text(fitList(view.items, 10, budget, itemLine))],
    art: ['saurThumb'],
    pingUsers: view.pingUsers,
    pingRoles: view.pingRoles,
  });
};

export interface DigestCardView {
  readonly teamName: string;
  readonly weekOf: number;
  readonly overdue: readonly DigestItem[];
  readonly dueThisWeek: readonly DigestItem[];
  readonly later: readonly DigestItem[];
  readonly doneThisWeek: readonly string[];
}

export const renderDigestCard = (view: DigestCardView): CardMessage => {
  const team = teamText(view.teamName);
  const children: ContainerChild[] = [
    gallery([{ media: { url: artUrl('bannerDigest') }, description: ART.bannerDigest.alt }]),
    text(
      `${eyebrow(ICON.digest, 'WEEKLY DIGEST', team)}\n**${team}: ${view.doneThisWeek.length} done, ${view.dueThisWeek.length} due this week, ${view.overdue.length} overdue**`,
    ),
  ];
  const footer = text(subtext('Posted every Monday · Use /task list to see yours'));
  const empty =
    view.overdue.length + view.dueThisWeek.length + view.later.length + view.doneThisWeek.length ===
    0;
  const sections: { heading: string; items?: readonly DigestItem[]; done?: readonly string[] }[] = [
    { heading: `**${ICON.overdue} Overdue**`, items: view.overdue },
    { heading: `**${ICON.due} Due this week**`, items: view.dueThisWeek },
    { heading: '**Later**', items: view.later },
    { heading: `**${ICON.done} Done this week**`, done: view.doneThisWeek },
  ].filter((x) => (x.items?.length ?? x.done?.length ?? 0) > 0);
  const line = (i: DigestItem, titleMax: number): string =>
    `${escapeInline(truncate(i.title, titleMax))} · ${capWho(i.who, 120)} · ${ts(i.dueAt, 'R')}`;
  let remaining =
    TEXT_BUDGET -
    children.reduce((n, c) => n + textLength(c), 0) -
    textLength(footer) -
    (empty ? 'No open tasks.'.length : 0) -
    sections.reduce((n, x) => n + x.heading.length + 1, 0);
  sections.forEach((x, index) => {
    const share = Math.floor(remaining / (sections.length - index));
    const body =
      x.items !== undefined ? fitList(x.items, 6, share, line) : fitTitles(x.done ?? [], 8, share);
    remaining -= body.length;
    children.push(text(`${x.heading}\n${body}`));
  });
  if (empty) children.push(text('No open tasks.'));
  children.push(footer);
  return card({ tone: 'accent', children, art: ['bannerDigest'] });
};

export interface PickCardView {
  readonly choiceMessageId: string;
  readonly candidates: readonly { readonly taskId: string; readonly title: string }[];
}

export const renderPickCard = (view: PickCardView): CardMessage =>
  card({
    tone: 'neutral',
    children: [
      text(
        '**Which task is this update for?**\nYour reply matches more than one task. Choose one and it is recorded there.',
      ),
      actionRow(
        view.candidates.slice(0, 5).map((c) =>
          button({
            customId: buildTaskCustomId({
              action: 'pick',
              choiceMessageId: view.choiceMessageId,
              taskId: c.taskId,
            }),
            label: truncate(c.title.trim() || 'Task', 38),
          }),
        ),
      ),
    ],
    replyTo: view.choiceMessageId,
  });

/** ADR 0112's clarifying question. The question is model output, so it is always escaped. */
export const renderClarifyCard = (view: { question: string; replyTo: string }): CardMessage =>
  card({
    tone: 'neutral',
    children: [
      text(
        `${subtext(`${ICON.hint} QUICK QUESTION`)}\n${escapeText(truncate(view.question.trim(), 1000))}`,
      ),
      text(subtext('Reply to this message to answer.')),
    ],
    replyTo: view.replyTo,
  });

export interface TaskListView {
  readonly rows: readonly {
    readonly teamName: string;
    readonly title: string;
    readonly status: TaskStatus;
    readonly dueAt: number;
  }[];
  readonly now: number;
}

const statusIcon = (row: { status: TaskStatus; dueAt: number }, now: number): string =>
  row.status === 'awaiting_approval'
    ? ICON.review
    : row.dueAt < now
      ? ICON.overdue
      : row.status === 'in_progress'
        ? ICON.inProgress
        : ICON.task;

export const renderTaskListCard = (view: TaskListView): CardMessage => {
  const sorted = [...view.rows].sort((x, y) => x.dueAt - y.dueAt);
  const shown = sorted.slice(0, 10);
  const byTeam = new Map<string, typeof shown>();
  for (const row of shown) byTeam.set(row.teamName, [...(byTeam.get(row.teamName) ?? []), row]);
  const children: ContainerChild[] = [
    text(subtext(`${ICON.task} YOUR TASKS · ${view.rows.length} open`)),
  ];
  for (const [teamName, rows] of byTeam)
    children.push(
      text(
        `**${teamText(teamName)}**\n${rows
          .map(
            (r) =>
              `- ${statusIcon(r, view.now)} ${escapeInline(truncate(r.title, 100))} · ${
                r.status === 'awaiting_approval' ? 'waiting for review' : `due ${ts(r.dueAt, 'R')}`
              }`,
          )
          .join('\n')}`,
      ),
    );
  if (sorted.length > 10) children.push(text(`and ${sorted.length - 10} more`));
  children.push(text(subtext('Use /task complete when one is done.')));
  return card({ tone: 'accent', children });
};

export const renderCompletePickerCard = (view: {
  tasks: readonly { taskId: string; title: string; dueLabel: string }[];
}): CardMessage =>
  card({
    tone: 'accent',
    children: [
      text(
        '**Which task is ready for review?**\nA lead (or the president for exec tasks) approves it after you choose.',
      ),
      selectRow(
        stringSelect({
          customId: buildTaskCustomId({ action: 'complete' }),
          placeholder: 'Choose a task',
          options: view.tasks.slice(0, 25).map((t) => ({
            label: truncate(t.title.trim() || 'Task', 100),
            value: t.taskId,
            description: truncate(t.dueLabel, 100),
          })),
        }),
      ),
    ],
  });

/** The Post update form (ADR 0140 decision 7). */
/** Server-enforced caps for the update modal. Discord enforces these on the
 * client via the field's max_length; the daemon and the submit handler check
 * them again so a hand-rolled interaction cannot post an empty or oversized
 * update (P1 phase review P3-1). */
export const TASK_UPDATE_BODY_MAX = 1000;
export const TASK_UPDATE_BLOCKER_MAX = 200;

export const buildUpdateModal = (taskId: string, taskTitle: string | undefined): Modal =>
  modal({
    customId: buildTaskCustomId({ action: 'update', taskId }),
    title: 'Post an update',
    components: [
      ...(taskTitle === undefined ? [] : [text(subtext(escapeInline(truncate(taskTitle, 180))))]),
      label({
        label: 'What did you get done?',
        description: 'Shown on the task card and posted in the channel.',
        component: textInput({
          customId: 'body',
          style: 'paragraph',
          required: true,
          minLength: 3,
          maxLength: TASK_UPDATE_BODY_MAX,
        }),
      }),
      label({
        label: 'Anything blocking you? (optional)',
        component: textInput({
          customId: 'blocker',
          style: 'short',
          required: false,
          maxLength: TASK_UPDATE_BLOCKER_MAX,
          placeholder: 'e.g. waiting on parts',
        }),
      }),
    ],
  });
