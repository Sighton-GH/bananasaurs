import * as Radix from '@radix-ui/react-tabs';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useLocation, useSearch } from 'wouter';
import {
  ASSISTANT_PROVIDERS_URL,
  ASSISTANT_URL,
  type AssistantData,
  type AssistantSetupData,
} from '../../api/assistant.js';
import type { EligibilityWarning } from '../../api/ops.js';
import { useSession } from '../../app/session.js';
import { AssistantChainPools } from '../../components/assistant-chain-pools.js';
import { AssistantKeyStatusRows } from '../../components/assistant-key-status-rows.js';
import { AssistantKeysPaste } from '../../components/assistant-keys-paste.js';
import { AssistantModelCheck } from '../../components/assistant-model-check.js';
import { AssistantRecommendedSetup } from '../../components/assistant-recommended-setup.js';
import { AssistantRoutingSettings } from '../../components/assistant-routing-settings.js';
import { useResource, type UseResource } from '../../hooks/useResource.js';
import { DataState } from '../../ui/DataState.js';
import { InlineAlert } from '../../ui/InlineAlert.js';
import { Link } from '../../ui/Link.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Tabs } from '../../ui/Tabs.js';
import { GithubSection } from './github.js';
import { KeysSection, ProvidersSection } from './keys.js';
import { ModelOrderSection } from './model-order.js';
import { SetupSummary } from './summary.js';
import { TermsSection } from './terms.js';
import { WebSearchCard } from './web-search.js';

const TAB_VALUES = ['model-order', 'keys', 'web-search', 'github', 'terms'] as const;
type AiSetupTab = (typeof TAB_VALUES)[number];
const isTab = (value: string | null): value is AiSetupTab =>
  value !== null && (TAB_VALUES as readonly string[]).includes(value);

/**
 * `/providers` and `/assistant/setup`: the AI setup page. A status summary
 * comes first, then tabs for the model order, keys, web search, the GitHub
 * token and the terms records. "I checked these terms today" records that
 * the owner re-checked the row as it stands — it writes the review date,
 * never the row's claims. Changing a provider's training flag or production
 * eligibility stays a config change on the host.
 */
export function ProvidersPage() {
  const session = useSession();
  const loadSetup = useCallback(
    () => session.read<AssistantSetupData>(ASSISTANT_PROVIDERS_URL),
    [session],
  );
  const setup = useResource('the AI setup', loadSetup);
  const loadAssistant = useCallback(() => session.read<AssistantData>(ASSISTANT_URL), [session]);
  const assistant = useResource('the assistant', loadAssistant);
  const loadWarnings = useCallback(
    () =>
      session
        .read<{ warnings: EligibilityWarning[] }>('/api/providers/eligibility')
        .then((r) => r.warnings),
    [session],
  );
  const warnings = useResource('the provider eligibility warnings', loadWarnings);

  const reloadAll = () => {
    setup.reload();
    assistant.reload();
    warnings.reload();
  };

  return (
    <>
      <PageHeader title="AI setup" purpose="Which AI models answer, and the keys they use." />
      <div className="max-w-4xl">
        <DataState resource={setup.resource}>
          {(data) => (
            <SetupBody
              setup={data}
              assistant={assistant.resource.state === 'ready' ? assistant.resource.data : undefined}
              warnings={warnings}
              onChanged={reloadAll}
            />
          )}
        </DataState>
      </div>
    </>
  );
}

function SetupBody({
  setup,
  assistant,
  warnings,
  onChanged,
}: {
  readonly setup: AssistantSetupData;
  readonly assistant: AssistantData | undefined;
  readonly warnings: UseResource<readonly EligibilityWarning[]>;
  readonly onChanged: () => void;
}) {
  const [location, navigate] = useLocation();
  const search = useSearch();
  const fallback: AiSetupTab = setup.keys.length === 0 ? 'keys' : 'model-order';
  const requested = new URLSearchParams(search).get('tab');
  const tab = isTab(requested) ? requested : fallback;
  // Keep the current route and every unrelated query param and the hash; only
  // `tab` changes, so Back returns to the previous tab.
  const hrefFor = (next: AiSetupTab): string => {
    const params = new URLSearchParams(search);
    params.set('tab', next);
    return `${location}?${params.toString()}${window.location.hash}`;
  };

  const chainSignature = JSON.stringify(
    setup.chain.map((c) => [c.keyId, c.model, c.rpmLimit, c.rpdLimit, c.pool, c.tier]),
  );
  // Lazy-persistent panels: a section mounts on its first visit, then stays
  // mounted (hidden) so unsaved drafts and mount-time fetches survive tab
  // switches. The kit TabPanel unmounts inactive panels, which destroyed
  // drafts and reissued mount-time requests (source review P2).
  const [visited, setVisited] = useState<readonly AiSetupTab[]>([tab]);
  useEffect(() => {
    setVisited((prev) => (prev.includes(tab) ? prev : [...prev, tab]));
  }, [tab]);

  const warningRows = warnings.resource.state === 'ready' ? warnings.resource.data : undefined;
  const mayTrain = warningRows?.some((w) => w.trainsOnInput !== 'no') ?? false;

  return (
    <>
      <SetupSummary setup={setup} assistant={assistant} warnings={warningRows} hrefFor={hrefFor} />
      {warningRows !== undefined && warningRows.length > 0 && (
        <div className="mt-4">
          <InlineAlert tone="hold" title="Service terms to check">
            {warningRows.length === 1
              ? '1 service needs its terms checked.'
              : `${String(warningRows.length)} services need their terms checked.`}
            {mayTrain ? ' At least one may train on your data.' : ''}{' '}
            <Link href={hrefFor('terms')}>Open the Terms tab</Link>
          </InlineAlert>
        </div>
      )}
      <div className="mt-4">
        <Tabs
          value={tab}
          onValueChange={(value) => {
            if (isTab(value)) navigate(hrefFor(value));
          }}
          aria-label="AI setup sections"
          tabs={[
            { value: 'model-order', label: 'Model order' },
            { value: 'keys', label: 'Keys' },
            { value: 'web-search', label: 'Web search' },
            { value: 'github', label: 'GitHub' },
            { value: 'terms', label: 'Terms' },
          ]}
        >
          {visited.includes('model-order') && (
            <KeepAlivePanel value="model-order" tab={tab}>
              <ModelOrderSection setup={setup} onChanged={onChanged} />
              <AssistantRecommendedSetup onChanged={onChanged} />
              <AssistantChainPools
                key={`pools-${chainSignature}`}
                chain={setup.chain}
                onChanged={onChanged}
              />
              {setup.chain.map((row) => (
                <AssistantModelCheck
                  key={`${row.keyId} ${row.model}`}
                  position={row.position}
                  model={row.model}
                  keyLabel={row.keyLabel}
                />
              ))}
              <div className="mt-4">
                <AssistantRoutingSettings />
              </div>
            </KeepAlivePanel>
          )}
          {visited.includes('keys') && (
            <KeepAlivePanel value="keys" tab={tab}>
              <KeysSection setup={setup} onChanged={onChanged} />
              <AssistantKeyStatusRows keys={setup.keys} chain={setup.chain} />
              <AssistantKeysPaste onSaved={onChanged} />
              <div className="mt-4">
                <ProvidersSection setup={setup} />
              </div>
            </KeepAlivePanel>
          )}
          {visited.includes('web-search') && (
            <KeepAlivePanel value="web-search" tab={tab}>
              <WebSearchCard
                key={`web-${String(assistant?.aiStatus?.webSearch?.enabled ?? false)}-${assistant?.aiStatus?.webSearch?.source ?? 'brave'}`}
                status={assistant?.aiStatus}
                isOwner={assistant?.viewerIsOwner ?? false}
                onSaved={onChanged}
              />
            </KeepAlivePanel>
          )}
          {visited.includes('github') && (
            <KeepAlivePanel value="github" tab={tab}>
              <GithubSection tokenConfigured={setup.github.tokenConfigured} onChanged={onChanged} />
            </KeepAlivePanel>
          )}
          {visited.includes('terms') && (
            <KeepAlivePanel value="terms" tab={tab}>
              <TermsSection
                setup={setup}
                providerTerms={assistant?.providerTerms ?? null}
                isOwner={assistant?.viewerIsOwner ?? false}
                warnings={warnings}
                onChanged={onChanged}
              />
            </KeepAlivePanel>
          )}
        </Tabs>
      </div>
    </>
  );
}

/**
 * A tab panel that stays mounted once visited, hidden while inactive. Local
 * Radix Content with forceMount keeps the generated id/aria-labelledby
 * relationship with its trigger; the shared kit is untouched. Inactive
 * panels are explicitly hidden and leave the keyboard order (forceMount
 * alone would keep them present); active panels keep the kit's tabIndex=0
 * and focus-visible outline.
 */
function KeepAlivePanel({
  value,
  tab,
  children,
}: {
  readonly value: AiSetupTab;
  readonly tab: AiSetupTab;
  readonly children: ReactNode;
}) {
  const active = value === tab;
  return (
    <Radix.Content
      value={value}
      forceMount
      hidden={!active}
      tabIndex={active ? 0 : -1}
      className="focus-visible:outline-accent"
    >
      {children}
    </Radix.Content>
  );
}
