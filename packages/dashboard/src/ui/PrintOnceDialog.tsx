import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Button } from './Button.js';

/**
 * Shows a print-once secret — the generated password from
 * `account set-password`, the one kind of secret this surface ever displays
 * (docs/17: "printed once and never stored"). The server sends it in exactly
 * one response; this dialog is that response's whole lifecycle.
 *
 * Escape and the backdrop deliberately do nothing: an accidental dismiss
 * would destroy the only copy. The operator confirms with the done button,
 * which is the dialog's one way out — after that the secret exists only
 * where they saved it.
 */
export function PrintOnceDialog({
  open,
  title,
  secretLabel,
  secret,
  onDone,
}: {
  readonly open: boolean;
  readonly title: string;
  /** What the secret is, e.g. "New password for bryan". */
  readonly secretLabel: string;
  readonly secret: string | undefined;
  readonly onDone: () => void;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  // Return focus to whatever opened the dialog when Done closes it (the
  // secret is cleared by the caller; focus must not fall to <body>).
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const revealFrame = useRef<number | null>(null);
  const revealGen = useRef(0);
  // A queued reveal must never outlive its open: close/unmount cancels it and
  // bumps the generation so a stale frame cannot act on a later open.
  useEffect(() => {
    if (open) return undefined;
    revealGen.current += 1;
    if (revealFrame.current !== null) cancelAnimationFrame(revealFrame.current);
    revealFrame.current = null;
    return undefined;
  }, [open]);
  useEffect(
    () => () => {
      revealGen.current += 1;
      if (revealFrame.current !== null) cancelAnimationFrame(revealFrame.current);
    },
    [],
  );
  useEffect(() => {
    if (wasOpen.current && !open) {
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener !== null && opener.isConnected) opener.focus();
    }
    wasOpen.current = open;
  }, [open]);

  const copy = async () => {
    if (secret === undefined) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      // Clipboard refusal (permissions policy, non-secure context) leaves the
      // text selected for a manual copy instead — the secret is not lost.
      setCopied(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      // No close path but the done button: onOpenChange is swallowed so
      // escape and the backdrop cannot strand the only copy of the secret.
      onOpenChange={() => undefined}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[60] bg-canvas/70"
          // A press on the inert backdrop must not blur the dialog to <body>.
          onMouseDown={(e) => e.preventDefault()}
        />
        <Dialog.Content
          className="fixed z-[70] top-1/2 left-1/2 max-h-[calc(100dvh-2rem)] w-[28rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto overscroll-contain rounded-md border border-line bg-panel p-4 text-ink [overflow-wrap:anywhere]"
          ref={contentRef}
          onOpenAutoFocus={() => {
            openerRef.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            // Radix focuses after this handler; reveal the focused action once it has.
            const generation = ++revealGen.current;
            if (revealFrame.current !== null) cancelAnimationFrame(revealFrame.current);
            revealFrame.current = requestAnimationFrame(() => {
              revealFrame.current = null;
              if (generation !== revealGen.current) return;
              const active = document.activeElement;
              if (
                contentRef.current?.contains(active) === true &&
                active instanceof HTMLElement &&
                typeof active.scrollIntoView === 'function'
              ) {
                active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
              }
            });
          }}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          <Dialog.Title className="text-lg">{title}</Dialog.Title>
          <Dialog.Description asChild>
            <div className="mt-2 text-sm">
              <p>
                {secretLabel}. Shown once, stored nowhere — copy it into a password manager now. It
                will not be shown again.
              </p>
            </div>
          </Dialog.Description>
          <p className="mt-3 rounded-sm border border-line bg-canvas px-3 py-2 font-mono text-sm break-all select-all">
            {secret}
          </p>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</Button>
            <Button variant="primary" onClick={onDone}>
              I have saved it
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
