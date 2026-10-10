import type { AssistantSkill } from './types.js';
import { TOOL_CATALOGUE, TOOL_GROUPS } from './tool-catalogue.js';
import { neutraliseMarkers } from './untrusted.js';

const oneLine = (text: string): string =>
  neutraliseMarkers(text)
    .replace(/[[\]\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const proseSkills = (skills: readonly AssistantSkill[]): readonly AssistantSkill[] =>
  skills.filter((s) => !TOOL_CATALOGUE.some((t) => t.skills.includes(s.id)));

export const buildCapabilityBlock = (input: {
  readonly offeredTools: readonly string[];
  readonly skills: readonly AssistantSkill[];
  readonly unavailable: readonly { readonly name: string; readonly reason: string }[];
  readonly askerName?: string | undefined;
}): string => {
  const offered = new Set(input.offeredTools);
  const groupLines = TOOL_GROUPS.flatMap((group) => {
    const names = TOOL_CATALOGUE.filter((t) => t.group === group.id && offered.has(t.name))
      .map((t) => t.name)
      .sort();
    return names.length === 0
      ? []
      : [`- ${group.label} (${names.join(', ')}): ${group.description}.`];
  });
  const lines: string[] = ['WHAT YOU CAN DO RIGHT NOW'];
  if (groupLines.length === 0) {
    lines.push('No tools this turn. Answer from what you know; do not claim an action.');
  } else {
    lines.push(
      'Your tools are the complete, current list of what you can look up or do:',
      ...groupLines,
    );
  }
  const prose = proseSkills(input.skills);
  if (prose.length > 0)
    lines.push(
      'You also help with:',
      ...prose.map((s) => `- ${s.name}: ${s.promptLine}`),
      '- Anything else a member reasonably asks you to write, explain or think through.',
    );
  lines.push(
    'When a member asks for something these cover, do it. When asked what you can do, describe these in plain words. ' +
      "Don't show tool names to members. When two lookups don't depend on each other, call them together in one turn.",
  );
  if (input.unavailable.length > 0) {
    const who =
      input.askerName === undefined ? 'THIS MEMBER' : oneLine(input.askerName).toUpperCase();
    lines.push(
      '',
      `NOT AVAILABLE TO ${who} RIGHT NOW`,
      ...input.unavailable.map((u) => `- ${oneLine(u.name)}: ${oneLine(u.reason)}`),
      "If asked for one of these, say plainly that it isn't available to them and why. Do not suggest asking someone else to do it.",
    );
  }
  return lines.join('\n');
};
