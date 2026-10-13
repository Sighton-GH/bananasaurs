// jsdom lacks these DOM APIs called by Radix Select.
const { Element: DomElement } = globalThis as unknown as {
  Element: {
    prototype: {
      hasPointerCapture?: (pointerId: number) => boolean;
      releasePointerCapture?: (pointerId: number) => void;
      scrollIntoView?: () => void;
    };
  };
};
if (!DomElement.prototype.hasPointerCapture) DomElement.prototype.hasPointerCapture = () => false;
if (!DomElement.prototype.releasePointerCapture)
  DomElement.prototype.releasePointerCapture = () => undefined;
if (!DomElement.prototype.scrollIntoView) DomElement.prototype.scrollIntoView = () => undefined;
if (!('ResizeObserver' in globalThis))
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
