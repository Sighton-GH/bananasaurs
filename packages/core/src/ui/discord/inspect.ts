/** Reads a card back into text and custom ids, for tests and the card gallery. No behaviour. */
const walk = (value: unknown, visit: (node: Record<string, unknown>) => void): void => {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const node = value as Record<string, unknown>;
  visit(node);
  walk(node['components'], visit);
};

export const cardTexts = (components: readonly unknown[]): string => {
  const out: string[] = [];
  walk(components, (n) => {
    if (n['type'] === 10 && typeof n['content'] === 'string') out.push(n['content']);
  });
  return out.join('\n');
};

export const cardCustomIds = (components: readonly unknown[]): string[] => {
  const out: string[] = [];
  walk(components, (n) => {
    if (n['type'] === 2 && typeof n['custom_id'] === 'string') out.push(n['custom_id']);
  });
  return out;
};
