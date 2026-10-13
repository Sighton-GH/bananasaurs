import { ERROR_COPY, type ErrorCode, type ErrorCopy } from '../../copy/errors.js';
import { MAX_TEXT_CHARS } from './budget.js';
import { card, type CardMessage } from './card.js';
import { text, type ContainerChild } from './kit.js';
import { escapeInline, escapeText, subtext, truncate } from './text.js';
import { ICON, type IconName, type Tone } from './tokens.js';

const QUOTE_MAX = 1500;

const fitText = (raw: string, max: number, format: (value: string) => string): string => {
  const bounded = truncate(raw, max);
  const full = format(bounded);
  if (full.length <= max) return full;
  let low = 0;
  let high = bounded.length;
  let best = format('');
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const value = format(truncate(bounded, mid));
    if (value.length <= max) {
      best = value;
      low = mid + 1;
    } else high = mid - 1;
  }
  return best;
};

/** A private error card: title, rule, next step, optional quoted input and Ref (docs/28 §3). */
export const errorCard = (
  code: ErrorCode,
  options: { quote?: string; ref?: string } = {},
): CardMessage => {
  const entry: ErrorCopy = ERROR_COPY[code];
  const lines = [
    `**${entry.tone === 'danger' ? ICON.error : ICON.stop} ${entry.title}**`,
    entry.detail,
  ];
  if (entry.next !== undefined) lines.push(`${ICON.hint} ${entry.next}`);
  const body = lines.join('\n');
  // ADR 0141 decision 11: members never see a Ref, even if a caller supplies one.
  const ref =
    options.ref !== undefined && entry.audience !== 'member'
      ? subtext(`Ref ${fitText(options.ref, 80, escapeInline)}`)
      : undefined;
  const children: ContainerChild[] = [text(body)];
  if (options.quote !== undefined && options.quote.trim().length > 0)
    children.push(
      text(
        fitText(
          options.quote.trim(),
          Math.min(QUOTE_MAX, MAX_TEXT_CHARS - body.length - (ref?.length ?? 0)),
          (raw) =>
            escapeText(raw)
              .split('\n')
              .map((line) => `> ${line}`)
              .join('\n'),
        ),
      ),
    );
  if (ref !== undefined) children.push(text(ref));
  return card({ tone: entry.tone, children });
};

/** A private "here is what your click did" card. */
export const resultCard = (options: {
  icon: IconName;
  title: string;
  detail?: string;
  tone: Tone;
}): CardMessage => {
  const title = `**${ICON[options.icon]} ${fitText(options.title, 80, escapeInline)}**`;
  const lines = [title];
  if (options.detail !== undefined)
    lines.push(fitText(options.detail, MAX_TEXT_CHARS - title.length - 1, escapeText));
  return card({ tone: options.tone, children: [text(lines.join('\n'))] });
};
