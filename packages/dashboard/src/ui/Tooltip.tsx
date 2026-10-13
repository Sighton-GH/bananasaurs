import type { ReactElement, ReactNode } from 'react';
import * as Radix from '@radix-ui/react-tooltip';

export function TooltipProvider(props: { children: ReactNode }): ReactElement {
  return <Radix.Provider delayDuration={300}>{props.children}</Radix.Provider>;
}

export function Tooltip(props: { content: string; children: ReactElement }): ReactElement {
  return (
    <Radix.Root>
      <Radix.Trigger asChild>{props.children}</Radix.Trigger>
      <Radix.Portal>
        {/*
          The cap tracks the viewport, not a fixed 320px: at 360 physical px
          and 200% native zoom the viewport is 180 CSS px wide, and `max-w-xs`
          let the text run off the right edge. `min(20rem, 100vw - 2rem)`
          keeps the old desktop width and leaves a 1rem safe gap on each side;
          `collisionPadding` gives Radix's placement the same edge gap, and
          `break-words` wraps long unbroken strings instead of overflowing.
        */}
        <Radix.Content
          sideOffset={4}
          collisionPadding={16}
          className="z-50 max-w-[min(20rem,calc(100vw-2rem))] break-words rounded-control border border-line bg-panel px-2 py-1 text-caption text-ink shadow-float"
        >
          {props.content}
          <Radix.Arrow className="fill-panel" />
        </Radix.Content>
      </Radix.Portal>
    </Radix.Root>
  );
}
