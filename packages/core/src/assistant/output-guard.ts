// Deterministic output guard (ADR 0074). Pure: no I/O, no clock. Strips
// tool-call text the model must never show members, replaces configured model
// ids with the member-facing name, and refuses answers that leak the
// protected prompt text.

export type GuardRemoval = 'tool-call-text' | 'model-id';

export type GuardResult =
  | { readonly ok: true; readonly text: string; readonly removed: readonly GuardRemoval[] }
  | {
      readonly ok: false;
      readonly reason: 'empty-after-strip' | 'prompt-leak';
      readonly removed: readonly GuardRemoval[];
    };

const LEAK_WINDOW = 80;
const LEAK_STEP = 20;

/** Member-facing name used in place of any configured model id. */
const MODEL_ID_REPLACEMENT = "the club's AI service";

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const collapseBlankLines = (text: string): string => text.replace(/\n{3,}/g, '\n\n').trim();

const TOOL_JSON_KEYS = ['args', 'arguments', 'parameters'] as const;

const isToolShapedJson = (text: string): boolean => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  if (typeof record.name !== 'string') return false;
  return TOOL_JSON_KEYS.some((key) => {
    const value = record[key];
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  });
};

const stripToolCallText = (text: string): { text: string; stripped: boolean } => {
  let stripped = false;
  const drop = (): string => {
    stripped = true;
    return '';
  };
  // Fenced blocks in the tool languages are always tool calls.
  let out = text.replace(/```(?:tool_code|tool_call|function_call)[^`\n]*\n[\s\S]*?```/g, drop);
  // Python fences only count when the body reaches for the tool bridge.
  out = out.replace(/```python[^`\n]*\n[\s\S]*?```/g, (block) =>
    block.includes('default_api.') ? drop() : block,
  );
  out = out.replace(/<(tool_call|function_call)>[\s\S]*?<\/\1>/g, drop);
  out = out.replace(/^\s*(print\()?default_api\.\w+\(.*\)\)?\s*$/gm, drop);
  // A bare answer that is itself a tool-shaped JSON object is a tool call.
  const remainder = out.trim();
  if (remainder !== '' && isToolShapedJson(remainder)) {
    stripped = true;
    out = '';
  }
  return { text: out, stripped };
};

const replaceModelIds = (
  text: string,
  modelIds: readonly string[],
): { text: string; replaced: boolean } => {
  let replaced = false;
  let out = text;
  for (const id of modelIds) {
    // Short ids would match ordinary words; only real model ids are replaced,
    // as whole occurrences (never inside longer words), case-insensitively.
    if (id.length < 4) continue;
    const pattern = new RegExp(`(?<!\\w)${escapeRegExp(id)}(?!\\w)`, 'gi');
    const next = out.replace(pattern, MODEL_ID_REPLACEMENT);
    if (next !== out) {
      replaced = true;
      out = next;
    }
  }
  return { text: out, replaced };
};

const normaliseForLeak = (text: string): string =>
  text.toLowerCase().replace(/\s+/g, ' ').trim();

const hasPromptLeak = (answer: string, protectedText: string): boolean => {
  const needle = normaliseForLeak(protectedText);
  const haystack = normaliseForLeak(answer);
  if (needle.length < LEAK_WINDOW || haystack.length < LEAK_WINDOW) return false;
  for (let start = 0; start + LEAK_WINDOW <= needle.length; start += LEAK_STEP) {
    if (haystack.includes(needle.slice(start, start + LEAK_WINDOW))) return true;
  }
  return false;
};

/** True when the text holds a tool call and nothing else. */
export const looksLikeToolCallOnly = (text: string): boolean => {
  if (text.trim() === '') return false;
  const stripped = stripToolCallText(text);
  if (!stripped.stripped) return false;
  return collapseBlankLines(stripped.text) === '';
};

export const guardAnswer = (input: {
  text: string;
  protectedText: string;
  modelIds: readonly string[];
}): GuardResult => {
  const removed: GuardRemoval[] = [];
  const stripped = stripToolCallText(input.text);
  if (stripped.stripped) removed.push('tool-call-text');
  const collapsed = collapseBlankLines(stripped.text);
  if (collapsed === '') return { ok: false, reason: 'empty-after-strip', removed };
  const replaced = replaceModelIds(collapsed, input.modelIds);
  if (replaced.replaced) removed.push('model-id');
  if (hasPromptLeak(replaced.text, input.protectedText)) {
    return { ok: false, reason: 'prompt-leak', removed };
  }
  return { ok: true, text: replaced.text, removed };
};
