import { useId, useState, type ReactElement } from 'react';
import { describeError } from '../api/describe-error.js';
import { useOnline } from '../hooks/useOnline.js';
import type { Resource } from '../hooks/useResource.js';
import { Banner } from '../ui/Banner.js';
import { Link } from '../ui/Link.js';
import { ModelHealthLines, useModelHealthWarnings } from '../ui/ModelHealthBanner.js';
import { useHealth, type HealthInfo } from './health.js';
import { useSession } from './session.js';

export interface SystemCause {
  readonly id:
    | 'offline'
    | 'killswitch'
    | 'breaker'
    | 'gateway'
    | 'safety-unknown'
    | 'readonly'
    | 'dry-run'
    | 'models';
  readonly tone: 'danger' | 'hold';
  readonly text: string;
  readonly action?: { readonly label: string; readonly href: string };
}

const SAFETY = { label: 'Open Safety', href: '/safety' } as const;
const MAX_VISIBLE = 5;

const modelsText = (names: readonly string[]): string => {
  const first = names[0] ?? '';
  return names.length === 1
    ? `1 AI model keeps failing: ${first}.`
    : `${String(names.length)} AI models keep failing: ${first}…`;
};

/**
 * Every reason the operator should hesitate, as data, in Decision 5 order:
 * offline, kill switch, breaker (danger), then gateway, unknown safety,
 * read-only, preview mode, failing models (hold). Pure; each id at most once.
 * Offline never hides the other known causes.
 */
export function systemCauses(input: {
  readonly online: boolean;
  readonly readonly: boolean;
  readonly health: Resource<HealthInfo>;
  readonly failingModels: readonly string[];
}): readonly SystemCause[] {
  const { health } = input;
  const healthOffline =
    health.state === 'error' && describeError(health.error).code === 'dashboard-offline';
  const causes: SystemCause[] = [];
  if (!input.online || healthOffline) {
    causes.push({
      id: 'offline',
      tone: 'danger',
      text: "Bananasaurs can't be reached. Changes won't save until it's back.",
    });
  }
  const data = health.state === 'ready' ? health.data : undefined;
  const safety = data?.safety;
  if (safety?.killswitch === true) {
    causes.push({
      id: 'killswitch',
      tone: 'danger',
      text: 'Kill switch is on. The bot is taking no actions in Discord.',
      action: SAFETY,
    });
  }
  if (safety?.breakerOpen === true) {
    causes.push({
      id: 'breaker',
      tone: 'danger',
      text: 'The safety breaker is open. Discord changes are paused until someone checks.',
      action: SAFETY,
    });
  }
  if (data !== undefined && !data.gateway.connected) {
    causes.push({
      id: 'gateway',
      tone: 'hold',
      text: 'The bot is disconnected from Discord. Logs and replies will resume when it reconnects.',
      action: { label: 'Open Doctor', href: '/doctor' },
    });
  }
  if (health.state === 'error' && !healthOffline) {
    causes.push({
      id: 'safety-unknown',
      tone: 'hold',
      text: "Safety status couldn't load. Check Safety before making changes.",
      action: SAFETY,
    });
  }
  if (input.readonly) {
    causes.push({
      id: 'readonly',
      tone: 'hold',
      text: 'This dashboard is read-only. Changes are refused.',
    });
  }
  if (safety?.dryRun === true) {
    causes.push({
      id: 'dry-run',
      tone: 'hold',
      text: 'Preview mode is on. Discord changes are logged, not applied.',
      action: SAFETY,
    });
  }
  const names = [...new Set(input.failingModels)];
  if (names.length > 0) {
    causes.push({
      id: 'models',
      tone: 'hold',
      text: modelsText(names),
      action: { label: 'Open AI setup', href: '/assistant/setup' },
    });
  }
  return causes;
}

/**
 * The one place the shell says something is wrong (ADR 0140): one P3 Banner
 * per cause, five at most until the operator expands the rest in place.
 * Reads the same `/api/health` as Overview, so the two cannot disagree.
 */
export function SystemBanner(): ReactElement | null {
  const session = useSession();
  const health = useHealth();
  const online = useOnline();
  const warnings = useModelHealthWarnings();
  const [expanded, setExpanded] = useState(false);
  const listId = useId();

  const causes = systemCauses({
    online,
    readonly: session.info.readonly,
    health: health.resource,
    failingModels: warnings.failingModels,
  });
  if (causes.length === 0) return null;

  const overflow = causes.length - MAX_VISIBLE;
  const shown = expanded || overflow <= 0 ? causes : causes.slice(0, MAX_VISIBLE);
  return (
    <section aria-label="System status" data-testid="system-banner" className="w-full min-w-0">
      <div id={listId} className="flex w-full min-w-0 flex-col">
        {shown.map((cause) => (
          <Banner
            key={cause.id}
            tone={cause.tone}
            {...(cause.tone === 'hold' ? { live: 'polite' as const } : {})}
          >
            {/*
             * One wrapping row: the text column keeps a readable 8rem basis,
             * so at narrow widths (180 CSS px under zoom) the action wraps to
             * its own line instead of squeezing the text into mid-word breaks.
             * On wide rows `ml-auto` keeps the action right-aligned as before.
             */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <div className="min-w-0 grow basis-32 break-words">
                <span>{cause.text}</span>
                {cause.id === 'models' && <ModelHealthLines models={warnings.models} />}
              </div>
              {cause.action !== undefined && (
                <Link
                  href={cause.action.href}
                  className="ml-auto max-w-[45%] break-words text-body"
                >
                  {cause.action.label}
                </Link>
              )}
            </div>
          </Banner>
        ))}
      </div>
      {overflow > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          className="w-full border-b border-line bg-canvas px-3 py-2 text-left text-body text-accent underline underline-offset-2 hover:no-underline focus-visible:outline-accent"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show fewer' : `and ${String(overflow)} more`}
        </button>
      )}
    </section>
  );
}
