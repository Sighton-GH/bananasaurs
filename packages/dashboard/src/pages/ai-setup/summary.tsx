import type { AssistantData, AssistantSetupData } from '../../api/assistant.js';
import type { EligibilityWarning } from '../../api/ops.js';
import { Badge } from '../../ui/Badge.js';
import { Link } from '../../ui/Link.js';

/**
 * The status row above the tabs: one badge per tab, built only from data the
 * page already loaded. A resource that failed or is still loading reads as
 * unavailable — it is never guessed as Off or 0.
 */
export function SetupSummary({
  setup,
  assistant,
  warnings,
  hrefFor,
}: {
  readonly setup: AssistantSetupData;
  readonly assistant: AssistantData | undefined;
  readonly warnings: readonly EligibilityWarning[] | undefined;
  readonly hrefFor: (tab: 'model-order' | 'keys' | 'web-search' | 'terms') => string;
}) {
  const ready = setup.chain.filter((row) => row.status === 'ready').length;
  // The page's existing treatment: a ready assistant resource without a
  // webSearch block reads as Off (the card and its remount key do the same).
  // Only a missing assistant resource is honestly unavailable.
  const webSearch =
    assistant === undefined
      ? undefined
      : { enabled: assistant.aiStatus?.webSearch?.enabled ?? false };
  return (
    <ul className="flex flex-wrap items-center gap-2" aria-label="AI setup status">
      <li>
        <Link href={hrefFor('model-order')}>
          <Badge tone={ready > 0 ? 'ok' : 'neutral'}>
            {ready > 0 ? `Models: ${String(ready)} ready` : 'Models: none ready'}
          </Badge>
        </Link>
      </li>
      <li>
        <Link href={hrefFor('keys')}>
          <Badge tone={setup.keys.length > 0 ? 'ok' : 'neutral'}>
            Keys: {String(setup.keys.length)} saved
          </Badge>
        </Link>
      </li>
      <li>
        <Link href={hrefFor('web-search')}>
          {webSearch === undefined ? (
            <Badge tone="neutral">Web search: unavailable</Badge>
          ) : (
            <Badge tone={webSearch.enabled ? 'ok' : 'neutral'}>
              Web search: {webSearch.enabled ? 'On' : 'Off'}
            </Badge>
          )}
        </Link>
      </li>
      <li>
        <Link href={hrefFor('terms')}>
          {warnings === undefined ? (
            <Badge tone="neutral">Terms: unavailable</Badge>
          ) : (
            <Badge tone={warnings.length > 0 ? 'hold' : 'ok'}>
              Terms: {String(warnings.length)} to check
            </Badge>
          )}
        </Link>
      </li>
    </ul>
  );
}
