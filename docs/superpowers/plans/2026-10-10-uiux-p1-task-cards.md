# P1 — Task cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `2026-10-10-uiux-00-glm-handoff.md` first.

**Goal:** Every task post the bot makes in Discord becomes a Components V2 card, with the task's description,
structured links, banana-saur art and two member buttons (**I'm on it**, **Post update**). Task links are
editable from the dashboard and MCP.

**Architecture:** A pure card kit in `packages/core/src/ui/discord/` builds Discord wire objects. Pure
render functions in `packages/core/src/task/cards.ts` turn view models into cards. The daemon builds view
models from storage, attaches art bytes, and sends. Anchored task cards are refreshed by a reconcile pass
that compares `task_message_anchors.rendered_version` with `club_tasks.version`. The two buttons and the
update modal run through the existing task interaction subscriber.

**Tech Stack:** TypeScript (Node 22, strict), discord.js 14.27 (adapter only), Drizzle + SQLite, Zod,
Vitest, React (dashboard links editor).

**Spec:** `docs/superpowers/specs/2026-10-10-ui-ux-overhaul-design.md`. **Decision record:**
`docs/decisions/0140-discord-cards-components-v2.md`, which overrides the spec where they differ. **Rules:**
`docs/28_UI_UX_GUIDELINES.md`.

## Global Constraints

- `packages/core` imports no new package and never `discord.js` (ADR 0014). No new dependency anywhere in
  P1.
- Components V2 flag: `IS_COMPONENTS_V2 = 1 << 15` (32768). Ephemeral flag: `1 << 6` (64).
- Limits: at most **40 components** per message, nested ones included. At most **4,000 characters**
  across all Text Displays. At most 5 buttons per action row. A section holds 1–3 text displays.
- Button label: at most **34 characters** with an emoji, **38** without. At most one primary button per
  card.
- Task links: at most **5** per task. Label 1–34 characters after trimming. URL must start with
  `https://` and be at most **512** characters.
- Tone accents (`accent_color`): neutral `0x64748B`, accent `0x2F5BD3`, progress `0x3B82F6`, hold
  `0xE0A526`, ok `0x2E9A62`, danger `0xD64545`.
- Every outgoing message sets `allowedMentions` with `parse: []` and lists the exact `users` / `roles` to
  ping. Edits never ping: an edit passes `allowedMentions: { parse: [] }` with no users or roles.
- Text that a member or operator typed (titles, descriptions, updates, team names, link labels) passes
  through `escapeText` or `escapeInline` before it goes into a card.
- Art (`attachment://…`) only on: new-task card, refreshed task card, reminder, weekly check-in, digest.
  Never on private replies, review cards or update cards.
- Copy is verbatim from this plan. Sentence case. No "please", "sorry", "oops", "invalid", "failed to".
- Every new storage function takes `scope: GuildScope` first.

## Review Focus

1. **Hostile text in a task.** A title `@everyone **x**`, a description containing `<@&123456789012345678>`,
   or a 5,000-character description must not ping anyone, must not break the card's Markdown, and must keep
   the card within budget. Pinned by tests in Task 7.
2. **Two clicks at once.** Two members press **I'm on it** on the same card, or one member double-clicks.
   Exactly one status change happens; the other click gets the private "This card was out of date" reply.
   Pinned in Task 9.
3. **An update that can't be saved.** **Post update** is submitted after the task was finished, or by
   someone not on the task. Nothing is recorded, and the private reply quotes the member's text back so it
   isn't lost. Pinned in Task 10.
4. **A card that can't be edited.** The anchored message was deleted, or the bot lost access to the
   channel. The refresh pass stops retrying that card (marks it rendered) and keeps refreshing others.
   Pinned in Task 8.
5. **Task posts switched off** (planning mode, ADR 0131). The refresh pass and the `update` slot make no
   Discord call. Slots settle `planned`, as every other kind does. Pinned in Tasks 8 and 10.

---

## File structure

New files:

| File | Responsibility |
| --- | --- |
| `packages/core/src/ui/discord/kit.ts` | V2 + modal wire types and constructors |
| `packages/core/src/ui/discord/tokens.ts` | tone → accent colour; the emoji vocabulary |
| `packages/core/src/ui/discord/text.ts` | escaping, truncation, timestamps, mentions |
| `packages/core/src/ui/discord/budget.ts` | component and text counting; limit assertion |
| `packages/core/src/ui/discord/art.ts` | art registry (keys → file names, alt text) |
| `packages/core/src/ui/discord/card.ts` | `CardMessage`, `card()`, `toOutgoingMessage()` |
| `packages/core/src/ui/discord/common-cards.ts` | private result and error cards |
| `packages/core/src/ui/discord/index.ts` | re-exports for the kit |
| `packages/core/src/copy/errors.ts` | the error catalogue (task entries in P1; P2 extends) |
| `packages/core/src/task/links.ts` | `taskLinksSchema` (shared Zod schema) |
| `packages/core/src/task/cards.ts` | every task card render function |
| `apps/daemon/src/cards/art.ts` | loads the PNG bytes once; `artLoader` |
| `apps/daemon/src/cards/task-view.ts` | builds `TaskCardView` from storage |
| `apps/daemon/src/jobs/task-cards.ts` | the card refresh reconcile pass |
| `scripts/card-gallery.mjs` | owner-run smoke: posts every card variant to the test guild |

Each new `.ts` file gets a sibling `.test.ts`.

---

### Task 1: The card kit

**Files:**
- Create: `packages/core/src/ui/discord/kit.ts`, `tokens.ts`, `text.ts`, `budget.ts`, `art.ts`, `card.ts`,
  `index.ts`
- Create: `packages/core/src/ui/discord/kit.test.ts`, `text.test.ts`, `budget.test.ts`, `card.test.ts`
- Modify: `packages/core/src/index.ts` (add `export * from './ui/discord/index.js';`)

**Interfaces:**
- Produces (used by every later task): everything exported from `packages/core/src/ui/discord/index.ts`
  as written below. `card()` and `toOutgoingMessage()` are the two entry points render functions and
  senders use.
- Consumes: `OutgoingMessage` and `OutgoingFile` from `packages/core/src/discord/port.ts`. `OutgoingFile`
  is added in Task 2, so in this task `card.ts` declares nothing about files yet. `toOutgoingMessage` is
  added in Task 2, step 6.

- [ ] **Step 1: Write the failing kit tests**

`packages/core/src/ui/discord/kit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  actionRow,
  button,
  container,
  gallery,
  label,
  linkButton,
  modal,
  radioGroup,
  section,
  separator,
  text,
  textInput,
  thumbnail,
} from './kit.js';

describe('card kit constructors', () => {
  it('builds a text display', () => {
    expect(text('hi')).toEqual({ type: 10, content: 'hi' });
  });

  it('builds a section with a thumbnail accessory', () => {
    expect(section([text('a')], thumbnail('attachment://x.png', 'alt'))).toEqual({
      type: 9,
      components: [{ type: 10, content: 'a' }],
      accessory: { type: 11, media: { url: 'attachment://x.png' }, description: 'alt' },
    });
  });

  it('refuses a section with no text or more than three', () => {
    expect(() => section([], thumbnail('attachment://x.png'))).toThrow(RangeError);
    expect(() =>
      section([text('1'), text('2'), text('3'), text('4')], thumbnail('attachment://x.png')),
    ).toThrow(RangeError);
  });

  it('maps button styles to Discord numbers and omits absent options', () => {
    expect(button({ customId: 'a', label: 'Go', style: 'primary' })).toEqual({
      type: 2,
      style: 1,
      custom_id: 'a',
      label: 'Go',
    });
    expect(button({ customId: 'b', label: 'X', style: 'danger', emoji: '🗑️' })).toEqual({
      type: 2,
      style: 4,
      custom_id: 'b',
      label: 'X',
      emoji: { name: '🗑️' },
    });
    expect(button({ customId: 'c', label: 'Y' }).style).toBe(2);
    expect(button({ customId: 'd', label: 'Z', style: 'success' }).style).toBe(3);
  });

  it('builds a link button with style 5 and no custom id', () => {
    expect(linkButton({ url: 'https://example.com', label: 'Docs' })).toEqual({
      type: 2,
      style: 5,
      url: 'https://example.com',
      label: 'Docs',
    });
  });

  it('refuses an empty or oversized action row', () => {
    expect(() => actionRow([])).toThrow(RangeError);
    const six = Array.from({ length: 6 }, (_, i) => button({ customId: `b${i}`, label: 'x' }));
    expect(() => actionRow(six)).toThrow(RangeError);
  });

  it('builds separators with small spacing and a divider by default', () => {
    expect(separator()).toEqual({ type: 14, divider: true, spacing: 1 });
    expect(separator({ divider: false, spacing: 'large' })).toEqual({
      type: 14,
      divider: false,
      spacing: 2,
    });
  });

  it('builds a media gallery of 1 to 10 items', () => {
    expect(gallery([{ media: { url: 'attachment://b.png' }, description: 'd' }])).toEqual({
      type: 12,
      items: [{ media: { url: 'attachment://b.png' }, description: 'd' }],
    });
    expect(() => gallery([])).toThrow(RangeError);
  });

  it('builds a container with an accent colour', () => {
    expect(container({ accent: 0x2f5bd3, children: [text('x')] })).toEqual({
      type: 17,
      accent_color: 0x2f5bd3,
      components: [{ type: 10, content: 'x' }],
    });
  });

  it('builds a modal of labelled inputs and truncates the title to 45 characters', () => {
    const m = modal({
      customId: 'bs.task:update:x',
      title: 'A'.repeat(60),
      components: [
        label({
          label: 'What did you get done?',
          description: 'Shown on the task card.',
          component: textInput({
            customId: 'body',
            style: 'paragraph',
            required: true,
            minLength: 3,
            maxLength: 1000,
          }),
        }),
        label({
          label: 'How long?',
          component: radioGroup({
            customId: 'duration',
            required: true,
            options: [
              { value: '10m', label: '10 minutes' },
              { value: '1h', label: '1 hour', default: true },
            ],
          }),
        }),
      ],
    });
    expect(m.title).toHaveLength(45);
    expect(m.title.endsWith('…')).toBe(true);
    expect(m.components[0]).toEqual({
      type: 18,
      label: 'What did you get done?',
      description: 'Shown on the task card.',
      component: {
        type: 4,
        custom_id: 'body',
        style: 2,
        required: true,
        min_length: 3,
        max_length: 1000,
      },
    });
    expect(m.components[1]).toEqual({
      type: 18,
      label: 'How long?',
      component: {
        type: 21,
        custom_id: 'duration',
        required: true,
        options: [
          { value: '10m', label: '10 minutes' },
          { value: '1h', label: '1 hour', default: true },
        ],
      },
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/core/src/ui/discord/kit.test.ts`
Expected: FAIL, `Cannot find module './kit.js'` (or equivalent).

- [ ] **Step 3: Write `kit.ts`**

```ts
/**
 * Components V2 and modal wire shapes (ADR 0140).
 *
 * `core` may not import discord.js (ADR 0014), and this kit deliberately does
 * not take `discord-api-types` either: these are the ~15 shapes the project
 * uses, written with Discord's numeric `type` literals, the same style
 * `task/components.ts` already uses. Constructors only — no behaviour, no I/O.
 */

export const IS_COMPONENTS_V2 = 1 << 15;
export const EPHEMERAL_FLAG = 1 << 6;

export type ButtonStyleName = 'primary' | 'secondary' | 'success' | 'danger';
const BUTTON_STYLE: Readonly<Record<ButtonStyleName, 1 | 2 | 3 | 4>> = {
  primary: 1,
  secondary: 2,
  success: 3,
  danger: 4,
};

export interface TextDisplay {
  readonly type: 10;
  readonly content: string;
}
export interface MediaRef {
  readonly url: string;
}
export interface Thumbnail {
  readonly type: 11;
  readonly media: MediaRef;
  readonly description?: string;
}
export interface Button {
  readonly type: 2;
  readonly style: 1 | 2 | 3 | 4;
  readonly custom_id: string;
  readonly label: string;
  readonly emoji?: { readonly name: string };
  readonly disabled?: boolean;
}
export interface LinkButton {
  readonly type: 2;
  readonly style: 5;
  readonly url: string;
  readonly label: string;
}
export interface SelectOption {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
  readonly emoji?: { readonly name: string };
  readonly default?: boolean;
}
export interface StringSelect {
  readonly type: 3;
  readonly custom_id: string;
  readonly placeholder?: string;
  readonly min_values?: number;
  readonly max_values?: number;
  readonly options: readonly SelectOption[];
}
export interface ActionRow {
  readonly type: 1;
  readonly components: readonly (Button | LinkButton | StringSelect)[];
}
export interface Section {
  readonly type: 9;
  readonly components: readonly TextDisplay[];
  readonly accessory: Thumbnail | Button | LinkButton;
}
export interface Separator {
  readonly type: 14;
  readonly divider: boolean;
  readonly spacing: 1 | 2;
}
export interface GalleryItem {
  readonly media: MediaRef;
  readonly description?: string;
}
export interface MediaGallery {
  readonly type: 12;
  readonly items: readonly GalleryItem[];
}
export type ContainerChild = TextDisplay | Section | Separator | MediaGallery | ActionRow;
export interface Container {
  readonly type: 17;
  readonly accent_color: number;
  readonly components: readonly ContainerChild[];
}
export type TopLevelComponent = Container | ContainerChild;

export const text = (content: string): TextDisplay => ({ type: 10, content });

export const thumbnail = (url: string, description?: string): Thumbnail =>
  description === undefined
    ? { type: 11, media: { url } }
    : { type: 11, media: { url }, description };

export const section = (
  texts: readonly TextDisplay[],
  accessory: Section['accessory'],
): Section => {
  if (texts.length < 1 || texts.length > 3)
    throw new RangeError('a section holds 1 to 3 text displays');
  return { type: 9, components: texts, accessory };
};

export const separator = (
  options: { divider?: boolean; spacing?: 'small' | 'large' } = {},
): Separator => ({
  type: 14,
  divider: options.divider ?? true,
  spacing: options.spacing === 'large' ? 2 : 1,
});

export const gallery = (items: readonly GalleryItem[]): MediaGallery => {
  if (items.length < 1 || items.length > 10)
    throw new RangeError('a media gallery holds 1 to 10 items');
  return { type: 12, items };
};

export const button = (options: {
  customId: string;
  label: string;
  style?: ButtonStyleName;
  emoji?: string;
  disabled?: boolean;
}): Button => ({
  type: 2,
  style: BUTTON_STYLE[options.style ?? 'secondary'],
  custom_id: options.customId,
  label: options.label,
  ...(options.emoji === undefined ? {} : { emoji: { name: options.emoji } }),
  ...(options.disabled === true ? { disabled: true } : {}),
});

export const linkButton = (options: { url: string; label: string }): LinkButton => ({
  type: 2,
  style: 5,
  url: options.url,
  label: options.label,
});

export const actionRow = (buttons: readonly (Button | LinkButton)[]): ActionRow => {
  if (buttons.length < 1 || buttons.length > 5)
    throw new RangeError('an action row holds 1 to 5 buttons');
  return { type: 1, components: buttons };
};

export const stringSelect = (options: {
  customId: string;
  placeholder?: string;
  minValues?: number;
  maxValues?: number;
  options: readonly SelectOption[];
}): StringSelect => {
  if (options.options.length < 1 || options.options.length > 25)
    throw new RangeError('a select holds 1 to 25 options');
  return {
    type: 3,
    custom_id: options.customId,
    ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
    ...(options.minValues === undefined ? {} : { min_values: options.minValues }),
    ...(options.maxValues === undefined ? {} : { max_values: options.maxValues }),
    options: options.options,
  };
};

export const selectRow = (select: StringSelect): ActionRow => ({ type: 1, components: [select] });

export const container = (options: {
  accent: number;
  children: readonly ContainerChild[];
}): Container => ({ type: 17, accent_color: options.accent, components: options.children });

// --- modals ------------------------------------------------------------------

export interface TextInput {
  readonly type: 4;
  readonly custom_id: string;
  readonly style: 1 | 2;
  readonly required: boolean;
  readonly min_length?: number;
  readonly max_length?: number;
  readonly placeholder?: string;
  readonly value?: string;
}
export interface RadioOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly default?: boolean;
}
export interface RadioGroup {
  readonly type: 21;
  readonly custom_id: string;
  readonly required: boolean;
  readonly options: readonly RadioOption[];
}
export interface Label {
  readonly type: 18;
  readonly label: string;
  readonly description?: string;
  readonly component: TextInput | RadioGroup;
}
export interface Modal {
  readonly custom_id: string;
  readonly title: string;
  readonly components: readonly (Label | TextDisplay)[];
}

export const textInput = (options: {
  customId: string;
  style: 'short' | 'paragraph';
  required: boolean;
  minLength?: number;
  maxLength?: number;
  placeholder?: string;
  value?: string;
}): TextInput => ({
  type: 4,
  custom_id: options.customId,
  style: options.style === 'paragraph' ? 2 : 1,
  required: options.required,
  ...(options.minLength === undefined ? {} : { min_length: options.minLength }),
  ...(options.maxLength === undefined ? {} : { max_length: options.maxLength }),
  ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
  ...(options.value === undefined ? {} : { value: options.value }),
});

export const radioGroup = (options: {
  customId: string;
  required: boolean;
  options: readonly RadioOption[];
}): RadioGroup => ({
  type: 21,
  custom_id: options.customId,
  required: options.required,
  options: options.options,
});

export const label = (options: {
  label: string;
  description?: string;
  component: TextInput | RadioGroup;
}): Label => ({
  type: 18,
  label: options.label.slice(0, 45),
  ...(options.description === undefined
    ? {}
    : { description: options.description.slice(0, 100) }),
  component: options.component,
});

export const modal = (options: {
  customId: string;
  title: string;
  components: readonly (Label | TextDisplay)[];
}): Modal => ({
  custom_id: options.customId,
  title: options.title.length <= 45 ? options.title : `${options.title.slice(0, 44)}…`,
  components: options.components,
});
```

- [ ] **Step 4: Run the kit test to verify it passes**

Run: `npx vitest run packages/core/src/ui/discord/kit.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing text-helper tests**

`packages/core/src/ui/discord/text.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  clampLines,
  escapeInline,
  escapeText,
  jumpUrl,
  mentionChannel,
  mentionRole,
  mentionUser,
  subtext,
  truncate,
  ts,
} from './text.js';

describe('escapeText', () => {
  it('neutralises mentions so they can never ping or render', () => {
    expect(escapeText('@everyone hi')).toBe('@​everyone hi');
    expect(escapeText('<@&123456789012345678>')).toBe('<​@​&123456789012345678>');
  });

  it('escapes inline Markdown characters', () => {
    expect(escapeText('**bold** _it_ ~x~ `c` |s|')).toBe(
      '\\*\\*bold\\*\\* \\_it\\_ \\~x\\~ \\`c\\` \\|s\\|',
    );
  });

  it('escapes masked-link brackets but not parentheses', () => {
    expect(escapeText('[a](https://x.example)')).toBe('\\[a\\](https://x.example)');
  });

  it('escapes block markers only at the start of a line', () => {
    expect(escapeText('# h\n> q\n- l\n-# s\nmid # and > and -')).toBe(
      '\\# h\n\\> q\n\\- l\n\\-# s\nmid # and > and -',
    );
  });

  it('normalises CRLF line endings', () => {
    expect(escapeText('a\r\nb\rc')).toBe('a\nb\nc');
  });
});

describe('escapeInline', () => {
  it('collapses all whitespace, including newlines, to single spaces', () => {
    expect(escapeInline('  a\n\nb\t c  ')).toBe('a b c');
  });
  it('escapes like escapeText after collapsing', () => {
    expect(escapeInline('# title')).toBe('\\# title');
  });
});

describe('truncate and clampLines', () => {
  it('leaves short text alone and cuts long text with an ellipsis within the limit', () => {
    expect(truncate('abc', 5)).toBe('abc');
    const cut = truncate('abcdefghij', 5);
    expect(cut).toBe('abcd…');
    expect(cut.length).toBe(5);
  });
  it('keeps at most n lines and marks the cut', () => {
    expect(clampLines('1\n2\n3', 3)).toBe('1\n2\n3');
    expect(clampLines('1\n2\n3\n4', 2)).toBe('1\n2\n…');
  });
});

describe('Discord syntax helpers', () => {
  it('formats timestamps in seconds with a style', () => {
    expect(ts(1_700_000_000_999, 'R')).toBe('<t:1700000000:R>');
    expect(ts(1_700_000_000_000)).toBe('<t:1700000000:f>');
  });
  it('formats mentions, subtext and jump links', () => {
    expect(mentionUser('1')).toBe('<@1>');
    expect(mentionRole('2')).toBe('<@&2>');
    expect(mentionChannel('3')).toBe('<#3>');
    expect(subtext('x')).toBe('-# x');
    expect(jumpUrl('g', 'c', 'm')).toBe('https://discord.com/channels/g/c/m');
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run packages/core/src/ui/discord/text.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 7: Write `text.ts`**

```ts
/**
 * Text helpers for cards. **Truncate raw text first, then escape it** —
 * escaping adds characters, and cutting an escaped string can leave a
 * dangling backslash.
 */

const INLINE_MARKDOWN = /([\\*_~`|[\]])/g;
const LINE_START_BLOCK = /^([#>-])/gm;

/** Neutralise Markdown and mention syntax in text a member or operator typed. Keeps newlines. */
export const escapeText = (raw: string): string =>
  raw
    .replace(/\r\n?/g, '\n')
    .replace(INLINE_MARKDOWN, '\\$1')
    .replace(LINE_START_BLOCK, '\\$1')
    .replace(/@/g, '@​')
    .replace(/</g, '<​');

/** `escapeText` for a single line: every run of whitespace becomes one space. */
export const escapeInline = (raw: string): string => escapeText(raw.replace(/\s+/g, ' ').trim());

/** At most `max` characters, ending in `…` when cut. */
export const truncate = (raw: string, max: number): string =>
  raw.length <= max ? raw : `${raw.slice(0, Math.max(0, max - 1)).trimEnd()}…`;

/** At most `maxLines` lines; a cut ends with a line holding only `…`. */
export const clampLines = (raw: string, maxLines: number): string => {
  const lines = raw.split('\n');
  return lines.length <= maxLines ? raw : `${lines.slice(0, maxLines).join('\n')}\n…`;
};

export type TimestampStyle = 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R';
/** A Discord timestamp: each reader sees it in their own time zone. */
export const ts = (ms: number, style: TimestampStyle = 'f'): string =>
  `<t:${Math.floor(ms / 1000)}:${style}>`;

export const mentionUser = (id: string): string => `<@${id}>`;
export const mentionRole = (id: string): string => `<@&${id}>`;
export const mentionChannel = (id: string): string => `<#${id}>`;
export const subtext = (line: string): string => `-# ${line}`;
export const jumpUrl = (guildId: string, channelId: string, messageId: string): string =>
  `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npx vitest run packages/core/src/ui/discord/text.test.ts`
Expected: PASS. If the block-marker test fails because `\-#` is produced as `\-\#`, check that
`INLINE_MARKDOWN` does not include `#`, `>` or `-`: those are escaped only at line starts.

- [ ] **Step 9: Write tokens, art, budget and their test**

`packages/core/src/ui/discord/tokens.ts`:

```ts
/** The six tones (docs/28 §4). Each means one thing on Discord and in the dashboard. */
export type Tone = 'neutral' | 'accent' | 'progress' | 'hold' | 'ok' | 'danger';

export const TONE_ACCENT: Readonly<Record<Tone, number>> = {
  neutral: 0x64748b,
  accent: 0x2f5bd3,
  progress: 0x3b82f6,
  hold: 0xe0a526,
  ok: 0x2e9a62,
  danger: 0xd64545,
};

/** The emoji vocabulary (docs/28 §5.1). Add a concept here, never inline in a renderer. */
export const ICON = {
  task: '📋',
  due: '⏰',
  overdue: '⚠️',
  inProgress: '🔧',
  review: '👀',
  done: '✅',
  sentBack: '↩️',
  update: '📝',
  link: '🔗',
  digest: '🗓️',
  joined: '👋',
  left: '🚪',
  edited: '✏️',
  deleted: '🗑️',
  roles: '🏷️',
  automod: '🛡️',
  warned: '📣',
  timeout: '⏸️',
  ban: '🔨',
  kick: '👢',
  error: '❌',
  hint: '💡',
  stop: '✋',
  checkin: '👋',
} as const;
export type IconName = keyof typeof ICON;
```

`packages/core/src/ui/discord/art.ts`:

```ts
/**
 * Card art (ADR 0140 decision 4). The bytes live in
 * `apps/daemon/assets/cards/` and are attached to each message that uses
 * them; a card names art by key and links it as `attachment://<file>`.
 */
export const ART = {
  saurThumb: { file: 'saur-thumb.png', alt: 'The Bananasaurs banana-saur' },
  bannerTasks: {
    file: 'banner-tasks.png',
    alt: 'The banana-saur beside banana leaves on a warm yellow background',
  },
  bannerDigest: {
    file: 'banner-digest.png',
    alt: 'The banana-saur beside banana leaves on a soft green background',
  },
  bannerPanel: {
    file: 'banner-panel.png',
    alt: 'The banana-saur beside banana leaves on a navy background',
  },
} as const;
export type ArtKey = keyof typeof ART;

export const artUrl = (key: ArtKey): string => `attachment://${ART[key].file}`;
```

`packages/core/src/ui/discord/budget.ts`:

```ts
/** Discord's hard limits for a Components V2 message (ADR 0140). */
export const MAX_COMPONENTS = 40;
export const MAX_TEXT_CHARS = 4000;

export class CardBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardBudgetError';
  }
}

const isComponent = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'number';

const walk = (value: unknown, visit: (c: Record<string, unknown>) => void): void => {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (!isComponent(value)) return;
  visit(value);
  walk(value['components'], visit);
  walk(value['accessory'], visit);
  walk(value['component'], visit);
};

/** Every object with a numeric `type`, nested ones included — Discord counts them all. */
export const countComponents = (components: readonly unknown[]): number => {
  let n = 0;
  walk(components, () => {
    n += 1;
  });
  return n;
};

/** Characters across every Text Display (type 10). */
export const countText = (components: readonly unknown[]): number => {
  let n = 0;
  walk(components, (c) => {
    if (c['type'] === 10 && typeof c['content'] === 'string') n += c['content'].length;
  });
  return n;
};

export const assertWithinBudget = (components: readonly unknown[]): void => {
  const count = countComponents(components);
  if (count > MAX_COMPONENTS)
    throw new CardBudgetError(`card has ${count} components; Discord allows ${MAX_COMPONENTS}`);
  const chars = countText(components);
  if (chars > MAX_TEXT_CHARS)
    throw new CardBudgetError(`card has ${chars} text characters; Discord allows ${MAX_TEXT_CHARS}`);
};
```

`packages/core/src/ui/discord/budget.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assertWithinBudget, CardBudgetError, countComponents, countText } from './budget.js';
import { actionRow, button, container, section, text, thumbnail } from './kit.js';

describe('card budget', () => {
  it('counts nested components, including accessories', () => {
    const c = [
      container({
        accent: 1,
        children: [
          section([text('a'), text('b')], thumbnail('attachment://t.png')),
          actionRow([button({ customId: 'x', label: 'x' })]),
        ],
      }),
    ];
    // container, section, 2 texts, thumbnail, row, button
    expect(countComponents(c)).toBe(7);
    expect(countText(c)).toBe(2);
  });

  it('throws when a card exceeds 40 components', () => {
    const many = Array.from({ length: 40 }, (_, i) => text(String(i)));
    expect(() => assertWithinBudget([container({ accent: 1, children: many })])).toThrow(
      CardBudgetError,
    );
  });

  it('throws when text exceeds 4,000 characters', () => {
    expect(() => assertWithinBudget([text('x'.repeat(4001))])).toThrow(CardBudgetError);
    expect(() => assertWithinBudget([text('x'.repeat(4000))])).not.toThrow();
  });
});
```

- [ ] **Step 10: Write `card.ts`, `index.ts` and the card test**

`packages/core/src/ui/discord/card.ts`:

```ts
import type { ArtKey } from './art.js';
import { assertWithinBudget } from './budget.js';
import { container, type ContainerChild, type TopLevelComponent } from './kit.js';
import { TONE_ACCENT, type Tone } from './tokens.js';

/**
 * A card before art bytes are attached: what render functions return.
 * `toOutgoingMessage` (Task 2) turns it into a port `OutgoingMessage`.
 */
export interface CardMessage {
  readonly components: readonly TopLevelComponent[];
  /** Art the sender must attach; each is referenced as `attachment://<file>`. */
  readonly art: readonly ArtKey[];
  readonly allowedMentions: {
    readonly parse: readonly [];
    readonly users?: readonly string[];
    readonly roles?: readonly string[];
  };
  readonly replyTo?: string;
}

export const card = (options: {
  tone: Tone;
  children: readonly ContainerChild[];
  art?: readonly ArtKey[];
  pingUsers?: readonly string[];
  pingRoles?: readonly string[];
  replyTo?: string;
}): CardMessage => {
  const components = [container({ accent: TONE_ACCENT[options.tone], children: options.children })];
  assertWithinBudget(components);
  const users = options.pingUsers ?? [];
  const roles = options.pingRoles ?? [];
  return {
    components,
    art: [...new Set(options.art ?? [])],
    allowedMentions: {
      parse: [] as const,
      ...(users.length > 0 ? { users: [...new Set(users)] } : {}),
      ...(roles.length > 0 ? { roles: [...new Set(roles)] } : {}),
    },
    ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
  };
};
```

`packages/core/src/ui/discord/index.ts`:

```ts
export * from './art.js';
export * from './budget.js';
export * from './card.js';
export * from './kit.js';
export * from './text.js';
export * from './tokens.js';
```

`packages/core/src/ui/discord/card.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { card } from './card.js';
import { CardBudgetError } from './budget.js';
import { text } from './kit.js';

describe('card()', () => {
  it('wraps children in one toned container and never parses mentions', () => {
    const c = card({ tone: 'ok', children: [text('done')] });
    expect(c.components).toEqual([
      { type: 17, accent_color: 0x2e9a62, components: [{ type: 10, content: 'done' }] },
    ]);
    expect(c.allowedMentions).toEqual({ parse: [] });
    expect(c.art).toEqual([]);
  });

  it('lists only the pings it was given, de-duplicated', () => {
    const c = card({
      tone: 'accent',
      children: [text('x')],
      pingUsers: ['1', '1', '2'],
      pingRoles: ['3'],
    });
    expect(c.allowedMentions).toEqual({ parse: [], users: ['1', '2'], roles: ['3'] });
  });

  it('de-duplicates art and keeps replyTo', () => {
    const c = card({
      tone: 'neutral',
      children: [text('x')],
      art: ['saurThumb', 'saurThumb'],
      replyTo: '9',
    });
    expect(c.art).toEqual(['saurThumb']);
    expect(c.replyTo).toBe('9');
  });

  it('refuses a card over budget', () => {
    expect(() => card({ tone: 'neutral', children: [text('x'.repeat(4001))] })).toThrow(
      CardBudgetError,
    );
  });
});
```

Add to `packages/core/src/index.ts`, at the end:

```ts
export * from './ui/discord/index.js';
```

- [ ] **Step 11: Run the kit's tests**

Run: `npx vitest run packages/core/src/ui/discord`
Expected: PASS (all four files).

- [ ] **Step 12: Run the gates**

```bash
npm run typecheck
npm run lint
npm run test
```

Expected: all PASS. If `export *` causes a name clash in `packages/core/src/index.ts` (for example an
existing export named `text` or `button`), replace the line with an explicit named export list of the
kit's symbols, and record the deviation.

- [ ] **Step 13: Commit**

```bash
git add packages/core/src/ui packages/core/src/index.ts
git commit -m "P1 Task 1: Components V2 card kit (kit, tokens, text, budget, art, card)"
```

---

### Task 2: Port, events and the fake

**Files:**
- Modify: `packages/core/src/discord/port.ts` (`OutgoingFile`, `OutgoingMessage.flags/files`,
  `DiscordPort.deferUpdate/showModal`)
- Modify: `packages/core/src/discord/events.ts` (`ModalSubmitEvent`, add to `DomainEvent`)
- Modify: `packages/core/src/pipeline/fingerprint.ts` (case `'modalSubmit'`)
- Modify: `packages/core/src/ops/commands/slash-responder.ts` (add `deferUpdate`, `showModal`)
- Modify: `packages/core/src/ui/discord/card.ts` (add `toOutgoingMessage`)
- Modify: `packages/testkit/src/fake-discord.ts` (implement the two methods; `emitModalSubmit`,
  `modalsShown`, `wasUpdateDeferred`)
- Modify: `packages/core/src/effects/message-gateway.test.ts`,
  `packages/core/src/effects/moderation-gateway.test.ts` (their local `DiscordPort` fakes gain the two
  methods, each throwing `new Error('not used')`)
- Test: `packages/core/src/ui/discord/card.test.ts`, `packages/core/src/pipeline/fingerprint.test.ts`,
  `packages/testkit/src/fake-discord.test.ts` (create the last if it does not exist)

**Interfaces:**
- Produces:
  - `interface OutgoingFile { readonly name: string; readonly contentType: string; readonly data: Uint8Array; readonly description?: string }`
  - `OutgoingMessage.flags?: number`, `OutgoingMessage.files?: readonly OutgoingFile[]`
  - `DiscordPort.deferUpdate(guildId: Snowflake, ref: InteractionRef): Promise<void>`
  - `DiscordPort.showModal(guildId: Snowflake, ref: InteractionRef, modal: Modal): Promise<void>`
  - `interface ModalSubmitEvent` (below), part of `DomainEvent`
  - `SlashResponder.deferUpdate(ref)`, `SlashResponder.showModal(ref, modal)`
  - `toOutgoingMessage(card: CardMessage, loadArt?: (key: ArtKey) => OutgoingFile): OutgoingMessage`
  - `FakeDiscord.emitModalSubmit(p)`, `FakeDiscord.modalsShown(interactionId): readonly Modal[]`,
    `FakeDiscord.wasUpdateDeferred(interactionId): boolean`
- Consumes: `Modal`, `CardMessage`, `ArtKey`, `ART`, `IS_COMPONENTS_V2` from Task 1.

- [ ] **Step 1: Write the failing `toOutgoingMessage` test** (append to `card.test.ts`)

```ts
import { toOutgoingMessage } from './card.js';
import type { OutgoingFile } from '../../discord/port.js';

describe('toOutgoingMessage', () => {
  const thumb: OutgoingFile = {
    name: 'saur-thumb.png',
    contentType: 'image/png',
    data: new Uint8Array([1, 2, 3]),
    description: 'The Bananasaurs banana-saur',
  };

  it('sets the V2 flag and copies components, mentions and replyTo', () => {
    const out = toOutgoingMessage(
      card({ tone: 'neutral', children: [text('x')], pingUsers: ['1'], replyTo: '9' }),
    );
    expect(out.flags).toBe(1 << 15);
    expect(out.components).toHaveLength(1);
    expect(out.allowedMentions).toEqual({ parse: [], users: ['1'] });
    expect(out.replyTo).toBe('9');
    expect(out.files).toBeUndefined();
    expect(out.content).toBeUndefined();
  });

  it('attaches art through the loader', () => {
    const out = toOutgoingMessage(
      card({ tone: 'accent', children: [text('x')], art: ['saurThumb'] }),
      () => thumb,
    );
    expect(out.files).toEqual([thumb]);
  });

  it('throws when a card needs art and no loader was given', () => {
    expect(() =>
      toOutgoingMessage(card({ tone: 'accent', children: [text('x')], art: ['saurThumb'] })),
    ).toThrow(/art/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/core/src/ui/discord/card.test.ts`
Expected: FAIL (`toOutgoingMessage` is not exported; `OutgoingFile` is not exported).

- [ ] **Step 3: Extend the port**

In `packages/core/src/discord/port.ts`:

1. Add before `export interface OutgoingMessage`:

```ts
/**
 * A file uploaded with a message (ADR 0140). Card art is the only user today:
 * referenced from a component as `attachment://<name>`.
 */
export interface OutgoingFile {
  readonly name: string;
  readonly contentType: string;
  readonly data: Uint8Array;
  /** Alt text Discord shows to screen readers. */
  readonly description?: string;
}
```

2. Add inside `OutgoingMessage`, after `poll`:

```ts
  /**
   * Message flags (ADR 0140). Only `IS_COMPONENTS_V2` is set by callers; the
   * adapter ORs in the ephemeral bit for private interaction follow-ups.
   * Absent, the wire output is byte-identical to a message without flags.
   */
  flags?: number | undefined;
  /** Files to upload with the message. Absent: no multipart, byte-identical to today. */
  files?: readonly OutgoingFile[] | undefined;
```

3. Add `import type { Modal } from '../ui/discord/kit.js';` at the top, and inside `DiscordPort` after
`respondToInteraction`:

```ts
  /**
   * Acknowledges a component interaction without a visible reply (callback
   * type 6). The message the button sits on is then edited with
   * `editMessage`, and any follow-up through `respondToInteraction` is
   * private to the member who clicked (ADR 0140).
   */
  deferUpdate(guildId: Snowflake, ref: InteractionRef): Promise<void>;

  /**
   * Answers an interaction with a modal (callback type 9). Must be the
   * **first** response: it cannot follow a defer.
   */
  showModal(guildId: Snowflake, ref: InteractionRef, modal: Modal): Promise<void>;
```

- [ ] **Step 4: Add the modal-submit event**

In `packages/core/src/discord/events.ts`, after `SlashCommandEvent`:

```ts
/**
 * A submitted modal (ADR 0140). Addressed by its own interaction id and
 * token, like a button click. `fields` holds every text input and every
 * radio group with a choice, keyed by custom id — the member's own words, so
 * never logged (it is not in `LOGGABLE_FIELDS`).
 */
export interface ModalSubmitEvent extends Base {
  kind: 'modalSubmit';
  interactionId: Snowflake;
  token: string;
  channelId: Snowflake;
  /** The message whose button opened the modal; absent for a slash-opened modal. */
  messageId: Snowflake | undefined;
  userId: Snowflake;
  customId: string;
  fields: Readonly<Record<string, string>>;
}
```

Add `| ModalSubmitEvent` to the `DomainEvent` union.

In `packages/core/src/pipeline/fingerprint.ts`, extend the first case group:

```ts
    case 'interaction':
    case 'slashCommand':
    case 'modalSubmit':
      return event.interactionId;
```

Add a test to `packages/core/src/pipeline/fingerprint.test.ts`:

```ts
it('identifies a modal submit by its interaction id', () => {
  expect(
    fingerprintOf({
      kind: 'modalSubmit',
      guildId: '111111111111111111',
      receivedAtMs: 1,
      interactionId: '777777777777777777',
      token: 't',
      channelId: '444444444444444444',
      messageId: undefined,
      userId: '333333333333333333',
      customId: 'bs.task:update:x',
      fields: { body: 'hi' },
    }),
  ).toBe('777777777777777777');
});
```

Run `npm run typecheck`. Every other `switch (event.kind)` that the compiler now reports as
non-exhaustive gets a `case 'modalSubmit':` treated exactly like `case 'interaction':` in that switch. List
every file you touched for this in the commit message.

- [ ] **Step 5: Extend the responder**

`packages/core/src/ops/commands/slash-responder.ts`:

```ts
import type { InteractionRef, OutgoingMessage } from '../../discord/port.js';
import type { Modal } from '../../ui/discord/kit.js';

export interface SlashResponder {
  defer(ref: InteractionRef, options: { ephemeral: boolean }): Promise<void>;
  respond(ref: InteractionRef, message: OutgoingMessage): Promise<void>;
  /** Callback type 6: acknowledge a button without a visible reply. */
  deferUpdate(ref: InteractionRef): Promise<void>;
  /** Callback type 9: the first and only response. */
  showModal(ref: InteractionRef, modal: Modal): Promise<void>;
}
```

Fix every place that builds a `SlashResponder` (`rg -n "respond: async" apps packages`). Each wiring gets:

```ts
deferUpdate: (ref) => discord.deferUpdate(guildId, ref),
showModal: (ref, modal) => discord.showModal(guildId, ref, modal),
```

and each test harness gets `deferUpdate: vi.fn(async () => undefined), showModal: vi.fn(async () => undefined)`.

- [ ] **Step 6: Implement `toOutgoingMessage`** (append to `packages/core/src/ui/discord/card.ts`)

```ts
import type { OutgoingFile, OutgoingMessage } from '../../discord/port.js';
import { IS_COMPONENTS_V2 } from './kit.js';

/**
 * The port message for a card. `loadArt` supplies the bytes for each art
 * key; a card with art and no loader is a programming error, so it throws.
 */
export const toOutgoingMessage = (
  message: CardMessage,
  loadArt?: (key: ArtKey) => OutgoingFile,
): OutgoingMessage => {
  if (message.art.length > 0 && loadArt === undefined)
    throw new Error(`card needs art (${message.art.join(', ')}) but no art loader was given`);
  const files = loadArt === undefined ? [] : message.art.map((key) => loadArt(key));
  return {
    components: message.components,
    flags: IS_COMPONENTS_V2,
    allowedMentions: {
      parse: [],
      ...(message.allowedMentions.users === undefined
        ? {}
        : { users: [...message.allowedMentions.users] }),
      ...(message.allowedMentions.roles === undefined
        ? {}
        : { roles: [...message.allowedMentions.roles] }),
    },
    ...(files.length > 0 ? { files } : {}),
    ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
  };
};
```

Run: `npx vitest run packages/core/src/ui/discord/card.test.ts` and expect PASS.

- [ ] **Step 7: Teach `FakeDiscord` the new methods**

In `packages/testkit/src/fake-discord.ts`:

1. Add to the private `FakeInteraction` state type: `updateDeferred: boolean; modals: Modal[];`. Initialise
   both in `registerInteraction` (`updateDeferred: false, modals: []`).
2. Implement, next to `deferInteraction`:

```ts
  async deferUpdate(guildId: Snowflake, ref: InteractionRef): Promise<void> {
    this.record('deferUpdate', [guildId, { interactionId: ref.interactionId }]);
    this.check('deferUpdate', guildId);
    const state = this.mustInteraction(ref);
    if (this.clock - state.createdAtMs > ACK_DEADLINE_MS) throw FakeDiscord.unknownInteraction();
    state.deferred = true;
    state.updateDeferred = true;
    // Follow-ups after a deferred update are private to the clicker (ADR 0140).
    state.ephemeral = true;
  }

  async showModal(guildId: Snowflake, ref: InteractionRef, modal: Modal): Promise<void> {
    this.record('showModal', [guildId, { interactionId: ref.interactionId }, modal]);
    this.check('showModal', guildId);
    const state = this.mustInteraction(ref);
    // A modal must be the first response; Discord rejects one after a defer.
    if (state.deferred || this.clock - state.createdAtMs > ACK_DEADLINE_MS)
      throw FakeDiscord.unknownInteraction();
    state.modals.push(modal);
  }
```

3. Add the test helpers next to `emitInteraction` / `interactionReplies`:

```ts
  async emitModalSubmit(p: {
    channelId: Snowflake;
    messageId?: Snowflake;
    userId: Snowflake;
    customId: string;
    fields: Readonly<Record<string, string>>;
    interactionId?: Snowflake;
  }): Promise<Snowflake> {
    const interactionId = p.interactionId ?? this.nextId();
    const token = `tok-${interactionId}`;
    this.registerInteraction({ interactionId, token, channelId: p.channelId });
    await this.emit({
      kind: 'modalSubmit',
      guildId: this.guildId,
      receivedAtMs: this.clock,
      interactionId,
      token,
      channelId: p.channelId,
      messageId: p.messageId,
      userId: p.userId,
      customId: p.customId,
      fields: p.fields,
    });
    return interactionId;
  }

  modalsShown(interactionId: Snowflake): readonly Modal[] {
    return this.interactions.get(interactionId)?.modals ?? [];
  }

  wasUpdateDeferred(interactionId: Snowflake): boolean {
    return this.interactions.get(interactionId)?.updateDeferred ?? false;
  }
```

4. Make the fake keep what was sent, so tests can read a card back. In `sendMessage`, after
   `defineMessage`, also store `flags`, `components` and `files` on the `FakeMessage` (add those three
   optional fields to its type). In `editMessage`, overwrite the same three fields when the message is the
   bot's own. Add an accessor:

```ts
  /** The latest components/flags/files the bot sent or edited onto a message. */
  sentCard(ref: DiscordMessageRef):
    | { flags?: number; components?: readonly unknown[]; files?: readonly OutgoingFile[] }
    | undefined {
    const m = this.messages.get(key(ref.channelId, ref.messageId));
    return m === undefined ? undefined : { flags: m.flags, components: m.components, files: m.files };
  }
```

5. Tests for the fake (`packages/testkit/src/fake-discord.test.ts`; create the file with the same imports
   other testkit tests use if it does not exist):

```ts
it('refuses a modal after a defer, and records one shown first', async () => {
  const fake = new FakeDiscord({ guildId: GUILD });
  fake.registerInteraction({ interactionId: '1', token: 't1' });
  await fake.showModal(GUILD, { interactionId: '1', token: 't1' }, {
    custom_id: 'm',
    title: 'T',
    components: [],
  });
  expect(fake.modalsShown('1')).toHaveLength(1);

  fake.registerInteraction({ interactionId: '2', token: 't2' });
  await fake.deferUpdate(GUILD, { interactionId: '2', token: 't2' });
  expect(fake.wasUpdateDeferred('2')).toBe(true);
  expect(fake.wasEphemeral('2')).toBe(true);
  await expect(
    fake.showModal(GUILD, { interactionId: '2', token: 't2' }, { custom_id: 'm', title: 'T', components: [] }),
  ).rejects.toThrow();
});
```

Use the constructor signature `FakeDiscord` actually has (read its `constructor`). If it takes options
other than `guildId`, copy them from an existing testkit test.

- [ ] **Step 8: Satisfy the other `DiscordPort` implementers**

`rg -n "implements DiscordPort" packages apps` lists them. In `packages/core/src/effects/message-gateway.test.ts`
and `moderation-gateway.test.ts`, add to the local fake class:

```ts
  async deferUpdate(): Promise<void> {
    throw new Error('not used');
  }
  async showModal(): Promise<void> {
    throw new Error('not used');
  }
```

The REST adapter is done in Task 3. Until then `npm run typecheck` fails in `packages/discord`, so run it
at the end of Task 3, not here.

- [ ] **Step 9: Run the touched tests**

Run: `npx vitest run packages/core packages/testkit`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/core packages/testkit apps
git commit -m "P1 Task 2: port flags/files, deferUpdate, showModal, modalSubmit event, fake support"
```

---

### Task 3: REST adapter and gateway translation

**Files:**
- Modify: `packages/discord/src/rest/port.ts` (`toRestMessage`, `sendMessage`, `editMessage`,
  `respondToInteraction`, `deferUpdate`, `showModal`)
- Modify: `packages/discord/src/events.ts` (translate modal submits)
- Test: `packages/discord/src/rest/port.test.ts`, `packages/discord/src/events.test.ts`

**Interfaces:**
- Consumes: `OutgoingMessage.flags/files`, `OutgoingFile`, `Modal`, `DiscordPort.deferUpdate/showModal`,
  `ModalSubmitEvent` (Task 2).
- Produces: the live adapter behaviour that later tasks rely on.

- [ ] **Step 1: Let the REST test harness see multipart bodies**

In `packages/discord/src/rest/port.test.ts`, inside `harness`'s `makeRequest`, replace the `body:` line with:

```ts
        body:
          typeof init.body === 'string'
            ? JSON.parse(init.body)
            : init.body instanceof FormData
              ? multipartSummary(init.body)
              : undefined,
```

and add above `harness`:

```ts
/** A multipart request, reduced to its JSON payload and the uploaded file names. */
const multipartSummary = (form: FormData): { payload: unknown; files: string[] } => {
  const payload = form.get('payload_json');
  const files: string[] = [];
  for (const [key, value] of form.entries()) {
    if (key.startsWith('files[') && typeof value !== 'string') files.push((value as File).name);
  }
  return { payload: typeof payload === 'string' ? JSON.parse(payload) : undefined, files };
};
```

- [ ] **Step 2: Write the failing adapter tests** (new `describe` block at the end of `port.test.ts`)

```ts
describe('components V2 cards (ADR 0140)', () => {
  const card = {
    components: [{ type: 17, accent_color: 1, components: [{ type: 10, content: 'hi' }] }],
    flags: 1 << 15,
    allowedMentions: { parse: [] as [] },
  };
  const file = {
    name: 'saur-thumb.png',
    contentType: 'image/png',
    data: new Uint8Array([137, 80, 78, 71]),
    description: 'The Bananasaurs banana-saur',
  };

  it('sends flags on a plain JSON message when there are no files', async () => {
    const { port, requests } = harness([{ status: 200, body: { id: MESSAGE, channel_id: CHANNEL } }]);
    await port.sendMessage(GUILD, CHANNEL, card);
    expect(last(requests).body).toMatchObject({ flags: 32768, components: card.components });
  });

  it('uploads files as multipart with matching attachments metadata', async () => {
    const { port, requests } = harness([{ status: 200, body: { id: MESSAGE, channel_id: CHANNEL } }]);
    await port.sendMessage(GUILD, CHANNEL, { ...card, files: [file] });
    const body = last(requests).body as { payload: Record<string, unknown>; files: string[] };
    expect(body.files).toEqual(['saur-thumb.png']);
    expect(body.payload['attachments']).toEqual([
      { id: 0, filename: 'saur-thumb.png', description: 'The Bananasaurs banana-saur' },
    ]);
    expect(body.payload['flags']).toBe(32768);
  });

  it('clears content and embeds when an edit turns a message into a card', async () => {
    const { port, requests } = harness([{ status: 200, body: { id: MESSAGE, channel_id: CHANNEL } }]);
    await port.editMessage(GUILD, { channelId: CHANNEL, messageId: MESSAGE }, card);
    expect(last(requests).method).toBe('PATCH');
    expect(last(requests).body).toMatchObject({ content: null, embeds: null, flags: 32768 });
  });

  it('leaves a plain edit byte-identical to before', async () => {
    const { port, requests } = harness([{ status: 200, body: { id: MESSAGE, channel_id: CHANNEL } }]);
    await port.editMessage(GUILD, { channelId: CHANNEL, messageId: MESSAGE }, { content: 'x' });
    expect(last(requests).body).toEqual({ content: 'x' });
  });

  it('defers an update with callback type 6 and makes the follow-up ephemeral', async () => {
    const { port, requests } = harness([
      { status: 204 },
      { status: 200, body: { id: MESSAGE, channel_id: CHANNEL } },
    ]);
    const ref = { interactionId: '888888888888888888', token: 'tok' };
    await port.deferUpdate(GUILD, ref);
    expect(requests[0]?.body).toEqual({ type: 6 });
    expect(requests[0]?.authorization).toBeUndefined();
    await port.respondToInteraction(GUILD, ref, card);
    // 64 (ephemeral) | 32768 (components v2)
    expect(last(requests).body).toMatchObject({ flags: 32768 | 64 });
  });

  it('shows a modal with callback type 9', async () => {
    const { port, requests } = harness([{ status: 204 }]);
    const modal = { custom_id: 'bs.task:update:x', title: 'Post an update', components: [] };
    await port.showModal(GUILD, { interactionId: '888888888888888888', token: 'tok' }, modal);
    expect(last(requests).body).toEqual({ type: 9, data: modal });
    expect(last(requests).authorization).toBeUndefined();
  });
});
```

Run: `npx vitest run packages/discord/src/rest/port.test.ts`
Expected: FAIL (`deferUpdate` is not a function, flags missing, …).

- [ ] **Step 3: Implement the adapter changes** in `packages/discord/src/rest/port.ts`

1. `toRestMessage`: add, after the `components` line:

```ts
    ...(message.flags === undefined ? {} : { flags: message.flags }),
    ...(message.files === undefined || message.files.length === 0
      ? {}
      : {
          attachments: message.files.map((file, id) => ({
            id,
            filename: file.name,
            ...(file.description === undefined ? {} : { description: file.description }),
          })),
        }),
```

2. Add a helper below `toRestMessage`:

```ts
/** `@discordjs/rest` raw files for a message, keyed to match `attachments[].id`. */
function restFiles(message: OutgoingMessage) {
  return message.files === undefined || message.files.length === 0
    ? undefined
    : message.files.map((file, id) => ({
        key: `files[${id}]`,
        name: file.name,
        data: file.data,
        contentType: file.contentType,
      }));
}

const IS_COMPONENTS_V2 = 1 << 15;
```

3. `sendMessage`:

```ts
    async sendMessage(_guildId, channelId, message) {
      const files = restFiles(message);
      const posted = (await mapErrors(() =>
        rest.post(Routes.channelMessages(channelId), {
          body: toRestMessage(message),
          ...(files === undefined ? {} : { files }),
        }),
      )) as APIMessage;
      return { channelId, messageId: posted.id };
    },
```

4. `editMessage`. A V2 edit must null `content` and `embeds` (ADR 0140, verified behaviour):

```ts
    async editMessage(_guildId, ref, message) {
      const files = restFiles(message);
      const becomesCard = message.flags !== undefined && (message.flags & IS_COMPONENTS_V2) !== 0;
      await mapErrors(() =>
        rest.patch(Routes.channelMessage(ref.channelId, ref.messageId), {
          body: {
            ...toRestMessage(message),
            ...(becomesCard ? { content: null, embeds: null } : {}),
          },
          ...(files === undefined ? {} : { files }),
        }),
      );
    },
```

5. `respondToInteraction`: replace the body spread so flags combine:

```ts
      const ephemeral = deferred.get(ref.interactionId)?.ephemeral ?? false;
      const flags = (message.flags ?? 0) | (ephemeral ? MessageFlags.Ephemeral : 0);
      const files = restFiles(message);
      const posted = (await mapErrors(() =>
        rest.post(Routes.webhook(applicationId, ref.token), {
          body: { ...toRestMessage(message), ...(flags === 0 ? {} : { flags }) },
          ...(files === undefined ? {} : { files }),
          auth: false,
        }),
      )) as Partial<APIMessage> | undefined;
```

   Keep the rest of the function unchanged.

6. New methods next to `deferInteraction`:

```ts
    async deferUpdate(_guildId, ref) {
      await mapErrors(() =>
        rest.post(Routes.interactionCallback(ref.interactionId, ref.token), {
          body: { type: InteractionResponseType.DeferredMessageUpdate },
          auth: false,
        }),
      );
      // Follow-ups after a deferred update are private to the clicker (ADR 0140).
      rememberDefer(ref.interactionId, true);
    },

    async showModal(_guildId, ref, modal) {
      await mapErrors(() =>
        rest.post(Routes.interactionCallback(ref.interactionId, ref.token), {
          body: { type: InteractionResponseType.Modal, data: modal },
          auth: false,
        }),
      );
    },
```

Run: `npx vitest run packages/discord/src/rest/port.test.ts` and expect PASS. If the `toEqual({ type: 6 })` assertion
sees extra keys, check that nothing else is spread into the body.

- [ ] **Step 4: Write the failing gateway translation test**

In `packages/discord/src/events.test.ts`, find how the existing tests build a button interaction for
`Events.InteractionCreate` (look for `isButton`). Add a test in the same style that emits an object where:

- `isChatInputCommand()`, `isButton()` and `isStringSelectMenu()` return `false`
- `isModalSubmit()` returns `true`
- `guildId`, `channelId`, `id`, `token`, `customId` are set, `user` is `{ id: USER }` and `message` is
  `{ id: MESSAGE }`
- `fields.fields` is a `Map` with:
  - `'body' → { type: 4, customId: 'body', value: 'Left side done' }`
  - `'duration' → { type: 21, customId: 'duration', value: '1h' }`
  - `'empty' → { type: 21, customId: 'empty', value: null }`

Expect the translated event:

```ts
{
  kind: 'modalSubmit',
  guildId: GUILD,
  interactionId: '…',
  token: '…',
  channelId: CHANNEL,
  messageId: MESSAGE,
  userId: USER,
  customId: 'bs.task:update:00000000-0000-4000-8000-000000000001',
  fields: { body: 'Left side done', duration: '1h' },
}
```

(`receivedAtMs` equals whatever the existing tests' clock returns.) Also add a case where `message` is
`null`, which must translate with `messageId: undefined`.

- [ ] **Step 5: Implement the translation**

In `packages/discord/src/events.ts`, inside the `Events.InteractionCreate` handler, after the slash
command line and **before** the `isButton` check:

```ts
      if (interaction.isModalSubmit()) {
        const guildId = interaction.guildId;
        const channelId = interaction.channelId;
        if (!guildId || !channelId) return undefined;
        const fields: Record<string, string> = {};
        for (const data of interaction.fields.fields.values()) {
          if (data.type === ComponentType.TextInput) fields[data.customId] = data.value;
          else if (data.type === ComponentType.RadioGroup && data.value !== null)
            fields[data.customId] = data.value;
        }
        return {
          kind: 'modalSubmit',
          guildId,
          receivedAtMs: now(),
          interactionId: interaction.id,
          token: interaction.token,
          channelId,
          messageId: interaction.message?.id,
          userId: interaction.user.id,
          customId: interaction.customId,
          fields,
        };
      }
```

Import `ComponentType` from `discord.js` (it is a value export). Update the comment above the `isButton`
check: modal submits are now translated; autocomplete and context-menu commands are still dropped.

- [ ] **Step 6: Run the adapter tests, then all gates**

```bash
npx vitest run packages/discord
npm run typecheck
npm run lint
npm run test
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/discord
git commit -m "P1 Task 3: REST adapter sends files, flags, deferred updates and modals; gateway translates modal submits"
```

---

### Task 4: Storage — links, card render state, the `update` slot kind

**Files:**
- Modify: `packages/storage/src/schema.ts` (`taskLinks` table; `taskMessageAnchors.renderedVersion` and
  `renderedAt`; `'update'` in `task_nudge_slot_kind`)
- Generate: `drizzle/01xx_ui_task_cards.sql` + snapshot (via `npm run db:generate -- --name ui_task_cards`)
- Modify: `packages/storage/src/repos/tasks.ts` (`TaskLink`, `listTaskLinks`, links in `createTask` /
  `updateTask`, `anchorFor`, `staleTaskCards`, `markCardRendered`, `lastPickup`)
- Modify: `packages/storage/src/repos/task-nudges.ts` (`NudgeKind` gains `'update'`)
- Test: `packages/storage/src/repos/tasks.test.ts`

**Interfaces:**
- Produces:
  - `interface TaskLink { readonly label: string; readonly url: string }`
  - `NewTask.links?: readonly TaskLink[]`, and `TaskEdit` includes `links` (`undefined` keeps the list; `[]`
    clears it)
  - `listTaskLinks(scope: GuildScope, taskId: string): TaskLink[]`, in position order
  - `anchorFor(scope: GuildScope, taskId: string): { channelId: string; messageId: string } | undefined`
  - `staleTaskCards(scope: GuildScope, limit: number): { taskId: string; channelId: string; messageId: string; version: number }[]`
  - `markCardRendered(scope: GuildScope, taskId: string, version: number, now: number): void`
  - `lastPickup(scope: GuildScope, taskId: string): { actorId: string; at: number } | undefined`
  - `NudgeKind` includes `'update'`
- Consumes: nothing new.

- [ ] **Step 1: Write the failing repository tests** (append to `packages/storage/src/repos/tasks.test.ts`;
  add the new functions to its import list)

```ts
describe('task links (ADR 0140)', () => {
  it('stores links in order on create and returns them', () => {
    const teamId = seedTeam();
    const taskId = seedTask(teamId, {
      links: [
        { label: 'Wiring diagram', url: 'https://drive.example/a.pdf' },
        { label: 'BOM sheet', url: 'https://docs.example/bom' },
      ],
    });
    expect(listTaskLinks(a, taskId)).toEqual([
      { label: 'Wiring diagram', url: 'https://drive.example/a.pdf' },
      { label: 'BOM sheet', url: 'https://docs.example/bom' },
    ]);
  });

  it('replaces links on edit when given, keeps them when omitted, clears them with []', () => {
    const teamId = seedTeam();
    const taskId = seedTask(teamId, { links: [{ label: 'One', url: 'https://one.example' }] });
    const base = {
      title: 'Project',
      assignmentKind: 'team' as const,
      dueAt: 3000,
      timezone: 'America/Vancouver',
      destinationId: '444444444444444444',
    };
    expect(updateTask(a, taskId, 1, base, ACTOR, 5)).toBe('ok');
    expect(listTaskLinks(a, taskId)).toEqual([{ label: 'One', url: 'https://one.example' }]);
    expect(
      updateTask(
        a,
        taskId,
        2,
        { ...base, links: [{ label: 'Two', url: 'https://two.example' }] },
        ACTOR,
        6,
      ),
    ).toBe('ok');
    expect(listTaskLinks(a, taskId)).toEqual([{ label: 'Two', url: 'https://two.example' }]);
    expect(updateTask(a, taskId, 3, { ...base, links: [] }, ACTOR, 7)).toBe('ok');
    expect(listTaskLinks(a, taskId)).toEqual([]);
  });

  it('never returns another guild’s links', () => {
    const teamA = seedTeam(a);
    const taskA = seedTask(teamA, { links: [{ label: 'A', url: 'https://a.example' }] }, a);
    expect(listTaskLinks(b, taskA)).toEqual([]);
  });

  it('the database refuses an http link and a sixth link', () => {
    const teamId = seedTeam();
    expect(() => seedTask(teamId, { links: [{ label: 'x', url: 'http://plain.example' }] })).toThrow();
    const six = Array.from({ length: 6 }, (_, i) => ({
      label: `L${i}`,
      url: `https://x.example/${i}`,
    }));
    expect(() => seedTask(teamId, { links: six })).toThrow();
  });

  it('deleting the task deletes its links', () => {
    const teamId = seedTeam();
    const taskId = seedTask(teamId, { links: [{ label: 'x', url: 'https://x.example' }] });
    deleteTask(a, taskId, 1, ACTOR, 9);
    expect(listTaskLinks(a, taskId)).toEqual([]);
  });
});

describe('task card render state (ADR 0140)', () => {
  const CHANNEL = '444444444444444444';
  const MESSAGE = '555555555555555555';
  const anchorTask = () => {
    const teamId = seedTeam();
    const taskId = seedTask(teamId);
    expect(recordTaskAnchor(a, taskId, CHANNEL, MESSAGE, 3)).toBe('recorded');
    return taskId;
  };

  it('a new anchor is stale until marked rendered at the current version', () => {
    const taskId = anchorTask();
    expect(staleTaskCards(a, 10)).toEqual([
      { taskId, channelId: CHANNEL, messageId: MESSAGE, version: 1 },
    ]);
    markCardRendered(a, taskId, 1, 4);
    expect(staleTaskCards(a, 10)).toEqual([]);
    expect(anchorFor(a, taskId)).toEqual({ channelId: CHANNEL, messageId: MESSAGE });
  });

  it('a version bump or a newer report makes the card stale again', () => {
    const taskId = anchorTask();
    markCardRendered(a, taskId, 1, 4);
    expect(setStatus(a, taskId, 1, 'in_progress', MEMBER_ACTOR, 5)).toBe(true);
    expect(staleTaskCards(a, 10).map((s) => s.version)).toEqual([2]);
    markCardRendered(a, taskId, 2, 6);
    expect(staleTaskCards(a, 10)).toEqual([]);
    expect(recordReport(a, taskId, 'r1', '444444444444444444', 'did it', MEMBER_ACTOR, 7)).toBe(
      'recorded',
    );
    expect(staleTaskCards(a, 10)).toHaveLength(1);
  });

  it('never moves rendered_version backwards', () => {
    const taskId = anchorTask();
    expect(setStatus(a, taskId, 1, 'in_progress', MEMBER_ACTOR, 5)).toBe(true);
    markCardRendered(a, taskId, 2, 6);
    markCardRendered(a, taskId, 1, 7);
    expect(staleTaskCards(a, 10)).toEqual([]);
  });

  it('skips archived tasks', () => {
    const taskId = anchorTask();
    archiveTask(a, taskId, 1, ACTOR, 5);
    expect(staleTaskCards(a, 10)).toEqual([]);
  });

  it('is scoped to the guild', () => {
    anchorTask();
    expect(staleTaskCards(b, 10)).toEqual([]);
  });

  it('reports who last picked the task up, from the audit trail', () => {
    const taskId = anchorTask();
    expect(lastPickup(a, taskId)).toBeUndefined();
    expect(setStatus(a, taskId, 1, 'in_progress', MEMBER_ACTOR, 5)).toBe(true);
    expect(lastPickup(a, taskId)).toEqual({ actorId: MEMBER_ACTOR.actorId, at: 5 });
  });
});
```

Read the signatures of `deleteTask` and `archiveTask` in `tasks.ts`. If either needs different
arguments (for example no version), call it the way its existing tests do.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/storage/src/repos/tasks.test.ts`
Expected: FAIL (functions not exported; `links` not accepted).

- [ ] **Step 3: Change the schema**

In `packages/storage/src/schema.ts`:

1. In `taskMessageAnchors`, add two columns after `createdAt`:

```ts
    /** The task version this card last showed (ADR 0140). 0 = a pre-card text post. */
    renderedVersion: integer('rendered_version').notNull().default(0),
    /** When the card was last rendered; a newer task report makes it stale. */
    renderedAt: integer('rendered_at').notNull().default(0),
```

2. In `taskNudgeSlots`, add `'update'` at the end of the `task_nudge_slot_kind` CHECK list:

```ts
      sql`${t.kind} IN ('pre_due','custom','checkin','digest','followup','announce','review','clarify','evaluate','update')`,
```

3. Add the links table directly after `taskMessageAnchors`:

```ts
/** Up to five ordered links shown as buttons on a task's card (ADR 0140). */
export const taskLinks = sqliteTable(
  'task_links',
  {
    guildId: snowflake('guild_id').notNull(),
    taskId: text('task_id').notNull(),
    position: integer('position').notNull(),
    label: text('label').notNull(),
    url: text('url').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.guildId, t.taskId, t.position] }),
    foreignKey({
      columns: [t.guildId, t.taskId],
      foreignColumns: [clubTasks.guildId, clubTasks.taskId],
    }).onDelete('cascade'),
    check('task_links_guild_snowflake', snowflakeCheck(t.guildId)),
    check('task_links_position', sql`${t.position} BETWEEN 0 AND 4`),
    check('task_links_label', sql`length(${t.label}) BETWEEN 1 AND 34`),
    check('task_links_url', sql`${t.url} LIKE 'https://%' AND length(${t.url}) <= 512`),
  ],
);
```

- [ ] **Step 4: Generate the migration**

```bash
npm run db:generate -- --name ui_task_cards
```

Expected: a new `drizzle/01xx_ui_task_cards.sql`, where `01xx` is the next free number (0107 on
`950f78fe`), plus a snapshot and a journal entry. `strictify:` should report one table made STRICT. Read
the SQL. It must contain:

- `CREATE TABLE \`task_links\` … ) STRICT;`
- two `ALTER TABLE \`task_message_anchors\` ADD …` statements
- a rebuild of `task_nudge_slots` (`__new_task_nudge_slots`) with the widened CHECK, which copies every
  row and recreates both indexes (`task_nudge_due`, `task_nudge_message`)

If the rebuild drops an index, stop and record it as a deviation. Don't hand-edit around it.

- [ ] **Step 5: Write the repository functions**

In `packages/storage/src/repos/task-nudges.ts`, add `| 'update'` to `NudgeKind`.

In `packages/storage/src/repos/tasks.ts`:

1. Import `taskLinks` and `auditEvents` from `../schema.js` alongside the existing imports, and `desc`
   from `drizzle-orm` if it is not imported yet.
2. Add, next to `NewTask`:

```ts
export interface TaskLink {
  readonly label: string;
  readonly url: string;
}
```

   Add `readonly links?: readonly TaskLink[] | undefined;` to `NewTask`, and add `| 'links'` to the
   `TaskEdit` `Pick<…>` list.
3. Add a private helper above `createTask`:

```ts
/** Replace a task's links inside the caller's transaction. */
const writeLinks = (
  db: WriteTx['db'],
  scope: GuildScope,
  taskId: string,
  links: readonly TaskLink[],
): void => {
  db.delete(taskLinks).where(scope.only(taskLinks, eq(taskLinks.taskId, taskId))).run();
  if (links.length > 0)
    db.insert(taskLinks)
      .values(
        links.map((link, position) => ({
          guildId: scope.guildId,
          taskId,
          position,
          label: link.label,
          url: link.url,
        })),
      )
      .run();
};
```

4. In `createTask`, right after the `taskAssignees` insert:

```ts
    if (input.links !== undefined && input.links.length > 0)
      writeLinks(db, scope, taskId, input.links);
```

   and add `links: input.links?.length ?? 0,` to the `task.created` audit `after` object.
5. In `updateTask`, right after the `taskAssignees` re-insert:

```ts
    if (input.links !== undefined) writeLinks(db, scope, taskId, input.links);
```

   and add `links: input.links === undefined ? 'unchanged' : input.links.length,` to the `task.edited`
   audit `after` object.
6. Add the readers and the render-state writer at the end of the file:

```ts
export const listTaskLinks = (scope: GuildScope, taskId: string): TaskLink[] =>
  read(scope, (db) =>
    db
      .select({ label: taskLinks.label, url: taskLinks.url })
      .from(taskLinks)
      .where(scope.only(taskLinks, eq(taskLinks.taskId, taskId)))
      .orderBy(taskLinks.position)
      .all(),
  );

/** The task's own posted card, if it has one. */
export const anchorFor = (
  scope: GuildScope,
  taskId: string,
): { channelId: string; messageId: string } | undefined =>
  read(scope, (db) =>
    db
      .select({ channelId: taskMessageAnchors.channelId, messageId: taskMessageAnchors.messageId })
      .from(taskMessageAnchors)
      .where(scope.only(taskMessageAnchors, eq(taskMessageAnchors.taskId, taskId)))
      .get(),
  );

/**
 * Anchored cards that no longer show their task (ADR 0140 decision 5): the
 * task's version moved past `rendered_version`, or a report arrived after
 * `rendered_at`. Archived tasks are skipped, and so are done tasks whose post
 * was never a card (decision 6 converts open tasks only). Oldest change first.
 */
export const staleTaskCards = (
  scope: GuildScope,
  limit: number,
): { taskId: string; channelId: string; messageId: string; version: number }[] =>
  read(scope, (db) =>
    db
      .select({
        taskId: taskMessageAnchors.taskId,
        channelId: taskMessageAnchors.channelId,
        messageId: taskMessageAnchors.messageId,
        version: clubTasks.version,
      })
      .from(taskMessageAnchors)
      .innerJoin(
        clubTasks,
        and(
          eq(clubTasks.guildId, taskMessageAnchors.guildId),
          eq(clubTasks.taskId, taskMessageAnchors.taskId),
        ),
      )
      .where(
        scope.only(
          taskMessageAnchors,
          isNull(clubTasks.archivedAt),
          sql`(${clubTasks.status} <> 'done' OR ${taskMessageAnchors.renderedVersion} > 0)`,
          sql`(${taskMessageAnchors.renderedVersion} < ${clubTasks.version} OR ${taskMessageAnchors.renderedAt} < COALESCE((SELECT MAX(r.created_at) FROM task_reports r WHERE r.guild_id = ${taskMessageAnchors.guildId} AND r.task_id = ${taskMessageAnchors.taskId}), 0))`,
        ),
      )
      .orderBy(clubTasks.updatedAt)
      .limit(limit)
      .all(),
  );

/** Record that the card now shows `version`. Never moves backwards. */
export const markCardRendered = (
  scope: GuildScope,
  taskId: string,
  version: number,
  now: number,
): void =>
  write(scope, ({ db }) => {
    db.update(taskMessageAnchors)
      .set({
        renderedVersion: sql`MAX(${taskMessageAnchors.renderedVersion}, ${version})`,
        renderedAt: sql`MAX(${taskMessageAnchors.renderedAt}, ${now})`,
      })
      .where(scope.only(taskMessageAnchors, eq(taskMessageAnchors.taskId, taskId)))
      .run();
  });

/** Who last moved the task to In progress by hand, and when (from the audit trail). */
export const lastPickup = (
  scope: GuildScope,
  taskId: string,
): { actorId: string; at: number } | undefined =>
  read(scope, (db) =>
    db
      .select({ actorId: auditEvents.actorId, at: auditEvents.at })
      .from(auditEvents)
      .where(
        scope.only(
          auditEvents,
          eq(auditEvents.subjectType, 'club_task'),
          eq(auditEvents.subjectId, taskId),
          eq(auditEvents.action, 'task.status_set'),
          sql`json_extract(${auditEvents.after}, '$.status') = 'in_progress'`,
        ),
      )
      .orderBy(desc(auditEvents.at))
      .limit(1)
      .get(),
  );
```

   Check the real column names in `schema.ts`: `task_reports` (`guild_id`, `task_id`, `created_at`) and
   `auditEvents` (`actorId`, `at`, `subjectType`, `subjectId`, `action`, `after`). If any differ, use the
   real names. Check how `scope.only(table, ...conditions)` is called in `taskForAnchor` and copy that call
   shape. If `scope.only` takes exactly one condition, wrap several in `and(...)`.

7. If any storage test, export, erasure or backup code lists every task table (search
   `rg -n "taskAssignees" packages/storage/src` and look for lists, not queries), add `taskLinks` next to
   `taskAssignees` there.

- [ ] **Step 6: Run storage tests, then the gates**

```bash
npx vitest run packages/storage
npm run typecheck
npm run lint
npm run test
```

Expected: PASS. `schema-invariants.test.ts` must pass unchanged: the new table is STRICT, carries
`guild_id`, and its foreign key and primary key lead with `guild_id`.

- [ ] **Step 7: Commit**

```bash
git add packages/storage drizzle
git commit -m "P1 Task 4: task_links, card render state on anchors, update slot kind"
```

---

### Task 5: Links through core, HTTP and MCP

**Files:**
- Create: `packages/core/src/task/links.ts`, `packages/core/src/task/links.test.ts`
- Modify: `packages/core/src/index.ts` (export the link schema and limits)
- Modify: `packages/http/src/routes/task-write.ts` (`links` on create and edit)
- Modify: `packages/http/src/routes/tasks.ts` (`links` in the task detail response)
- Modify: `packages/mcp/src/tools/task-admin.ts` (`links` in `taskFields`)
- Modify: `packages/mcp/src/tools/task-tools.ts` (`links` in `updateTaskParams`)
- Modify: `packages/mcp/src/tools/tasks.ts` (`McpTaskDetail.links`; cleaned in `getTaskDetailsText`)
- Modify: `apps/daemon/src/mcp/task-admin-port.ts` (pass `links` to `createTask` / `updateTask`)
- Modify: `apps/daemon/src/mcp/wiring.ts` (`detail:` includes `links`, around line 6870)
- Test: the existing test file beside each modified file

**Interfaces:**
- Produces:
  - From `@bananasaurs/core`: `taskLinkSchema`, `taskLinksSchema`, `TASK_LINKS_MAX = 5`,
    `TASK_LINK_LABEL_MAX = 34`, `TASK_LINK_URL_MAX = 512`.
  - HTTP: `POST /api/tasks` and `PUT /api/tasks/:taskId` accept `links`; `GET /api/tasks/:taskId` returns
    `links: { label, url }[]`.
  - MCP: `create_task` and `update_task` (`edit`) accept `links`; `get_task` returns them.
- Consumes: `NewTask.links`, `TaskEdit.links`, `listTaskLinks` (Task 4).

- [ ] **Step 1: Write the failing schema test**

`packages/core/src/task/links.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { taskLinksSchema } from './links.js';

describe('taskLinksSchema', () => {
  it('accepts up to five https links and trims labels', () => {
    const parsed = taskLinksSchema.parse([{ label: '  Docs ', url: 'https://example.com/a' }]);
    expect(parsed).toEqual([{ label: 'Docs', url: 'https://example.com/a' }]);
  });
  it.each([
    [[{ label: 'x', url: 'http://example.com' }]],
    [[{ label: '', url: 'https://example.com' }]],
    [[{ label: 'x'.repeat(35), url: 'https://example.com' }]],
    [[{ label: 'x', url: `https://example.com/${'a'.repeat(500)}` }]],
    [[{ label: 'x', url: 'javascript:alert(1)' }]],
    [Array.from({ length: 6 }, (_, i) => ({ label: `L${i}`, url: `https://e.com/${i}` }))],
    [[{ label: 'x', url: 'https://example.com', extra: 1 }]],
  ])('rejects %j', (input) => {
    expect(taskLinksSchema.safeParse(input).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then write `links.ts`**

```ts
import { z } from 'zod';

/** ADR 0140: links shown as buttons on a task card. Discord's button label budget is 34 with an emoji. */
export const TASK_LINKS_MAX = 5;
export const TASK_LINK_LABEL_MAX = 34;
export const TASK_LINK_URL_MAX = 512;

export const taskLinkSchema = z
  .object({
    label: z.string().trim().min(1).max(TASK_LINK_LABEL_MAX),
    url: z
      .string()
      .max(TASK_LINK_URL_MAX)
      .url()
      .refine((url) => url.startsWith('https://'), 'must start with https://'),
  })
  .strict();

export const taskLinksSchema = z.array(taskLinkSchema).max(TASK_LINKS_MAX);
export type TaskLinkInput = z.infer<typeof taskLinkSchema>;
```

Export all six names from `packages/core/src/index.ts`. Run the test and expect PASS.

- [ ] **Step 3: HTTP — write the failing tests**

In the HTTP task-write route tests (`packages/http/src/routes/task-write.test.ts`), find an existing
`POST /api/tasks` test that builds a valid body and reuse its setup:

- a valid create with `links: [{ label: 'Docs', url: 'https://example.com' }]` returns 201, and a following
  `GET /api/tasks/:taskId` returns `links: [{ label: 'Docs', url: 'https://example.com' }]`
- a create with `links: [{ label: 'Docs', url: 'http://example.com' }]` returns 400
- an edit (`PUT`) with `links: []` clears them; an edit with no `links` key keeps them

- [ ] **Step 4: HTTP — implement**

In `packages/http/src/routes/task-write.ts`, import `taskLinksSchema` from `@bananasaurs/core` and add
`links: taskLinksSchema.optional(),` to `taskSchema`'s object. `taskEditSchema` derives from it, and both
handlers already spread `parsed.data` into the repository input. Confirm the spread reaches `createTask`
and `updateTask`.

In `packages/http/src/routes/tasks.ts`, in `GET /api/tasks/:taskId`, add
`links: taskRepo.listTaskLinks(session.scope, task.taskId),` to the response object.

Run the HTTP tests and expect PASS.

- [ ] **Step 5: MCP — write the failing tests**

In the MCP tool tests (wherever `runTaskAdmin` is tested; `rg -n "runTaskAdmin" packages/mcp/src`):

- `runTaskAdmin(principal, port, 'create_club_task', { …valid…, links: [{ label: 'Docs', url: 'http://x.example' }] })`
  resolves to `{ ok: false, message: INVALID_ARGUMENTS_MESSAGE }`, and the port is not called
- the same call with an `https://` link reaches the port with `links` in its args
- `getTaskDetailsText`'s JSON includes `links`, and a link label containing `@everyone` comes back cleaned
  (`@` replaced), as the title is

- [ ] **Step 6: MCP — implement**

1. `packages/mcp/src/tools/task-admin.ts`: import `taskLinksSchema` from `@bananasaurs/core`, and add to
   `taskFields`:

```ts
  links: taskLinksSchema
    .optional()
    .describe(
      'Up to 5 links shown as buttons on the task card: { label (at most 34 characters), url (https only) }. On edit, omit to keep the current links; [] clears them.',
    ),
```

2. `packages/mcp/src/tools/task-tools.ts`, in `updateTaskParams` after `destinationId`:

```ts
  links: editTaskParams.links
    .optional()
    .describe('edit uses this. Omit to keep the links; [] clears them.'),
```

3. `packages/mcp/src/tools/tasks.ts`: add
   `readonly links: readonly { readonly label: string; readonly url: string }[];` to `McpTaskDetail`. In
   `getTaskDetailsText`, add to the JSON:

```ts
    links: task.links.map((link) => ({ label: clean(link.label, 34), url: link.url })),
```

4. `apps/daemon/src/mcp/task-admin-port.ts`: in `create_club_task`'s `taskRepo.createTask` input and in
   `edit_club_task`'s `taskRepo.updateTask` input, add:

```ts
                ...(a.links !== undefined ? { links: a.links } : {}),
```

5. `apps/daemon/src/mcp/wiring.ts`, in the `detail:` implementation (about line 6870): add
   `links: taskRepo.listTaskLinks(scope, taskId),` to the returned object, using the scope variable that
   function already uses.

- [ ] **Step 7: Gates and commit**

```bash
npm run typecheck
npm run lint
npm run test
git add packages/core packages/http packages/mcp apps/daemon
git commit -m "P1 Task 5: task links through core schema, HTTP and MCP"
```

---

### Task 6: Error copy and private result/error cards

**Files:**
- Create: `packages/core/src/copy/errors.ts`, `packages/core/src/copy/errors.test.ts`
- Create: `packages/core/src/ui/discord/common-cards.ts`, `common-cards.test.ts`
- Modify: `packages/core/src/ui/discord/index.ts` (export common cards)
- Modify: `packages/core/src/index.ts` (export the catalogue)

**Interfaces:**
- Produces:
  - `ERROR_COPY` (object), `type ErrorCode = keyof typeof ERROR_COPY`, and
    `interface ErrorCopy { title; detail; next?; retryable; tone: 'hold' | 'danger'; audience: 'member' | 'moderator' | 'owner' }`
  - `errorCard(code: ErrorCode, options?: { quote?: string; ref?: string }): CardMessage`
  - `resultCard(options: { icon: IconName; title: string; detail?: string; tone: Tone }): CardMessage`
- Consumes: `card`, `text`, `ICON`, `escapeText`, `truncate`, `subtext` (Task 1).

- [ ] **Step 1: Write the failing tests**

`packages/core/src/copy/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ERROR_COPY } from './errors.js';

const BANNED = /\b(please|sorry|oops|invalid|illegal|forbidden|failed to|an error occurred)\b/i;

describe('error copy (docs/28 §3)', () => {
  it.each(Object.entries(ERROR_COPY))('%s follows the writing rules', (_code, entry) => {
    expect(entry.title.length).toBeGreaterThan(0);
    expect(entry.title.length).toBeLessThanOrEqual(60);
    expect(entry.detail.length).toBeGreaterThan(0);
    const next = 'next' in entry ? entry.next : '';
    for (const s of [entry.title, entry.detail, next]) expect(s).not.toMatch(BANNED);
    expect(entry.title[0]).toBe(entry.title[0]?.toUpperCase());
    expect(entry.title).not.toMatch(/[.!]$/);
  });
});
```

`packages/core/src/ui/discord/common-cards.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { errorCard, resultCard } from './common-cards.js';
import { countText } from './budget.js';

/** Every text display's content, in order. */
const contents = (c: { components: readonly unknown[] }): string[] => {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v !== 'object' || v === null) return;
    const o = v as Record<string, unknown>;
    if (o['type'] === 10 && typeof o['content'] === 'string') out.push(o['content']);
    walk(o['components']);
  };
  walk(c.components);
  return out;
};
const accent = (c: { components: readonly unknown[] }) =>
  (c.components[0] as { accent_color: number }).accent_color;

describe('errorCard', () => {
  it('shows title, detail and next step, in the entry’s tone, with no pings or art', () => {
    const c = errorCard('task.not-yours');
    const all = contents(c).join('\n');
    expect(all).toContain("**✋ This task isn't yours to pick up**");
    expect(all).toContain('Only people assigned to it');
    expect(all).toContain('💡 Ask a team lead');
    expect(accent(c)).toBe(0xe0a526);
    expect(c.allowedMentions).toEqual({ parse: [] });
    expect(c.art).toEqual([]);
  });

  it('uses the error icon and red for danger entries', () => {
    const c = errorCard('task.unavailable');
    expect(contents(c)[0]).toContain("**❌ Couldn't update the task**");
    expect(accent(c)).toBe(0xd64545);
  });

  it('quotes the member’s text back, escaped, as a block quote', () => {
    const c = errorCard('task.update-not-saved', { quote: 'line one @everyone\n**two**' });
    const quote = contents(c)[1];
    expect(quote).toBe('> line one @​everyone\n> \\*\\*two\\*\\*');
  });

  it('caps a very long quote so the card stays in budget', () => {
    const c = errorCard('task.update-not-saved', { quote: 'x'.repeat(10_000) });
    expect(countText(c.components)).toBeLessThanOrEqual(4000);
  });

  it('adds a Ref line only when given one', () => {
    expect(contents(errorCard('task.unavailable')).join('\n')).not.toContain('Ref ');
    expect(contents(errorCard('task.unavailable', { ref: '7F3K' })).at(-1)).toBe('-# Ref 7F3K');
  });
});

describe('resultCard', () => {
  it('renders an icon title and optional detail in the given tone', () => {
    const c = resultCard({
      icon: 'update',
      title: 'Update saved',
      detail: 'It shows on the task card.',
      tone: 'ok',
    });
    expect(contents(c)).toEqual(['**📝 Update saved**\nIt shows on the task card.']);
    expect(accent(c)).toBe(0x2e9a62);
  });
});
```

Run both and expect FAIL (modules missing).

- [ ] **Step 2: Write `packages/core/src/copy/errors.ts`**

```ts
/**
 * The error catalogue (docs/28 §3, ADR 0141). One entry per failure a person
 * can meet; Discord replies and HTTP answers read the same words. P1 adds the
 * task entries; P2 adds moderation, panels and the rest, plus a completeness test.
 */
export type CopyAudience = 'member' | 'moderator' | 'owner';

export interface ErrorCopy {
  /** What happened, in a few words. Sentence case, no full stop. */
  readonly title: string;
  /** Why, framed as the system's rule. */
  readonly detail: string;
  /** What the reader can do, or who can. */
  readonly next?: string;
  /** True only when trying again can succeed. */
  readonly retryable: boolean;
  readonly tone: 'hold' | 'danger';
  readonly audience: CopyAudience;
}

export const ERROR_COPY = {
  'task.not-yours': {
    title: "This task isn't yours to pick up",
    detail: 'Only people assigned to it, or on its team for a whole-team task, can do this.',
    next: 'Ask a team lead to add you if you want to help.',
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'task.not-open': {
    title: 'This task is closed',
    detail: "It's done, archived or waiting for review, so it can't change from here.",
    next: 'Use /task list to see your open tasks.',
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'task.stale': {
    title: 'This card was out of date',
    detail: 'The task changed after this card was posted. The card has been refreshed.',
    next: 'Try again on the refreshed card.',
    retryable: true,
    tone: 'hold',
    audience: 'member',
  },
  'task.unavailable': {
    title: "Couldn't update the task",
    detail: "Bananasaurs couldn't save the change. Nothing was changed.",
    next: 'Try again in a minute.',
    retryable: true,
    tone: 'danger',
    audience: 'member',
  },
  'task.update-not-saved': {
    title: "Your update wasn't saved",
    detail: 'Only people on this task can post updates to it, and only while it is open.',
    next: 'Here is what you wrote, so you can copy it:',
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'task.review-not-yours': {
    title: "You can't review this task",
    detail: "Only the team's lead, or the president for exec tasks, can approve it or send it back.",
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'task.choice-not-yours': {
    title: "This choice isn't yours",
    detail: 'Only the person who posted the update can choose its task.',
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'task.choice-gone': {
    title: 'This choice has expired',
    detail: 'The update was already recorded, or it is too old to place.',
    next: 'Reply to the task card again if it still needs recording.',
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'task.pick-from-list': {
    title: 'Choose a task from the list',
    detail: "That choice didn't match one of your open tasks.",
    next: 'Run /task complete again.',
    retryable: true,
    tone: 'hold',
    audience: 'member',
  },
  'command.unknown': {
    title: "That command isn't available",
    detail: "Bananasaurs doesn't recognise it.",
    next: 'Use /task list or /task complete.',
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
} as const satisfies Record<string, ErrorCopy>;

export type ErrorCode = keyof typeof ERROR_COPY;
```

- [ ] **Step 3: Write `packages/core/src/ui/discord/common-cards.ts`**

```ts
import { ERROR_COPY, type ErrorCode, type ErrorCopy } from '../../copy/errors.js';
import { card, type CardMessage } from './card.js';
import { text, type ContainerChild } from './kit.js';
import { escapeText, subtext, truncate } from './text.js';
import { ICON, type IconName, type Tone } from './tokens.js';

const QUOTE_MAX = 1500;

/** A private error card: title, rule, next step, optional quoted input and Ref (docs/28 §3). */
export const errorCard = (
  code: ErrorCode,
  options: { quote?: string; ref?: string } = {},
): CardMessage => {
  const entry: ErrorCopy = ERROR_COPY[code];
  const lines = [`**${entry.tone === 'danger' ? ICON.error : ICON.stop} ${entry.title}**`, entry.detail];
  if (entry.next !== undefined) lines.push(`${ICON.hint} ${entry.next}`);
  const children: ContainerChild[] = [text(lines.join('\n'))];
  if (options.quote !== undefined && options.quote.trim().length > 0)
    children.push(
      text(
        escapeText(truncate(options.quote.trim(), QUOTE_MAX))
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n'),
      ),
    );
  if (options.ref !== undefined) children.push(text(subtext(`Ref ${options.ref}`)));
  return card({ tone: entry.tone, children });
};

/** A private "here is what your click did" card. */
export const resultCard = (options: {
  icon: IconName;
  title: string;
  detail?: string;
  tone: Tone;
}): CardMessage => {
  const lines = [`**${ICON[options.icon]} ${options.title}**`];
  if (options.detail !== undefined) lines.push(options.detail);
  return card({ tone: options.tone, children: [text(lines.join('\n'))] });
};
```

Add `export * from './common-cards.js';` to `packages/core/src/ui/discord/index.ts`, and
`export { ERROR_COPY, type CopyAudience, type ErrorCode, type ErrorCopy } from './copy/errors.js';` to
`packages/core/src/index.ts`.

- [ ] **Step 4: Run, gate, commit**

```bash
npx vitest run packages/core/src/copy packages/core/src/ui/discord
npm run typecheck
npm run lint
npm run test
git add packages/core
git commit -m "P1 Task 6: error catalogue (task entries) and private result/error cards"
```

---

### Task 7: Task card renderers

**Files:**
- Modify: `packages/core/src/task/components.ts` (custom ids `start` and `update`)
- Create: `packages/core/src/task/cards.ts`, `packages/core/src/task/cards.test.ts`
- Modify: `packages/core/src/index.ts` (export renderers and view types)
- Test: `packages/core/src/task/components.test.ts`

**Interfaces:**
- Produces (exact names; Tasks 8–12 call them):
  - `ParsedTaskCustomId` gains `{ action: 'start'; taskId: string; version: number }` and
    `{ action: 'update'; taskId: string }`
  - `type TaskStatus`, `type TaskAudience`, `interface TaskCardView` and the other view interfaces
    exactly as written in Step 3
  - `renderTaskCard`, `renderUpdateCard`, `renderReviewRequestCard`, `renderReviewDecisionCard`,
    `renderReminderCard`, `renderCheckinCard`, `renderDigestCard`, `renderPickCard`, `renderClarifyCard`,
    `renderTaskListCard`, `renderCompletePickerCard`, each returning `CardMessage`
  - `buildUpdateModal(taskId: string, taskTitle: string | undefined): Modal`
  - `actorLabel(id: string): string` (a mention for a snowflake, otherwise `an organiser`)
- Consumes: the kit (Task 1), `buildTaskCustomId` (this task).

- [ ] **Step 1: Custom ids — failing test, then implementation**

Append to `components.test.ts`:

```ts
it('round-trips the start and update custom ids', () => {
  const taskId = '00000000-0000-4000-8000-000000000001';
  const start = buildTaskCustomId({ action: 'start', taskId, version: 3 });
  expect(start).toBe(`bs.task:start:${taskId}:3`);
  expect(parseTaskCustomId(start)).toEqual({ action: 'start', taskId, version: 3 });
  const update = buildTaskCustomId({ action: 'update', taskId });
  expect(update).toBe(`bs.task:update:${taskId}`);
  expect(parseTaskCustomId(update)).toEqual({ action: 'update', taskId });
  expect(parseTaskCustomId(`bs.task:update:${taskId}:extra`)).toBeUndefined();
  expect(parseTaskCustomId('bs.task:start:not-a-uuid:1')).toBeUndefined();
});
```

In `components.ts`, extend the `ParsedTaskCustomId` union with the two shapes, and add to
`buildTaskCustomId`:

```ts
    case 'start':
      return `${TASK_CUSTOM_ID_PREFIX}:start:${p.taskId}:${p.version}`;
    case 'update':
      return `${TASK_CUSTOM_ID_PREFIX}:update:${p.taskId}`;
```

In the parser's transform, before the final `return fail(...)`:

```ts
    if (action === 'start') {
      if (parts.length !== 4) return fail('not a Bananasaurs task custom id');
      const taskId = parts[2] ?? '';
      if (!uuidSchema.safeParse(taskId).success) return fail('task id is not a UUID');
      const version = versionSchema.safeParse(parts[3] ?? '');
      if (!version.success) return fail('version out of range');
      return { action: 'start' as const, taskId, version: version.data };
    }
    if (action === 'update') {
      if (parts.length !== 3) return fail('not a Bananasaurs task custom id');
      const taskId = parts[2] ?? '';
      if (!uuidSchema.safeParse(taskId).success) return fail('task id is not a UUID');
      return { action: 'update' as const, taskId };
    }
```

Run `npx vitest run packages/core/src/task/components.test.ts` and expect PASS.

- [ ] **Step 2: Renderers — failing tests**

`packages/core/src/task/cards.test.ts`:

```ts
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
    expect(t).toContain(`Marked done by <@${MAYA}> · <@&${ROLE}> please review`);
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
```

Run: `npx vitest run packages/core/src/task/cards.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Write `packages/core/src/task/cards.ts`**

```ts
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
  return eyebrow(icon, kind, `${teamText(v.teamName)}${v.priority === 'urgent' ? ' · URGENT' : ''}`);
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
      text(`${eyebrow(ICON.update, 'UPDATE', teamText(view.teamName))}\n${titleLine(view.taskTitle)}`),
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
    view.reviewerRoleId === undefined ? '' : ` · ${mentionRole(view.reviewerRoleId)} please review`
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
        customId: buildTaskCustomId({ action: 'approve', taskId: view.taskId, version: view.version }),
        label: 'Approve',
        emoji: ICON.done,
        style: 'success',
      }),
      button({
        customId: buildTaskCustomId({ action: 'reject', taskId: view.taskId, version: view.version }),
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

const listItems = (
  items: readonly DigestItem[],
  max: number,
  render: (item: DigestItem) => string,
): string => {
  const shown = items.slice(0, max).map((i) => `- ${render(i)}`);
  if (items.length > max) shown.push(`- and ${items.length - max} more`);
  return shown.join('\n');
};

export interface CheckinCardView {
  readonly teamName: string;
  readonly items: readonly DigestItem[];
  readonly pingUsers: readonly string[];
  readonly pingRoles: readonly string[];
}

export const renderCheckinCard = (view: CheckinCardView): CardMessage =>
  card({
    tone: 'accent',
    children: [
      section(
        [
          text(
            `${eyebrow(ICON.checkin, 'WEEKLY CHECK-IN', teamText(view.teamName))}\n**How are these going?**`,
          ),
          text("Reply to this card with an update, or use Post update on the task's own card."),
        ],
        thumb(),
      ),
      text(
        listItems(
          view.items,
          10,
          (i) => `**${escapeInline(truncate(i.title, 120))}** · due ${ts(i.dueAt, 'R')} · ${i.who}`,
        ),
      ),
    ],
    art: ['saurThumb'],
    pingUsers: view.pingUsers,
    pingRoles: view.pingRoles,
  });

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
  const line = (i: DigestItem) =>
    `${escapeInline(truncate(i.title, 120))} · ${i.who} · ${ts(i.dueAt, 'R')}`;
  if (view.overdue.length > 0)
    children.push(text(`**${ICON.overdue} Overdue**\n${listItems(view.overdue, 6, line)}`));
  if (view.dueThisWeek.length > 0)
    children.push(text(`**${ICON.due} Due this week**\n${listItems(view.dueThisWeek, 6, line)}`));
  if (view.later.length > 0) children.push(text(`**Later**\n${listItems(view.later, 6, line)}`));
  if (view.doneThisWeek.length > 0) {
    const shown = view.doneThisWeek.slice(0, 8).map((t) => escapeInline(truncate(t, 80)));
    const more = view.doneThisWeek.length > 8 ? `, and ${view.doneThisWeek.length - 8} more` : '';
    children.push(text(`**${ICON.done} Done this week**\n${shown.join(', ')}${more}`));
  }
  if (
    view.overdue.length + view.dueThisWeek.length + view.later.length + view.doneThisWeek.length ===
    0
  )
    children.push(text('No open tasks.'));
  children.push(text(subtext('Posted every Monday · Use /task list to see yours')));
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
          maxLength: 1000,
        }),
      }),
      label({
        label: 'Anything blocking you? (optional)',
        component: textInput({
          customId: 'blocker',
          style: 'short',
          required: false,
          maxLength: 200,
          placeholder: 'e.g. waiting on parts',
        }),
      }),
    ],
  });
```

Export everything public in this file from `packages/core/src/index.ts`. Use a named export list next to
the existing `./task/components.js` exports, including the `type` exports for every `*View` interface,
`TaskStatus` and `TaskAudience`.

- [ ] **Step 4: Run the renderer tests until they pass**

Run: `npx vitest run packages/core/src/task/cards.test.ts`
Expected: PASS. Where a test and the code disagree about **copy**, the test is the spec: change the
code.

- [ ] **Step 5: Gates and commit**

```bash
npm run typecheck
npm run lint
npm run test
git add packages/core
git commit -m "P1 Task 7: task card renderers, start/update custom ids, update modal"
```

---

### Task 8: Daemon — art, task views, the announce card and the refresh pass

**Files:**
- Create: `apps/daemon/src/cards/art.ts`, `apps/daemon/src/cards/art.test.ts`
- Create: `apps/daemon/src/cards/task-view.ts`, `apps/daemon/src/cards/task-view.test.ts`
- Create: `apps/daemon/src/jobs/task-cards.ts`, `apps/daemon/src/jobs/task-cards.test.ts`
- Modify: `apps/daemon/src/jobs/task-nudges.ts` (the `announce` arm sends the card)
- Modify: `apps/daemon/src/jobs/task-nudges.test.ts` (announce assertions)
- Modify: `apps/daemon/src/runtime/daemon.ts` (call the refresh pass in `nudgePass`)

**Interfaces:**
- Produces:
  - `loadArt(key: ArtKey): OutgoingFile`, `cardOut(message: CardMessage): OutgoingMessage`
  - `audienceFor(scope: GuildScope, task: { taskId: string; assignmentKind: string }, team: { memberRoleId: string | null } | undefined): TaskAudience`
  - `taskCardView(scope: GuildScope, taskId: string, now: number, variant: 'announce' | 'refresh'): TaskCardView | undefined`
  - `refreshTaskCards(scope: GuildScope, discord: DiscordPort, now: number, options: { enabled: boolean; logger?: Logger; limit?: number }): Promise<number>`
  - `refreshOneTaskCard(scope: GuildScope, discord: DiscordPort, taskId: string, now: number, options: { enabled: boolean; logger?: Logger }): Promise<void>`
- Consumes: Tasks 1, 2, 4 and 7.

- [ ] **Step 1: Art loader — test, then code**

`apps/daemon/src/cards/art.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ART, type ArtKey } from '@bananasaurs/core';
import { loadArt } from './art.js';

describe('loadArt', () => {
  it.each(Object.keys(ART) as ArtKey[])('loads %s as a PNG with its alt text', (key) => {
    const file = loadArt(key);
    expect(file.name).toBe(ART[key].file);
    expect(file.contentType).toBe('image/png');
    expect([...file.data.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(file.description).toBe(ART[key].alt);
    expect(file.data.length).toBeLessThan(80_000);
  });
  it('returns the same object on a second call (loaded once)', () => {
    expect(loadArt('saurThumb')).toBe(loadArt('saurThumb'));
  });
});
```

`apps/daemon/src/cards/art.ts`:

```ts
import { readFileSync } from 'node:fs';
import {
  ART,
  toOutgoingMessage,
  type ArtKey,
  type CardMessage,
  type OutgoingFile,
  type OutgoingMessage,
} from '@bananasaurs/core';

/** `apps/daemon/assets/cards/`, from both `src/cards/` and `dist/cards/`. */
const ASSET_DIR = new URL('../../assets/cards/', import.meta.url);
const cache = new Map<ArtKey, OutgoingFile>();

/** Card art bytes (ADR 0140 decision 4), read once per process. */
export const loadArt = (key: ArtKey): OutgoingFile => {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const entry = ART[key];
  const file: OutgoingFile = {
    name: entry.file,
    contentType: 'image/png',
    data: new Uint8Array(readFileSync(new URL(entry.file, ASSET_DIR))),
    description: entry.alt,
  };
  cache.set(key, file);
  return file;
};

/** A card as a port message, with its art attached. */
export const cardOut = (message: CardMessage): OutgoingMessage =>
  toOutgoingMessage(message, loadArt);
```

`OutgoingFile` and `OutgoingMessage` must be exported from `@bananasaurs/core`. If `OutgoingFile` isn't,
add it to the existing `./discord/port.js` export list. Run the test and expect PASS. The four PNGs are
already committed in `apps/daemon/assets/cards/` (rendered by `docs/design/card-art/render.py`). Don't
regenerate them.

- [ ] **Step 2: Task view — test, then code**

`apps/daemon/src/cards/task-view.test.ts` uses the migrated test database the daemon's other job tests
use (`rg -n "openMigratedTestDatabase" apps/daemon/src` shows the import). Seed:

- a team **with** `memberRoleId` and a team task
- a team **without** a member role and a team task
- an individual task with two assignees and two links, a report, and a `setStatus(...'in_progress'...)`
  by a member actor
- an archived task

Assert:

- the team task's audience is `{ kind: 'role', roleId }`, or `{ kind: 'team' }` when the team has no role
- the individual task's audience is `{ kind: 'users', userIds: [both, in order] }`
- `links` come back in order, `lastUpdate` is the newest report, and `pickedUp.userId` is the member
- the archived task returns `undefined`

`apps/daemon/src/cards/task-view.ts`:

```ts
import type { TaskAudience, TaskCardView, TaskStatus } from '@bananasaurs/core';
import { taskRepo, type GuildScope } from '@bananasaurs/storage';

/** Who a task is for: its assignees, its team's member role, or the whole team without a ping. */
export const audienceFor = (
  scope: GuildScope,
  task: { taskId: string; assignmentKind: string },
  team: { memberRoleId: string | null } | undefined,
): TaskAudience => {
  if (task.assignmentKind === 'individual')
    return { kind: 'users', userIds: taskRepo.listTaskAssignees(scope, task.taskId) };
  return team?.memberRoleId ? { kind: 'role', roleId: team.memberRoleId } : { kind: 'team' };
};

/** Everything `renderTaskCard` needs, or undefined when the task has no card to show. */
export const taskCardView = (
  scope: GuildScope,
  taskId: string,
  now: number,
  variant: 'announce' | 'refresh',
): TaskCardView | undefined => {
  const task = taskRepo.getTask(scope, taskId);
  if (!task || task.archivedAt !== null) return undefined;
  const team = taskRepo.listTeams(scope).find((t) => t.teamId === task.teamId);
  if (!team) return undefined;
  const reports = taskRepo.listReports(scope, taskId);
  const latest = reports.reduce<(typeof reports)[number] | undefined>(
    (best, r) => (best === undefined || r.createdAt > best.createdAt ? r : best),
    undefined,
  );
  const pickup = taskRepo.lastPickup(scope, taskId);
  return {
    taskId,
    version: task.version,
    title: task.title,
    description: task.description,
    teamName: team.name,
    status: task.status as TaskStatus,
    priority: task.priority === 'urgent' ? 'urgent' : 'normal',
    dueAt: task.dueAt,
    now,
    audience: audienceFor(scope, task, team),
    links: taskRepo.listTaskLinks(scope, taskId),
    ...(pickup === undefined ? {} : { pickedUp: { userId: pickup.actorId, at: pickup.at } }),
    ...(latest === undefined
      ? {}
      : { lastUpdate: { authorId: latest.authorId, at: latest.createdAt, body: latest.body } }),
    updatedAt: task.updatedAt,
    variant,
  };
};
```

- [ ] **Step 3: The announce arm sends the card**

In `apps/daemon/src/jobs/task-nudges.ts`, in the `slot.kind === 'announce'` arm, replace everything from
`const mentions = mentionsFor(scope, task, team);` to the end of that arm's `try/catch` with:

```ts
    const view = taskCardView(scope, task.taskId, now, 'announce');
    if (view === undefined) {
      repo.settle(scope, slot.slotId, 'superseded', now);
      return;
    }
    try {
      const ref = await discord.sendMessage(
        scope.guildId,
        parseSnowflakeId(target),
        cardOut(renderTaskCard(view)),
      );
      repo.settle(scope, slot.slotId, 'sent', now, target, ref.messageId);
      taskRepo.recordTaskAnchor(scope, task.taskId, target, ref.messageId, now);
      taskRepo.markCardRendered(scope, task.taskId, view.version, now);
    } catch {
      fail(target);
    }
    return;
```

Import `renderTaskCard` from `@bananasaurs/core`, `cardOut` from `../cards/art.js`, and `taskCardView` from
`../cards/task-view.js`.

In `apps/daemon/src/jobs/task-nudges.test.ts`, update every announce test that asserted on the old
`content` string (`New task: **…**`). It now asserts that the sent message has:

- `flags: 32768`
- a `files` entry named `saur-thumb.png`
- component text containing `NEW TASK` and the title
- pings in `allowedMentions.users` / `roles`, exactly as before

Keep every assertion about settling, pausing, planning mode and which ids are pinged.

- [ ] **Step 4: The refresh pass — failing tests**

`apps/daemon/src/jobs/task-cards.test.ts` builds the fixtures the task-nudges tests use: a migrated test
database, a `FakeDiscord` scoped to the guild, a team, a task, and a bot-authored message the anchor
points at. Seed the message the way the nudges tests do, or call `sendMessage` on the fake and use the
ref it returns. Cases:

1. **Refreshes a stale card.** After `setStatus(... 'in_progress' ...)`,
   `refreshTaskCards(scope, fake, now, { enabled: true })` returns 1. `fake.restCalls('editMessage')` has
   one call; its message has `flags: 32768` and component text containing `IN PROGRESS`. A second pass
   returns 0.
2. **Planning mode.** With `enabled: false` it returns 0 and makes no `editMessage` call.
3. **A gone message stops retrying.** Make `editMessage` fail once with
   `new DiscordApiError(404, DiscordErrorCode.UnknownMessage, 'Unknown Message')`, using the fake's own
   failure-injection API (read how other tests make a port method fail once). The pass makes one call,
   and the next pass makes **no** call.
4. **A transient failure retries.** With `new DiscordApiError(500, undefined, 'boom')`, the next pass edits
   the card.
5. **Limit.** With 12 stale anchors and `limit: 10`, one pass edits exactly 10.
6. **Converts a legacy post.** An anchor never marked rendered (`rendered_version = 0`) on an open task is
   edited into a card. The same anchor on a done task is not.
7. **A report refreshes.** `recordReport(...)` with no status change makes the card stale, and the edited
   card's text contains `Last update`.

- [ ] **Step 5: Implement `apps/daemon/src/jobs/task-cards.ts`**

```ts
import {
  DiscordApiError,
  renderTaskCard,
  safeLogFields,
  type DiscordPort,
  type Logger,
} from '@bananasaurs/core';
import { taskRepo, type GuildScope } from '@bananasaurs/storage';
import { cardOut } from '../cards/art.js';
import { taskCardView } from '../cards/task-view.js';

const PER_PASS = 10;

type Outcome = 'edited' | 'given-up' | 'retry';

/** Edit one anchored card to match its task. */
const refresh = async (
  scope: GuildScope,
  discord: DiscordPort,
  stale: { taskId: string; channelId: string; messageId: string; version: number },
  now: number,
  logger: Logger | undefined,
): Promise<Outcome> => {
  const view = taskCardView(scope, stale.taskId, now, 'refresh');
  if (view === undefined) {
    taskRepo.markCardRendered(scope, stale.taskId, stale.version, now);
    return 'given-up';
  }
  try {
    await discord.editMessage(
      scope.guildId,
      { channelId: stale.channelId, messageId: stale.messageId },
      cardOut(renderTaskCard(view)),
    );
    taskRepo.markCardRendered(scope, stale.taskId, view.version, now);
    return 'edited';
  } catch (err) {
    if (err instanceof DiscordApiError && (err.isGone || err.isPermissionDenied)) {
      // The card is gone or out of reach; retrying every minute would never succeed.
      taskRepo.markCardRendered(scope, stale.taskId, view.version, now);
      logger?.info(
        safeLogFields({ component: 'task-cards', guildId: scope.guildId, outcome: 'given-up' }),
        'task card could not be edited; not retrying this version',
      );
      return 'given-up';
    }
    logger?.warn(
      safeLogFields({ component: 'task-cards', guildId: scope.guildId, err }),
      'task card refresh failed; retrying next pass',
    );
    return 'retry';
  }
};

/**
 * ADR 0140 decision 5: bring anchored task cards up to date, at most `limit`
 * per pass. Planning mode (task posts off) edits nothing.
 */
export async function refreshTaskCards(
  scope: GuildScope,
  discord: DiscordPort,
  now: number,
  options: { enabled: boolean; logger?: Logger; limit?: number },
): Promise<number> {
  if (!options.enabled) return 0;
  let edited = 0;
  for (const stale of taskRepo.staleTaskCards(scope, options.limit ?? PER_PASS))
    if ((await refresh(scope, discord, stale, now, options.logger)) === 'edited') edited += 1;
  return edited;
}

/** Refresh one task's card now (after a button click) instead of on the next pass. */
export async function refreshOneTaskCard(
  scope: GuildScope,
  discord: DiscordPort,
  taskId: string,
  now: number,
  options: { enabled: boolean; logger?: Logger },
): Promise<void> {
  if (!options.enabled) return;
  const anchor = taskRepo.anchorFor(scope, taskId);
  const task = taskRepo.getTask(scope, taskId);
  if (anchor === undefined || !task) return;
  await refresh(scope, discord, { taskId, ...anchor, version: task.version }, now, options.logger);
}
```

`safeLogFields` is used with `component`, `guildId`, `outcome` and `err` elsewhere in the daemon. Don't
add other field names.

- [ ] **Step 6: Wire it into the 60-second pass**

In `apps/daemon/src/runtime/daemon.ts`, in `nudgePass`, directly after the `await deliverTaskNudges(…)`
call inside the per-guild `try`:

```ts
          await refreshTaskCards(scope, discord, now(), {
            enabled: taskPostsEnabledFor(scope, config.BANANASAURS_DRY_RUN),
            logger,
          });
```

Import `refreshTaskCards` from `../jobs/task-cards.js`.

- [ ] **Step 7: Gates and commit**

```bash
npx vitest run apps/daemon/src/cards apps/daemon/src/jobs
npm run typecheck
npm run lint
npm run test
git add apps/daemon
git commit -m "P1 Task 8: art loader, task card views, announce card, card refresh pass"
```

---

### Task 9: The **I'm on it** button

**Files:**
- Modify: `packages/core/src/task/commands.ts` (deps `startTask`, `refreshTaskCard`; the `start` branch)
- Modify: `packages/core/src/task/commands.test.ts` (harness gains the new deps; new tests)
- Modify: `apps/daemon/src/runtime/guild.ts` (wire `startTask`, `refreshTaskCard`, and the responder's
  `deferUpdate` / `showModal` if Task 2 didn't already)
- Test: a daemon-level test next to the existing task interaction tests (find them with
  `rg -n "bs.task:approve" apps/daemon/src --glob '*.test.ts'`)

**Interfaces:**
- Consumes: `parseTaskCustomId` `start` (Task 7), `errorCard` (Task 6), `toOutgoingMessage` (Task 2),
  `SlashResponder.deferUpdate` (Task 2), `refreshOneTaskCard` (Task 8), `taskRepo.setStatus`.
- Produces on `TaskCommandDeps`:
  - `startTask(userId: string, taskId: string, version: number): Promise<'started' | 'not-yours' | 'stale' | 'not-open'>`
  - `refreshTaskCard(taskId: string): Promise<void>`

- [ ] **Step 1: Write the failing core tests**

In `packages/core/src/task/commands.test.ts`, extend `baseDeps()` with:

```ts
  const deferUpdate = vi.fn(async (): Promise<void> => undefined);
  const showModal = vi.fn(async (): Promise<void> => undefined);
  const startTask = vi.fn(
    async (): Promise<'started' | 'not-yours' | 'stale' | 'not-open'> => 'started',
  );
  const refreshTaskCard = vi.fn(async (): Promise<void> => undefined);
```

Add them to the returned harness: `deferUpdate` and `showModal` inside `responder`, `startTask` and
`refreshTaskCard` at the top level. Add `taskTitle` and `postUpdate` too, as stubs (Task 10 uses them):

```ts
  const taskTitle = vi.fn((): string | undefined => 'Wire the brake light harness');
  const postUpdate = vi.fn(
    async (): Promise<{
      outcome: 'recorded' | 'duplicate' | 'not-yours' | 'not-open';
      postsOn: boolean;
    }> => ({ outcome: 'recorded', postsOn: true }),
  );
```

Then add:

```ts
describe("I'm on it", () => {
  const start = () =>
    interactionEvent(buildTaskCustomId({ action: 'start', taskId: UUID_A, version: 2 }));

  it('acknowledges with a deferred update, starts the task and refreshes its card', async () => {
    const h = baseDeps();
    await createTaskCommandSubscriber(h.deps).handle(start());
    expect(h.deferUpdate).toHaveBeenCalledTimes(1);
    expect(h.defer).not.toHaveBeenCalled();
    expect(h.startTask).toHaveBeenCalledWith(USER, UUID_A, 2);
    expect(h.refreshTaskCard).toHaveBeenCalledWith(UUID_A);
    expect(h.sent).toEqual([]);
  });

  it.each([
    ['not-yours', "This task isn't yours to pick up"],
    ['not-open', 'This task is closed'],
  ] as const)('%s: a private error card and no refresh', async (outcome, title) => {
    const h = baseDeps();
    h.startTask.mockResolvedValueOnce(outcome);
    await createTaskCommandSubscriber(h.deps).handle(start());
    expect(h.refreshTaskCard).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.flags).toBe(1 << 15);
    expect(JSON.stringify(h.sent[0]?.components)).toContain(title);
  });

  it('stale: refreshes the card and says so privately', async () => {
    const h = baseDeps();
    h.startTask.mockResolvedValueOnce('stale');
    await createTaskCommandSubscriber(h.deps).handle(start());
    expect(h.refreshTaskCard).toHaveBeenCalledWith(UUID_A);
    expect(JSON.stringify(h.sent[0]?.components)).toContain('This card was out of date');
  });

  it('a failure while starting reports "Couldn\'t update the task"', async () => {
    const h = baseDeps();
    h.startTask.mockRejectedValueOnce(new Error('db'));
    await createTaskCommandSubscriber(h.deps).handle(start());
    expect(JSON.stringify(h.sent[0]?.components)).toContain("Couldn't update the task");
  });

  it('does nothing else when the acknowledgement itself fails', async () => {
    const h = baseDeps();
    h.deferUpdate.mockRejectedValueOnce(new Error('expired'));
    await createTaskCommandSubscriber(h.deps).handle(start());
    expect(h.startTask).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
  });
});
```

Adapt the harness field names (`h.defer`, `h.sent`, `h.deps`) to what `baseDeps()` really returns. Read
its `return` statement first.

Run: `npx vitest run packages/core/src/task/commands.test.ts`. Expected: FAIL.

- [ ] **Step 2: Implement in `packages/core/src/task/commands.ts`**

Add to `TaskCommandDeps`:

```ts
  /** ADR 0140: move a not-started task to In progress for this member, compare-and-swap on version. */
  readonly startTask: (
    userId: string,
    taskId: string,
    version: number,
  ) => Promise<'started' | 'not-yours' | 'stale' | 'not-open'>;
  /** Re-render the task's anchored card now. Never throws to the caller. */
  readonly refreshTaskCard: (taskId: string) => Promise<void>;
```

Import `errorCard`, `toOutgoingMessage` and `type CardMessage` from `'../ui/discord/index.js'`. Inside
`if (event.kind === 'interaction')`, **directly after** `const ref: InteractionRef = …` and **before** the
existing `try { await deps.responder.defer(…` block, insert:

```ts
      const reply = async (message: CardMessage): Promise<void> => {
        try {
          await deps.responder.respond(ref, toOutgoingMessage(message));
        } catch {
          // The token may have expired; nothing more can be said to the member.
        }
      };
      const refreshCard = async (taskId: string): Promise<void> => {
        try {
          await deps.refreshTaskCard(taskId);
        } catch {
          // The 60-second refresh pass will catch up.
        }
      };

      if (parsed.action === 'start') {
        try {
          await deps.responder.deferUpdate(ref);
        } catch {
          return;
        }
        try {
          const outcome = await deps.startTask(event.userId, parsed.taskId, parsed.version);
          if (outcome === 'started') {
            await refreshCard(parsed.taskId);
            return;
          }
          if (outcome === 'stale') {
            await refreshCard(parsed.taskId);
            await reply(errorCard('task.stale'));
            return;
          }
          await reply(errorCard(outcome === 'not-yours' ? 'task.not-yours' : 'task.not-open'));
        } catch {
          await reply(errorCard('task.unavailable'));
        }
        return;
      }
```

Run the core test and expect PASS.

- [ ] **Step 3: Wire the daemon**

In `apps/daemon/src/runtime/guild.ts`, in the `createTaskCommandSubscriber({ … })` call, add:

```ts
      startTask: async (userId, taskId, version) => {
        const task = taskRepo.getTask(scope, taskId);
        if (
          !task ||
          task.archivedAt ||
          task.status === 'done' ||
          task.status === 'awaiting_approval'
        )
          return 'not-open';
        if (task.status === 'in_progress' || task.version !== version) return 'stale';
        const access = await taskMemberAccess(scope, deps.client, discord, userId);
        const onLiveTeam = access.teams.some((team) => team.teamId === task.teamId);
        const allowed =
          onLiveTeam &&
          (task.assignmentKind === 'individual'
            ? taskRepo.isTaskAssignee(scope, taskId, userId) && access.onTeam(task.teamId)
            : access.onTeam(task.teamId));
        if (!allowed) return 'not-yours';
        return taskRepo.setStatus(
          scope,
          taskId,
          version,
          'in_progress',
          { actorType: 'member', actorId: userId, via: 'gateway' },
          now(),
        )
          ? 'started'
          : 'stale';
      },
      refreshTaskCard: (taskId) =>
        refreshOneTaskCard(scope, discord, taskId, now(), {
          enabled: taskPostsEnabledFor(scope, config.BANANASAURS_DRY_RUN),
          logger,
        }),
```

Import `refreshOneTaskCard` from `../jobs/task-cards.js` and `taskPostsEnabledFor` from
`./task-posts-gate.js`. Use the logger variable the file already has in that scope. This is the same
authority rule `completeForMember` applies: an individual task needs an assignee who is still on the
team, and a team task needs a team member.

Make sure the `responder` object passed to `createTaskCommandSubscriber` has `deferUpdate` and
`showModal` (Task 2 step 5).

- [ ] **Step 4: Daemon-level test**

Next to the existing task interaction tests, add a test that:

1. seeds a team with a member role, a team task (version 1), its anchor message, and a member holding the
   role on `FakeDiscord`
2. emits `fake.emitInteraction({ customId: 'bs.task:start:<taskId>:1', userId: member, channelId, messageId })`
3. asserts the task is `in_progress` at version 2, `fake.wasUpdateDeferred(id)` is true, and one
   `editMessage` went to the anchor with `IN PROGRESS` in its text (task posts switched on for the guild)
4. emits the same custom id again from a second member and asserts their private reply contains
   `This card was out of date` and the version stays 2 (Review Focus 2)
5. emits it from a member not on the team for a fresh task and asserts `This task isn't yours to pick up`

- [ ] **Step 5: Gates and commit**

```bash
npm run typecheck
npm run lint
npm run test
git add packages/core apps/daemon
git commit -m "P1 Task 9: I'm on it button"
```

---

### Task 10: **Post update** — the form, the update card, MCP parity

**Files:**
- Modify: `packages/core/src/task/commands.ts` (deps `taskTitle`, `postUpdate`; `update` button →
  modal; the `modalSubmit` branch)
- Modify: `packages/core/src/task/posts.ts` (`TaskPostKind` gains `'update'`)
- Create: `apps/daemon/src/jobs/task-update-slot.ts` (`scheduleUpdatePost`)
- Modify: `apps/daemon/src/jobs/task-nudges.ts` (`update` arm; the `evaluate` payload's optional
  `reportId`)
- Modify: `apps/daemon/src/task-replies.ts` (a reply to an update card counts for its task)
- Modify: `apps/daemon/src/runtime/guild.ts` (wire `taskTitle`, `postUpdate`)
- Modify: `apps/daemon/src/mcp/task-admin-port.ts` (`record_task_progress` schedules the update post)
- Modify: `packages/mcp/src/tools/task-admin.ts`, `packages/mcp/src/tools/task-tools.ts` (descriptions)
- Test: core commands tests, task-nudges tests, task-replies tests, MCP port tests

**Interfaces:**
- Produces:
  - `TaskCommandDeps.taskTitle(taskId: string): string | undefined` (synchronous)
  - `TaskCommandDeps.postUpdate(userId: string, taskId: string, interactionId: string, body: string, blocker: string | undefined): Promise<{ outcome: 'recorded' | 'duplicate' | 'not-yours' | 'not-open'; postsOn: boolean }>`
  - `scheduleUpdatePost(scope: GuildScope, taskId: string, reportId: string, now: number): void`
  - Slot kind `update`, payload `{ reportId: string }`, slot id `update:<reportId>`
  - The evaluate payload accepts an optional `reportId`.
- Consumes: `buildUpdateModal`, `renderUpdateCard` (Task 7), `resultCard`, `errorCard` (Task 6),
  `cardOut` (Task 8), `NudgeKind 'update'` (Task 4).

- [ ] **Step 1: Failing core tests**

```ts
describe('Post update', () => {
  it('opens the form at once, without deferring', async () => {
    const h = baseDeps();
    await createTaskCommandSubscriber(h.deps).handle(
      interactionEvent(buildTaskCustomId({ action: 'update', taskId: UUID_A })),
    );
    expect(h.defer).not.toHaveBeenCalled();
    expect(h.showModal).toHaveBeenCalledTimes(1);
    const modal = h.showModal.mock.calls[0]?.[1] as { custom_id: string; title: string };
    expect(modal.custom_id).toBe(`bs.task:update:${UUID_A}`);
    expect(JSON.stringify(modal)).toContain('Wire the brake light harness');
  });

  const submit = (fields: Record<string, string>, customId = `bs.task:update:${UUID_A}`) => ({
    kind: 'modalSubmit' as const,
    guildId: GUILD,
    receivedAtMs: 1,
    interactionId: '777777777777777777',
    token: 'modal-token',
    channelId: CHANNEL,
    messageId: '666666666666666666',
    userId: USER,
    customId,
    fields,
  });

  it('records the update and confirms privately', async () => {
    const h = baseDeps();
    await createTaskCommandSubscriber(h.deps).handle(submit({ body: 'Left side done', blocker: '' }));
    expect(h.defer).toHaveBeenCalledWith(expect.anything(), { ephemeral: true });
    expect(h.postUpdate).toHaveBeenCalledWith(
      USER,
      UUID_A,
      '777777777777777777',
      'Left side done',
      undefined,
    );
    expect(JSON.stringify(h.sent[0]?.components)).toContain('Update saved');
    expect(JSON.stringify(h.sent[0]?.components)).toContain('posted in the channel');
  });

  it('says nothing was posted when task posts are off', async () => {
    const h = baseDeps();
    h.postUpdate.mockResolvedValueOnce({ outcome: 'recorded', postsOn: false });
    await createTaskCommandSubscriber(h.deps).handle(submit({ body: 'x y z' }));
    expect(JSON.stringify(h.sent[0]?.components)).toContain('nothing was posted');
  });

  it.each(['not-yours', 'not-open'] as const)(
    '%s: not saved, and the text comes back to copy',
    async (outcome) => {
      const h = baseDeps();
      h.postUpdate.mockResolvedValueOnce({ outcome, postsOn: true });
      await createTaskCommandSubscriber(h.deps).handle(
        submit({ body: 'Left side done', blocker: 'connectors' }),
      );
      const json = JSON.stringify(h.sent[0]?.components);
      expect(json).toContain("Your update wasn't saved");
      expect(json).toContain('> Left side done');
      expect(json).toContain('> Blocked: connectors');
    },
  );

  it('ignores a modal that is not a task update', async () => {
    const h = baseDeps();
    await createTaskCommandSubscriber(h.deps).handle(submit({ body: 'x' }, 'bs.mod:warn:1'));
    expect(h.defer).not.toHaveBeenCalled();
    expect(h.postUpdate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement the core side**

In `packages/core/src/task/posts.ts`, widen `TaskPostKind` to
`'announcement' | 'approval request' | 'update'`.

In `packages/core/src/task/commands.ts`:

1. Add to `TaskCommandDeps`:

```ts
  /** The task's title for the update form, or undefined. Synchronous: the form must open within 3 s. */
  readonly taskTitle: (taskId: string) => string | undefined;
  /** ADR 0140 decision 7: authority is checked here, on submit, not when the form opens. */
  readonly postUpdate: (
    userId: string,
    taskId: string,
    interactionId: string,
    body: string,
    blocker: string | undefined,
  ) => Promise<{ outcome: 'recorded' | 'duplicate' | 'not-yours' | 'not-open'; postsOn: boolean }>;
```

2. Import `buildUpdateModal` from `./cards.js` and `resultCard` from `'../ui/discord/index.js'`.
3. In the interaction branch, right after the `start` block from Task 9:

```ts
      if (parsed.action === 'update') {
        try {
          // A modal must be the first response, so no defer and no live check here.
          await deps.responder.showModal(ref, buildUpdateModal(parsed.taskId, deps.taskTitle(parsed.taskId)));
        } catch {
          // Expired or already answered; the member can press the button again.
        }
        return;
      }
```

4. Add a new branch at the end of `handle`, after the `interaction` branch:

```ts
    if (event.kind === 'modalSubmit') {
      const parsed = parseTaskCustomId(event.customId);
      if (parsed === undefined || parsed.action !== 'update') return;
      const ref: InteractionRef = { interactionId: event.interactionId, token: event.token };
      const body = (event.fields['body'] ?? '').trim();
      const blockerRaw = (event.fields['blocker'] ?? '').trim();
      const blocker = blockerRaw === '' ? undefined : blockerRaw;
      const typed = blocker === undefined ? body : `${body}\n\nBlocked: ${blocker}`;
      const reply = async (message: CardMessage): Promise<void> => {
        try {
          await deps.responder.respond(ref, toOutgoingMessage(message));
        } catch {
          // The token may have expired.
        }
      };
      try {
        await deps.responder.defer(ref, { ephemeral: true });
      } catch {
        return;
      }
      try {
        const result = await deps.postUpdate(event.userId, parsed.taskId, event.interactionId, body, blocker);
        if (result.outcome === 'recorded' || result.outcome === 'duplicate') {
          await reply(
            resultCard({
              icon: 'update',
              title: 'Update saved',
              detail: result.postsOn
                ? 'It shows on the task card and is posted in the channel.'
                : 'It is saved on the task. Task posts are turned off, so nothing was posted.',
              tone: 'ok',
            }),
          );
          return;
        }
        await reply(errorCard('task.update-not-saved', { quote: typed }));
      } catch {
        await reply(errorCard('task.unavailable', { quote: typed }));
      }
      return;
    }
```

   `reply` and `CardMessage` are reused from Task 9. If `reply` is defined inside the interaction branch,
   lift it to a small module-level helper that takes `deps` and `ref`.

Run the core tests and expect PASS.

- [ ] **Step 3: The `update` slot — failing daemon tests**

In `apps/daemon/src/jobs/task-nudges.test.ts`, add:

1. **Posts the update card as a reply to the task card.** Seed an anchored task and a report
   `modal:900000000000000001`, then call `scheduleUpdatePost(scope, taskId, 'modal:900000000000000001', now)`
   and run `deliverTaskNudges` with `enabled: true`. Exactly one `sendMessage` goes to the task's
   destination, with `flags: 32768`, `replyTo` = the anchor message id, text containing `UPDATE` and the
   report body, and `allowedMentions` `{ parse: [] }`. The slot is `sent`. A slot
   `evaluate:<sent message id>` now exists with payload `reportId: 'modal:900000000000000001'`.
2. **An MCP report is posted but not evaluated.** For report id `mcp:<uuid>`, nothing schedules an
   `evaluate:` slot.
3. **Planning mode.** With `enabled: false` the slot settles `planned` and nothing is sent (Review Focus 5).
4. **Gone report.** If the report was deleted before delivery, the slot settles `superseded`.
5. **Evaluation finds a modal report.** An evaluate slot with payload
   `{ taskId, channelId, messageId: <update card id>, reportId: 'modal:…' }` finds the report, which it
   does through `reportId`.

- [ ] **Step 4: Implement the daemon side**

`apps/daemon/src/jobs/task-update-slot.ts`:

```ts
import { taskNudgeRepo, type GuildScope } from '@bananasaurs/storage';

/** ADR 0140: post a recorded update to the task's channel on the next worker pass. Idempotent per report. */
export const scheduleUpdatePost = (
  scope: GuildScope,
  taskId: string,
  reportId: string,
  now: number,
): void => {
  taskNudgeRepo.schedule(
    scope,
    {
      slotId: `update:${reportId}`,
      kind: 'update',
      taskId,
      dueAt: now,
      payload: JSON.stringify({ reportId }),
    },
    now,
  );
};
```

In `apps/daemon/src/jobs/task-nudges.ts`:

1. Extend `EvaluatePayload` with `readonly reportId?: string;`. In `parseEvaluatePayload`, accept an
   optional non-empty string `reportId` and include it when present. In the `evaluate` arm, change the
   report lookup to
   `repo.getReport(scope, payload.taskId, payload.reportId ?? payload.messageId)`.
2. Add a payload parser:

```ts
const parseUpdatePayload = (raw: string | null): { reportId: string } | undefined => {
  const parsed = parseJsonPayload(raw) as { reportId?: unknown } | undefined;
  return parsed && typeof parsed.reportId === 'string' && parsed.reportId !== ''
    ? { reportId: parsed.reportId }
    : undefined;
};
```

3. Add the arm before the final `repo.settle(… 'superseded' …)`:

```ts
  if (slot.kind === 'update') {
    const payload = parseUpdatePayload(slot.payload);
    const report =
      payload && task ? repo.getReport(scope, task.taskId, payload.reportId) : undefined;
    if (!payload || !task || task.archivedAt !== null || !report) {
      repo.settle(scope, slot.slotId, 'superseded', now);
      return;
    }
    const team = teamById.get(task.teamId);
    if (!team) {
      repo.settle(scope, slot.slotId, 'superseded', now);
      return;
    }
    const target = await resolveTarget(task.destinationId, team.categoryId);
    if (target === undefined) return;
    if (!options.enabled) {
      repo.settle(scope, slot.slotId, 'planned', now, target);
      return;
    }
    const anchor = taskRepo.anchorFor(scope, task.taskId);
    try {
      const ref = await discord.sendMessage(
        scope.guildId,
        parseSnowflakeId(target),
        cardOut(
          renderUpdateCard({
            taskTitle: task.title,
            teamName: team.name,
            authorId: report.authorId,
            body: report.body,
            ...(anchor !== undefined && anchor.channelId === target
              ? { replyTo: anchor.messageId }
              : {}),
          }),
        ),
      );
      repo.settle(scope, slot.slotId, 'sent', now, target, ref.messageId);
      // ADR 0112: one evaluation per member update, asked against the posted
      // card so a reply to the question lands on this task. Organiser (MCP)
      // updates are not evaluated.
      if (!payload.reportId.startsWith('mcp:'))
        repo.schedule(
          scope,
          {
            slotId: `evaluate:${ref.messageId}`,
            kind: 'evaluate',
            taskId: task.taskId,
            dueAt: now,
            payload: JSON.stringify({
              taskId: task.taskId,
              channelId: target,
              messageId: ref.messageId,
              reportId: payload.reportId,
            }),
          },
          now,
        );
    } catch {
      fail(target);
    }
    return;
  }
```

   Check that `repo.getReport` exists with that signature (the `evaluate` arm uses it) and that `repo` is
   `taskNudgeRepo`. Import `renderUpdateCard` from `@bananasaurs/core`.

4. `apps/daemon/src/task-replies.ts`: in the `sentSlotForMessage` branch, change
   `(slot.kind === 'pre_due' || slot.kind === 'custom') && slot.taskId` to
   `(slot.kind === 'pre_due' || slot.kind === 'custom' || slot.kind === 'update') && slot.taskId`. Add a
   test in `task-replies.test.ts`: a member reply to a sent `update` slot's message records a report on
   that slot's task.

- [ ] **Step 5: Wire `taskTitle` and `postUpdate`**

In `apps/daemon/src/runtime/guild.ts`, in `createTaskCommandSubscriber({ … })`:

```ts
      taskTitle: (taskId) => taskRepo.getTask(scope, taskId)?.title,
      postUpdate: async (userId, taskId, interactionId, body, blocker) => {
        const postsOn = taskPostsEnabledFor(scope, config.BANANASAURS_DRY_RUN);
        const task = taskRepo.getTask(scope, taskId);
        if (
          !task ||
          task.archivedAt ||
          (task.status !== 'not_started' && task.status !== 'in_progress')
        )
          return { outcome: 'not-open', postsOn };
        const access = await taskMemberAccess(scope, deps.client, discord, userId);
        const onLiveTeam = access.teams.some((team) => team.teamId === task.teamId);
        const allowed =
          onLiveTeam &&
          (task.assignmentKind === 'individual'
            ? taskRepo.isTaskAssignee(scope, taskId, userId) && access.onTeam(task.teamId)
            : access.onTeam(task.teamId));
        if (!allowed) return { outcome: 'not-yours', postsOn };
        const reportId = `modal:${interactionId}`;
        const text = blocker === undefined ? body : `${body}\n\nBlocked: ${blocker}`;
        const at = now();
        const outcome = taskRepo.recordReport(
          scope,
          taskId,
          reportId,
          userId,
          text,
          { actorType: 'member', actorId: userId, via: 'gateway' },
          at,
        );
        if (outcome === 'not-open') return { outcome: 'not-open', postsOn };
        if (outcome === 'recorded') scheduleUpdatePost(scope, taskId, reportId, at);
        return { outcome, postsOn };
      },
```

Import `scheduleUpdatePost` from `../jobs/task-update-slot.js`. The authority check matches Task 9; if
you made it a shared helper there, reuse it.

- [ ] **Step 6: MCP parity**

1. `apps/daemon/src/mcp/task-admin-port.ts`, `record_task_progress` case:

```ts
        case 'record_task_progress': {
          const reportId = `mcp:${a.requestId}`;
          const outcome = taskRepo.recordReport(
            scope,
            a.taskId,
            reportId,
            accountId,
            a.body,
            actor,
            now,
          );
          if (outcome === 'not-open') return refused(NOT_AVAILABLE);
          if (outcome === 'duplicate') return success('Already recorded.');
          scheduleUpdatePost(scope, a.taskId, reportId, now);
          return success(
            `Recorded progress on task ${a.taskId}. ${postsNote(deps, guildId, 'update')}`,
          );
        }
```

2. Change the description text. In `packages/mcp/src/tools/task-admin.ts`,
   `record_task_progress.description` becomes:
   `'Owner or Manage club tasks: record a progress report on an open task. When task posts are on, it is posted to the task\'s channel as an update card within a minute. Retrying with the same requestId is a no-op.'`
   Then `rg -n "does not post" packages/mcp/src` and update any `task_progress` description that still
   says the record is not posted, to the same meaning.
3. Add a port test: `record_task_progress` creates a pending `update:mcp:<requestId>` slot, and a retry
   with the same `requestId` returns `Already recorded.` with no second slot.

- [ ] **Step 7: Gates and commit**

```bash
npm run typecheck
npm run lint
npm run test
git add packages/core packages/mcp apps/daemon
git commit -m "P1 Task 10: Post update form, update card, MCP progress posts the same card"
```

---

### Task 11: Every other task post becomes a card

**Files:**
- Modify: `apps/daemon/src/jobs/task-nudges.ts` (`review`, `pre_due`/`custom`, `checkin`, `digest`,
  `clarify`, `evaluate` arms)
- Modify: `packages/core/src/task/commands.ts` (approve/reject and pick replies and post edits)
- Modify: `packages/core/src/copy/errors.ts` (two entries)
- Modify: `apps/daemon/src/runtime/guild.ts` (`decideReview` returns `teamName`)
- Modify: `packages/core/src/task/components.ts` and `packages/core/src/index.ts` (remove
  `TASK_REPLY_NOTICE`, `buildReviewComponents`, `buildPickComponents`, `buildCompleteSelect` once
  unused)
- Test: `apps/daemon/src/jobs/task-nudges.test.ts`, `packages/core/src/task/commands.test.ts`,
  `packages/core/src/task/components.test.ts`

**Interfaces:**
- Consumes: the renderers (Task 7), `audienceFor`, `cardOut` (Task 8), `errorCard`, `resultCard` (Task 6).
- Changes: `TaskCommandDeps.decideReview` resolves to
  `{ outcome; title?: string; teamName?: string }`.

- [ ] **Step 1: Two new error entries** (append to `ERROR_COPY`)

```ts
  'task.review-stale': {
    title: 'This review is out of date',
    detail: 'The task changed after this review was requested, so a newer review post replaces it.',
    next: 'Use the newest review post for this task.',
    retryable: false,
    tone: 'hold',
    audience: 'member',
  },
  'task.changed': {
    title: 'This task just changed',
    detail: 'Someone edited it while you were choosing.',
    next: 'Run /task complete again.',
    retryable: true,
    tone: 'hold',
    audience: 'member',
  },
```

- [ ] **Step 2: Update the core tests first**

In `commands.test.ts`, change the approve, reject and pick tests so they expect:

- **approve `done`:** a private reply containing `**✅ Approved**`, and an `editBotMessage` whose message
  has `flags: 32768` with text `APPROVED` and `Approved by <@USER>`
- **reject `sent-back`:** a private reply `**↩️ Sent back**` with detail `The task is back in progress.`,
  and an edit with `SENT BACK`
- **`not-authorised`:** the `task.review-not-yours` error card
- **`conflict`:** the `task.review-stale` error card
- **pick `recorded`:** a private reply `**📝 Update recorded**` with detail `On <title>.`, and the
  public pick card edited to the same result card
- **pick `not-yours` / `gone`:** the `task.choice-not-yours` / `task.choice-gone` error cards

Run and watch them fail.

- [ ] **Step 3: Implement the core replies**

In `packages/core/src/task/commands.ts`, replace each `deps.responder.respond(ref, { content: … })` in
the approve/reject/pick paths with `reply(…)` cards, and each `refreshPost({ content: … })` with
`refreshPost(toOutgoingMessage(…))`:

```ts
            if (result.outcome === 'done' || result.outcome === 'sent-back') {
              const approved = result.outcome === 'done';
              await reply(
                approved
                  ? resultCard({ icon: 'done', title: 'Approved', tone: 'ok' })
                  : resultCard({
                      icon: 'sentBack',
                      title: 'Sent back',
                      detail: 'The task is back in progress.',
                      tone: 'progress',
                    }),
              );
              await refreshPost(
                toOutgoingMessage(
                  renderReviewDecisionCard({
                    taskTitle: result.title ?? 'Task',
                    teamName: result.teamName ?? 'Team',
                    decision: approved ? 'approved' : 'sent-back',
                    deciderId: event.userId,
                    at: deps.now(),
                  }),
                ),
              );
              return;
            }
            await reply(
              errorCard(result.outcome === 'not-authorised' ? 'task.review-not-yours' : 'task.review-stale'),
            );
            return;
```

and for pick:

```ts
          if (result.outcome === 'recorded') {
            const done = resultCard({
              icon: 'update',
              title: 'Update recorded',
              detail: `On ${escapeInline(truncate(result.title ?? 'the task', 120))}.`,
              tone: 'ok',
            });
            await reply(done);
            await refreshPost(toOutgoingMessage(done));
            return;
          }
          await reply(errorCard(result.outcome === 'not-yours' ? 'task.choice-not-yours' : 'task.choice-gone'));
```

Import `renderReviewDecisionCard` from `./cards.js`, and `escapeInline`, `truncate` and `resultCard`
from the kit. In `guild.ts`, `decideReview` also returns the team name:
`teamName: taskRepo.listTeams(scope).find((t) => t.teamId === found?.teamId)?.name`. Include it only
when defined.

- [ ] **Step 4: Update the daemon tests first**

In `task-nudges.test.ts`, for each arm, replace assertions on the old `content` strings with card
assertions. Each sent message has `flags: 32768`, plus:

| Arm | Component text contains | Pings | Art |
| --- | --- | --- | --- |
| `review` | `WAITING FOR REVIEW`, `Marked done by` | reviewer role in `allowedMentions.roles` | none; Approve / Send back custom ids for the payload version |
| `pre_due` | `DUE SOON` | assignees or member role, as before | `saur-thumb.png` |
| `custom` | `REMINDER` | as before | `saur-thumb.png` |
| `checkin` | `WEEKLY CHECK-IN`, every listed title | as before, users capped at 50 | `saur-thumb.png` |
| `digest` | `WEEKLY DIGEST`, `Overdue` for an overdue task, `Done this week` for one finished in the last 7 days | none | `banner-digest.png` |
| `clarify` | `Which task is this update for?` | none | none; one button per candidate; `replyTo` the member's message |
| `evaluate` | `QUICK QUESTION` and the question | none | none; `replyTo` the member's message |

No test may still look for `TASK_REPLY_NOTICE` text.

- [ ] **Step 5: Implement the daemon arms**

In `apps/daemon/src/jobs/task-nudges.ts`, keep every guard, settle and pause exactly as it is. Change
only what is sent:

- **review:** latest report body = the newest of `taskRepo.listReports(scope, task.taskId)`.

```ts
      const ref = await discord.sendMessage(
        scope.guildId,
        parseSnowflakeId(target),
        cardOut(
          renderReviewRequestCard({
            taskId: task.taskId,
            version: payload.version,
            taskTitle: task.title,
            teamName: team.name,
            requestedBy: payload.requestedBy,
            ...(role ? { reviewerRoleId: role } : {}),
            ...(latest === undefined ? {} : { latestUpdate: latest.body }),
          }),
        ),
      );
```

- **pre_due / custom:**

```ts
      const ref = await discord.sendMessage(
        scope.guildId,
        parseSnowflakeId(target),
        cardOut(
          renderReminderCard({
            taskId: task.taskId,
            version: task.version,
            taskTitle: task.title,
            teamName: team.name,
            dueAt: task.dueAt,
            now,
            audience: audienceFor(scope, task, team),
            kind: slot.kind,
            status: task.status as TaskStatus,
          }),
        ),
      );
```

- **checkin:** build `items` from `listed`, where each item's `who` is `mentions.text || 'whole team'`
  using the existing `mentionsFor`. Collect `users` and `roles` as today, then send
  `cardOut(renderCheckinCard({ teamName: firstTeam.name, items, pingUsers: users.slice(0, 50), pingRoles: roles }))`.
- **digest:** using `const WEEK = 7 * 86_400_000`:
  - `open` is the team's tasks from `repo.openTasks(scope)` with `status !== 'done'`
  - `overdue` is `open` with `dueAt < now`
  - `dueThisWeek` is `open` with `now <= dueAt < now + WEEK`
  - `later` is the rest of `open`
  - `doneThisWeek` is `taskRepo.listTasks(scope, { teamId: team.teamId, includeDone: true })` filtered to
    `status === 'done' && updatedAt >= now - WEEK`, mapped to titles

  Each item's `who` is `mentionsFor(...).text || 'whole team'`. Send
  `cardOut(renderDigestCard({ teamName: team.name, weekOf: now, overdue, dueThisWeek, later, doneThisWeek }))`.
  Mentions in a digest render as names and never ping: the card's `allowedMentions` is `{ parse: [] }`.
- **clarify:**
  `cardOut(renderPickCard({ choiceMessageId: payload.replyMessageId, candidates: shown.map((t) => ({ taskId: t.taskId, title: t.title })) }))`.
  The card carries `replyTo` itself.
- **evaluate:**
  `cardOut(renderClarifyCard({ question: verdict.question, replyTo: payload.messageId }))`.

Delete `TASK_REPLY_NOTICE`, `safe` and `dueLabel` from this file once nothing uses them. Delete
`TASK_REPLY_NOTICE`, `buildReviewComponents`, `buildPickComponents` and `buildCompleteSelect` from
`packages/core/src/task/components.ts` (keep the custom-id code) and from `packages/core/src/index.ts`
once `rg -n "TASK_REPLY_NOTICE|buildReviewComponents|buildPickComponents|buildCompleteSelect" packages apps`
finds only their own tests. Delete those tests.

- [ ] **Step 6: Gates and commit**

```bash
npm run typecheck
npm run lint
npm run test
git add packages/core apps/daemon
git commit -m "P1 Task 11: review, reminder, check-in, digest, pick and clarify posts become cards"
```

---

### Task 12: `/task list` and `/task complete` replies

**Files:**
- Modify: `packages/core/src/task/commands.ts` (the slash branch and the `complete` select path)
- Test: `packages/core/src/task/commands.test.ts`

**Interfaces:**
- Consumes: `renderTaskListCard`, `renderCompletePickerCard` (Task 7), `resultCard`, `errorCard` (Task 6).

- [ ] **Step 1: Update the tests first**

Every slash reply now has `flags: 32768`. Expect:

| Situation | Reply contains |
| --- | --- |
| `/task list` with rows | `YOUR TASKS · N open`, team names in bold, at most 10 rows, `and N more` past 10 |
| `/task list` empty | `**📋 You have no open tasks**` |
| `/task complete` with items | a select with custom id `bs.task:complete` |
| `/task complete` empty | `**📋 Nothing is ready to complete**` and `You have no open tasks that can go to review.` |
| unknown subcommand | `That command isn't available` |
| a thrown error | `Couldn't update the task` |
| complete select → `awaiting_approval` | `**👀 Sent for review**` and `A lead (or the president for exec tasks) can approve it.` |
| complete select → `already-awaiting` | `**👀 Already waiting for review**` |
| complete select → `not-found` | `This task is closed` |
| complete select → `conflict` | `This task just changed` |
| complete select with a non-uuid value | `Choose a task from the list` |

Replace the old string assertions accordingly. Run and watch them fail.

- [ ] **Step 2: Implement**

In the slash branch, each `deps.responder.respond(ref, { content … })` becomes
`deps.responder.respond(ref, toOutgoingMessage(card))`, with:

- list with rows: `renderTaskListCard({ rows: rows.map((r) => ({ teamName: r.teamName, title: r.title, status: r.status as TaskStatus, dueAt: r.dueAt })), now: deps.now() })`
- list empty: `resultCard({ icon: 'task', title: 'You have no open tasks', tone: 'neutral' })`
- complete with items: `renderCompletePickerCard({ tasks: first })`, where `first` is built as today
- complete empty: `resultCard({ icon: 'task', title: 'Nothing is ready to complete', detail: 'You have no open tasks that can go to review.', tone: 'neutral' })`
- unknown: `errorCard('command.unknown')`
- the two `catch` blocks: `errorCard('task.unavailable')`

In the `complete` select path:

- non-uuid: `errorCard('task.pick-from-list')`
- `awaiting_approval`: `resultCard({ icon: 'review', title: 'Sent for review', detail: 'A lead (or the president for exec tasks) can approve it.', tone: 'hold' })`
- `already-awaiting`: `resultCard({ icon: 'review', title: 'Already waiting for review', tone: 'hold' })`
- `not-found`: `errorCard('task.not-open')`
- `conflict`: `errorCard('task.changed')`

Remove `clean` and `statusLabel` from the file if nothing uses them. Keep `formatDueLabel`: the picker's
`dueLabel` still uses it, and it is exported.

- [ ] **Step 3: Gates and commit**

```bash
npm run typecheck
npm run lint
npm run test
git add packages/core
git commit -m "P1 Task 12: /task list and /task complete reply with cards"
```

---

### Task 13: Dashboard — the links editor

**Files:**
- Create: `packages/dashboard/src/ui/LinkListEditor.tsx`, `packages/dashboard/src/ui/LinkListEditor.test.tsx`
- Modify: `packages/dashboard/src/pages/task-create.tsx`
- Modify: `packages/dashboard/src/pages/task-detail.tsx` (`Task`/`Detail` types gain `links`;
  `EditForm` edits them; the summary shows them)
- Test: `packages/dashboard/src/pages/task-create.test.tsx`, `task-detail.test.tsx`

**Interfaces:**
- Produces:
  - `type LinkRow = { label: string; url: string }`
  - `validateLinks(rows: readonly LinkRow[]): string[]` (one message per row, `''` when the row is fine)
  - `cleanLinks(rows: readonly LinkRow[]): LinkRow[]` (trimmed, fully empty rows dropped)
  - `<LinkListEditor value onChange errors />`
- Consumes: `GET/PUT /api/tasks/:taskId` and `POST /api/tasks` with `links` (Task 5).

This task uses the dashboard's **current** styles (`inputClass`, `Button`). P3 restyles everything, so
don't redesign here.

- [ ] **Step 1: Failing component tests**

`packages/dashboard/src/ui/LinkListEditor.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { cleanLinks, LinkListEditor, validateLinks } from './LinkListEditor.js';

describe('validateLinks', () => {
  it('accepts good rows and ignores fully empty ones', () => {
    expect(validateLinks([{ label: 'Docs', url: 'https://example.com' }, { label: '', url: '' }])).toEqual(['', '']);
  });
  it('names the row and the fix in every message', () => {
    expect(
      validateLinks([
        { label: '', url: 'https://example.com' },
        { label: 'x'.repeat(35), url: 'https://example.com' },
        { label: 'Docs', url: '' },
        { label: 'Docs', url: 'http://example.com' },
        { label: 'Docs', url: `https://e.com/${'a'.repeat(520)}` },
      ]),
    ).toEqual([
      'Enter a label for link 1',
      'Link 2: labels can be 34 characters or fewer',
      'Enter a URL for link 3',
      'Link 4: enter a URL that starts with https://',
      'Link 5: URLs can be 512 characters or fewer',
    ]);
  });
});

describe('cleanLinks', () => {
  it('trims and drops empty rows', () => {
    expect(cleanLinks([{ label: ' Docs ', url: ' https://e.com ' }, { label: ' ', url: '' }])).toEqual([
      { label: 'Docs', url: 'https://e.com' },
    ]);
  });
});

describe('LinkListEditor', () => {
  it('adds rows up to five, then hides Add link', () => {
    const onChange = vi.fn();
    const rows = Array.from({ length: 5 }, () => ({ label: '', url: '' }));
    render(<LinkListEditor value={rows} onChange={onChange} errors={[]} />);
    expect(screen.queryByRole('button', { name: 'Add link' })).toBeNull();
  });
  it('removes a row and shows a row’s error next to it', () => {
    const onChange = vi.fn();
    render(
      <LinkListEditor
        value={[{ label: 'Docs', url: 'http://x' }]}
        onChange={onChange}
        errors={['Link 1: enter a URL that starts with https://']}
      />,
    );
    expect(screen.getByText('Link 1: enter a URL that starts with https://')).toBeTruthy();
    expect(screen.getByLabelText('Link 1 URL').getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Remove link 1' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
```

- [ ] **Step 2: Implement `packages/dashboard/src/ui/LinkListEditor.tsx`**

```tsx
import { Button } from './Button.js';
import { inputClass } from '../lib/task-form.js';

export type LinkRow = { label: string; url: string };

const MAX_LINKS = 5;
const LABEL_MAX = 34;
const URL_MAX = 512;

const isEmpty = (row: LinkRow) => row.label.trim() === '' && row.url.trim() === '';

/** One message per row, '' when the row is fine (docs/28 §3: name the field, say the fix). */
export const validateLinks = (rows: readonly LinkRow[]): string[] =>
  rows.map((row, index) => {
    const n = index + 1;
    if (isEmpty(row)) return '';
    const label = row.label.trim();
    const url = row.url.trim();
    if (label === '') return `Enter a label for link ${n}`;
    if (label.length > LABEL_MAX) return `Link ${n}: labels can be ${LABEL_MAX} characters or fewer`;
    if (url === '') return `Enter a URL for link ${n}`;
    if (url.length > URL_MAX) return `Link ${n}: URLs can be ${URL_MAX} characters or fewer`;
    let ok = false;
    try {
      ok = new URL(url).protocol === 'https:' && url.startsWith('https://');
    } catch {
      ok = false;
    }
    return ok ? '' : `Link ${n}: enter a URL that starts with https://`;
  });

export const cleanLinks = (rows: readonly LinkRow[]): LinkRow[] =>
  rows
    .filter((row) => !isEmpty(row))
    .map((row) => ({ label: row.label.trim(), url: row.url.trim() }));

export function LinkListEditor({
  value,
  onChange,
  errors,
}: {
  value: readonly LinkRow[];
  onChange: (rows: LinkRow[]) => void;
  errors: readonly string[];
}) {
  const set = (index: number, patch: Partial<LinkRow>) =>
    onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <fieldset className="grid gap-2">
      <legend className="font-medium">Links (optional, up to {MAX_LINKS})</legend>
      <p className="text-xs text-ink-muted">
        Each one becomes a button on the task card. Labels can be {LABEL_MAX} characters.
      </p>
      {value.map((row, index) => {
        const n = index + 1;
        const error = errors[index] ?? '';
        const errorId = `link-${n}-error`;
        return (
          <div key={index} className="grid gap-1">
            <div className="grid gap-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto]">
              <input
                aria-label={`Link ${n} label`}
                maxLength={LABEL_MAX}
                value={row.label}
                placeholder="Label"
                onChange={(e) => set(index, { label: e.target.value })}
                aria-invalid={error !== '' ? 'true' : undefined}
                aria-describedby={error !== '' ? errorId : undefined}
                className={inputClass}
              />
              <input
                aria-label={`Link ${n} URL`}
                type="url"
                inputMode="url"
                value={row.url}
                placeholder="https://"
                onChange={(e) => set(index, { url: e.target.value })}
                aria-invalid={error !== '' ? 'true' : undefined}
                aria-describedby={error !== '' ? errorId : undefined}
                className={inputClass}
              />
              <Button onClick={() => onChange(value.filter((_, i) => i !== index))}>
                Remove link {n}
              </Button>
            </div>
            {error !== '' && (
              <p id={errorId} role="alert" className="text-xs text-danger">
                {error}
              </p>
            )}
          </div>
        );
      })}
      {value.length < MAX_LINKS && (
        <Button onClick={() => onChange([...value, { label: '', url: '' }])} className="justify-self-start">
          Add link
        </Button>
      )}
    </fieldset>
  );
}
```

Check that `Button` accepts `onClick` and `className` the way `task-create.tsx` uses it, and that
`text-danger` / `text-ink-muted` exist as Tailwind tokens (they do in `styles.css`).

- [ ] **Step 3: Use it on the create page**

In `packages/dashboard/src/pages/task-create.tsx`:

- state: `const [links, setLinks] = useState<LinkRow[]>([]);` and
  `const [linkErrors, setLinkErrors] = useState<string[]>([]);`
- in `save`, before `setBusy(true)`:

```tsx
    const errors = validateLinks(links);
    setLinkErrors(errors);
    if (errors.some((e) => e !== '')) {
      setError('Fix the links below.');
      return;
    }
```

- in the request body: `...(cleanLinks(links).length > 0 ? { links: cleanLinks(links) } : {}),`
- render `<LinkListEditor value={links} onChange={setLinks} errors={linkErrors} />` after the
  Description field

Add to `task-create.test.tsx`: a create with one valid link sends `links` in the POST body, and an
`http://` link blocks the POST and shows `Link 1: enter a URL that starts with https://`.

- [ ] **Step 4: Edit and show them on the detail page**

In `packages/dashboard/src/pages/task-detail.tsx`:

- add `links: { label: string; url: string }[]` to `Detail` (the route returns it at the top level, next
  to `task`)
- pass `links` into `EditForm` as a prop. Initialise its state from it, validate as on the create page,
  and **always** send `links: cleanLinks(links)` on `PUT`, so removing every link clears them.
- in the task summary, below the description, when there are links, render:

```tsx
            <ul className="flex flex-wrap gap-2" aria-label="Links">
              {detail.links.map((link) => (
                <li key={link.url}>
                  <a href={link.url} target="_blank" rel="noreferrer noopener" className="underline">
                    {link.label} ↗
                  </a>
                </li>
              ))}
            </ul>
```

Add a test to `task-detail.test.tsx` that a detail with two links shows both as links with `↗`, and that
saving the edit form sends `links`.

- [ ] **Step 5: Gates and commit**

```bash
npm run typecheck
npm run lint
npm run test
git add packages/dashboard
git commit -m "P1 Task 13: dashboard links editor on create and edit"
```

---

### Task 14: Card gallery smoke script and docs

**Files:**
- Create: `scripts/card-gallery.mjs`
- Modify: `package.json` (`"smoke:cards": "node --env-file=.env scripts/card-gallery.mjs"`)
- Modify: `docs/SMOKE_TESTS.md` (a "Card gallery (ADR 0140)" section)
- Modify: `docs/STATE.md` (one short entry at the top)
- Modify: the MCP guide text. `rg -n "bananasaurs_guide" packages/mcp/src` finds its source, plus
  `packages/mcp/src/instructions.ts`. Mention links, and that progress records are posted.

**Interfaces:**
- Consumes: the built `packages/core/dist`, `packages/discord/dist/rest`, and
  `apps/daemon/assets/cards/*.png`.

This script is run **by the owner**, never by you. It needs a real token. Write it, check its syntax with
`node --check scripts/card-gallery.mjs`, and do not run it.

- [ ] **Step 1: Write `scripts/card-gallery.mjs`**

```js
// Posts one of every task card to a test channel, for a visual check on
// desktop and mobile, light and dark (ADR 0140, docs/SMOKE_TESTS.md).
//
//   npm run build && npm run smoke:cards -- --channel <channel id>
//
// Owner-run only. Needs DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID and
// TEST_GUILD_ID in .env. Refuses any channel outside TEST_GUILD_ID. Pings
// nobody: every sample is a whole-team task with no role.
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const channelId = args[args.indexOf('--channel') + 1];
if (!args.includes('--channel') || !/^\d{17,20}$/.test(channelId ?? '')) {
  console.error('Usage: npm run smoke:cards -- --channel <channel id>');
  process.exit(2);
}
for (const name of ['DISCORD_BOT_TOKEN', 'DISCORD_APPLICATION_ID', 'TEST_GUILD_ID']) {
  if (!process.env[name]) {
    console.error(`${name} is not set in .env.`);
    process.exit(2);
  }
}

const core = await import('../packages/core/dist/index.js');
const { createDiscordRestPort } = await import('../packages/discord/dist/rest/index.js');
const { REST, Routes } = await import('discord.js');

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
const channel = await rest.get(Routes.channel(channelId));
if (channel.guild_id !== process.env.TEST_GUILD_ID) {
  console.error('That channel is not in TEST_GUILD_ID. Refusing.');
  process.exit(2);
}
const port = createDiscordRestPort({
  rest,
  applicationId: process.env.DISCORD_APPLICATION_ID,
  botUserId: () => process.env.DISCORD_APPLICATION_ID,
});

const ASSETS = new URL('../apps/daemon/assets/cards/', import.meta.url);
const loadArt = (key) => ({
  name: core.ART[key].file,
  contentType: 'image/png',
  data: new Uint8Array(readFileSync(new URL(core.ART[key].file, ASSETS))),
  description: core.ART[key].alt,
});
const send = async (label, card) => {
  const ref = await port.sendMessage(channel.guild_id, channelId, core.toOutgoingMessage(card, loadArt));
  console.log(`posted ${label}`);
  return ref;
};

const now = Date.now();
const DAY = 86_400_000;
const base = {
  taskId: randomUUID(),
  version: 1,
  title: 'Wire the brake light harness',
  description: 'Run the harness from the rear bulkhead to both tail lights. Use 18 AWG and heat-shrink every splice.',
  teamName: 'Card gallery',
  status: 'not_started',
  priority: 'normal',
  dueAt: now + 7 * DAY,
  now,
  audience: { kind: 'team' },
  links: [
    { label: 'Wiring diagram', url: 'https://example.com/wiring' },
    { label: 'BOM sheet', url: 'https://example.com/bom' },
  ],
  updatedAt: now,
  variant: 'announce',
};

const first = await send('new task', core.renderTaskCard(base));
await send('in progress', core.renderTaskCard({ ...base, status: 'in_progress', variant: 'refresh', lastUpdate: { authorId: 'owner', at: now - 60_000, body: 'Left side done, right side tomorrow.' } }));
await send('overdue', core.renderTaskCard({ ...base, status: 'in_progress', dueAt: now - 3 * DAY, variant: 'refresh' }));
await send('waiting for review', core.renderTaskCard({ ...base, status: 'awaiting_approval', variant: 'refresh' }));
await send('done', core.renderTaskCard({ ...base, status: 'done', variant: 'refresh' }));
await send('urgent', core.renderTaskCard({ ...base, priority: 'urgent' }));
await send('update', core.renderUpdateCard({ taskTitle: base.title, teamName: base.teamName, authorId: 'owner', body: 'Left side done.\n\nBlocked: waiting on connectors', replyTo: first.messageId }));
await send('review request', core.renderReviewRequestCard({ taskId: base.taskId, version: 1, taskTitle: base.title, teamName: base.teamName, requestedBy: 'owner', latestUpdate: 'Both lights work.' }));
await send('approved', core.renderReviewDecisionCard({ taskTitle: base.title, teamName: base.teamName, decision: 'approved', deciderId: 'owner', at: now }));
await send('sent back', core.renderReviewDecisionCard({ taskTitle: base.title, teamName: base.teamName, decision: 'sent-back', deciderId: 'owner', at: now }));
await send('reminder', core.renderReminderCard({ taskId: base.taskId, version: 1, taskTitle: base.title, teamName: base.teamName, dueAt: now + 2 * DAY, now, audience: { kind: 'team' }, kind: 'pre_due', status: 'not_started' }));
await send('check-in', core.renderCheckinCard({ teamName: base.teamName, items: [{ title: base.title, dueAt: now + DAY, who: 'whole team' }, { title: 'Book the skid-pad slot', dueAt: now + 2 * DAY, who: 'whole team' }], pingUsers: [], pingRoles: [] }));
await send('digest', core.renderDigestCard({ teamName: base.teamName, weekOf: now, overdue: [{ title: 'Order wheel bearings', dueAt: now - DAY, who: 'whole team' }], dueThisWeek: [{ title: base.title, dueAt: now + DAY, who: 'whole team' }], later: [], doneThisWeek: ['Seat mount welds', 'Pedal box CAD'] }));
await send('pick', core.renderPickCard({ choiceMessageId: first.messageId, candidates: [{ taskId: randomUUID(), title: 'Harness' }, { taskId: randomUUID(), title: 'Bearings' }] }));
await send('clarify', core.renderClarifyCard({ question: 'Which side is finished, left or right?', replyTo: first.messageId }));
await send('task list', core.renderTaskListCard({ rows: [{ teamName: 'Car', title: base.title, status: 'in_progress', dueAt: now + DAY }, { teamName: 'Aero', title: 'Upload CFD results', status: 'not_started', dueAt: now - DAY }], now }));
await send('error', core.errorCard('task.update-not-saved', { quote: 'Left side done.' }));
await send('result', core.resultCard({ icon: 'update', title: 'Update saved', detail: 'It shows on the task card and is posted in the channel.', tone: 'ok' }));
console.log('Done. The buttons on these cards point at sample tasks, so pressing them gives a "closed" reply.');
```

Run `node --check scripts/card-gallery.mjs` and `npx prettier --write scripts/card-gallery.mjs`. If
`createDiscordRestPort`'s options differ from those above, match its real signature (read
`packages/discord/src/rest/index.ts`).

- [ ] **Step 2: Docs**

`docs/SMOKE_TESTS.md`, new section:

```markdown
## Card gallery (ADR 0140)

Run after any change to a card. Owner-run; posts about 18 messages to a test channel.

    npm run build && npm run smoke:cards -- --channel <test channel id>

Check, and note anything wrong:

- [ ] Desktop, dark theme: every card has its colour bar; thumbnails and the digest banner load; no text is cut off.
- [ ] Desktop, light theme: the same.
- [ ] iOS and Android: cards render; buttons wrap without truncating labels; the banner is not cropped badly.
- [ ] Mentions render as names (the gallery pings nobody).
- [ ] Post a real task to yourself and check the push notification's preview text.
- [ ] Press **I'm on it** on a sample card: the private reply says the task is closed.
```

`docs/STATE.md`: add at the top:
`**Task cards (ADR 0140), 2026-10-xx.** Every task post is a Components V2 card with description, links (≤5), art, and I'm on it / Post update buttons; cards refresh within a minute of any edit; links editable in the dashboard and MCP. Migration ui_task_cards. Owner check: npm run smoke:cards.`

MCP guide and instructions: add one sentence each where task tools are described. Tasks can carry up to 5
links (`links` on `create_task` / `update_task edit`). A progress record (`task_progress record`) is
posted to the task's channel as an update card when task posts are on.

- [ ] **Step 3: Final gates and commit**

```bash
npm run typecheck
npm run lint
npm run test
git add scripts package.json docs packages/mcp
git commit -m "P1 Task 14: card gallery smoke script and docs"
```

---

## Self-check before handing back

- [ ] `rg -n "TASK_REPLY_NOTICE" packages apps` finds nothing.
- [ ] `rg -n "content: \`" apps/daemon/src/jobs/task-nudges.ts` finds no task post still built as plain
      content.
- [ ] Every new storage function takes `scope` first.
- [ ] No `discord.js` import under `packages/core`.
- [ ] `npm run typecheck`, `npm run lint` and `npm run test` all pass, run fresh.
- [ ] `docs/superpowers/plans/notes/P1-deviations.md` lists every deviation, or does not exist because
      there were none.
