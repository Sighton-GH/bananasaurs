import { useState, type ReactElement } from 'react';
import { Button } from '../../ui/Button.js';
import { CodeBlock } from '../../ui/CodeBlock.js';
import { KeyValueTable, type KeyValue } from '../../ui/KeyValueTable.js';

// API JSON only: do not invent labels or fields for scalars, absent args, or redacted data.
function isKeyValue(value: unknown): value is KeyValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isKeyValue);
  return typeof value === 'object' && Object.values(value).every(isKeyValue);
}
function isRecord(value: unknown): value is Readonly<Record<string, KeyValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && isKeyValue(value);
}
function rawText(args: unknown): string {
  try {
    return JSON.stringify(args, null, 2) ?? 'No arguments were recorded.';
  } catch {
    return 'Arguments could not be displayed.';
  }
}
export function ToolArguments({
  args,
  name,
  call,
}: {
  readonly args: unknown;
  readonly name: string;
  readonly call: number;
}): ReactElement {
  const [raw, setRaw] = useState(false);
  const structured = isRecord(args);
  if (args === undefined)
    return <p className="text-small text-ink-muted">No arguments were recorded.</p>;
  return (
    <div className="grid min-w-0 gap-2 [overflow-wrap:anywhere]">
      {structured && (
        <Button size="sm" variant="subtle" aria-expanded={raw} onClick={() => setRaw((v) => !v)}>
          {raw ? 'Show structured' : 'Show raw'}
        </Button>
      )}
      {structured && !raw ? (
        Object.keys(args).length === 0 ? (
          <p className="text-small text-ink-muted">No arguments were supplied.</p>
        ) : (
          <KeyValueTable data={args} caption={`Arguments for ${name}, call ${call}`} />
        )
      ) : (
        <CodeBlock
          code={rawText(args)}
          label={`Arguments for ${name}, call ${call}`}
          language="json"
          maxHeight={320}
        />
      )}
    </div>
  );
}
