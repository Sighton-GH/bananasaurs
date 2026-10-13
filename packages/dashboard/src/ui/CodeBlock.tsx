import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Button } from './Button.js';
import { IconCopy } from './icons.js';
export function CodeBlock(props: {
  code: string;
  language?: string;
  label: string;
  maxHeight?: number;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(props.code);
      setError(false);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(true);
      setCopied(false);
    }
  }
  return (
    <section role="region" aria-label={props.label} className="min-w-0">
      <div className="mb-2 flex justify-end">
        <Button
          size="sm"
          icon={IconCopy}
          onClick={() => {
            void copy();
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? 'Copied' : ''}
      </span>
      {error && (
        <p role="alert" className="text-small text-danger">
          Couldn't copy. Select the text and copy it.
        </p>
      )}
      <pre
        className="overflow-auto rounded-control border border-line bg-sunk p-3 font-mono text-small focus-visible:outline-accent"
        style={props.maxHeight === undefined ? undefined : { maxHeight: props.maxHeight }}
        tabIndex={props.maxHeight === undefined ? undefined : 0}
      >
        <code className={props.language === undefined ? undefined : `language-${props.language}`}>
          {props.code}
        </code>
      </pre>
    </section>
  );
}
