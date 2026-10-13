import { screen } from '@testing-library/react';

// jsdom lacks these DOM APIs, which Radix Select calls.
const proto = (
  globalThis as unknown as {
    Element: {
      prototype: {
        hasPointerCapture?: (pointerId: number) => boolean;
        releasePointerCapture?: (pointerId: number) => void;
        scrollIntoView?: () => void;
      };
    };
  }
).Element.prototype;
if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
if (!proto.releasePointerCapture) proto.releasePointerCapture = () => undefined;
if (!proto.scrollIntoView) proto.scrollIntoView = () => undefined;
// jsdom lacks the resize API used by dialogs.
if (!('ResizeObserver' in globalThis))
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };

/** Opens the Select whose accessible name is `name` and picks `option`, the way a person does. */
export async function pick(
  user: { click: (element: Element) => Promise<void> },
  name: string | RegExp,
  option: string | RegExp,
): Promise<void> {
  const matcher = typeof name === 'string' ? new RegExp(`^${name}`) : name;
  await user.click(await screen.findByRole('combobox', { name: matcher }));
  await user.click(await screen.findByRole('option', { name: option }));
}
