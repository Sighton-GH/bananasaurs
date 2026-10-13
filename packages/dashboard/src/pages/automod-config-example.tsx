import { useState } from 'react';
import { CodeBlock } from '../ui/CodeBlock.js';
import { Button } from '../ui/Button.js';
import type { RuleKind } from '../api/automod.js';
import { RULE_CONFIG_EXAMPLE, RULE_KIND_LABEL } from '../api/automod.js';

/**
 * Progressive disclosure for the one advanced control on the automod forms:
 * the JSON configuration. The textarea stays (it is the honest editor), but
 * a first-timer no longer faces a bare `{}` — the example shows the shape
 * the selected kind expects, and "Use this example" fills it in for editing.
 * The note under each example is the schema in one plain sentence.
 */
export function RuleConfigExample({
  kind,
  onUse,
}: {
  readonly kind: RuleKind;
  readonly onUse?: ((json: string) => void) | undefined;
}) {
  const example = RULE_CONFIG_EXAMPLE[kind];
  const [used, setUsed] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <details className="mt-1" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-xs text-ink-muted">
        Show an example for {RULE_KIND_LABEL[kind]}
      </summary>
      <div className="mt-1">
        {open && <CodeBlock code={example.json} language="json" label="Configuration example" />}
        <p className="mt-1 text-xs text-ink-muted">{example.note}</p>
        {onUse !== undefined && (
          <Button
            size="sm"
            onClick={() => {
              onUse(example.json);
              setUsed(true);
            }}
          >
            {used ? 'Example copied into the form' : 'Use this example'}
          </Button>
        )}
      </div>
    </details>
  );
}
