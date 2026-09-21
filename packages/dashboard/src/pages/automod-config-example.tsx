import { useState } from 'react';
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
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-ink-muted">
        Show an example for {RULE_KIND_LABEL[kind]}
      </summary>
      <div className="mt-1">
        <pre className="overflow-x-auto rounded-sm border border-line bg-canvas px-2 py-1 text-xs break-words whitespace-pre-wrap text-ink">
          {example.json}
        </pre>
        <p className="mt-1 text-xs text-ink-muted">{example.note}</p>
        {onUse !== undefined && (
          <button
            type="button"
            className="mt-1 text-xs text-ink-muted underline hover:text-ink"
            onClick={() => {
              onUse(example.json);
              setUsed(true);
            }}
          >
            {used ? 'Example copied into the form' : 'Use this example'}
          </button>
        )}
      </div>
    </details>
  );
}
