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
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { type?: unknown }).type === 'number';

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
    throw new CardBudgetError(
      `card has ${chars} text characters; Discord allows ${MAX_TEXT_CHARS}`,
    );
};
