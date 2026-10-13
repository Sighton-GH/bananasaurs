import { useEffect, useState, type ReactElement } from 'react';
import { ApiError } from '../api.js';
import { CrashBoundary } from '../app/CrashBoundary.js';
import { useSession } from '../app/session.js';
import styles from '../styles.css?raw';
import { Badge, type BadgeTone } from '../ui/Badge.js';
import { Banner } from '../ui/Banner.js';
import { Button, type ButtonVariant } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { CodeBlock } from '../ui/CodeBlock.js';
import { DescriptionList } from '../ui/DescriptionList.js';
import { DropdownMenu } from '../ui/DropdownMenu.js';
import { ErrorSummary } from '../ui/ErrorSummary.js';
import { Checkbox, Field, Input } from '../ui/Field.js';
import { InlineAlert, type AlertTone } from '../ui/InlineAlert.js';
import { IconInfo, IconRefresh } from '../ui/icons.js';
import { Kbd } from '../ui/Kbd.js';
import { KeyValueTable } from '../ui/KeyValueTable.js';
import { Link } from '../ui/Link.js';
import { Pagination } from '../ui/Pagination.js';
import { ProgressBar } from '../ui/ProgressBar.js';
import { RadioGroup } from '../ui/RadioGroup.js';
import { Select } from '../ui/Select.js';
import { Skeleton } from '../ui/Skeleton.js';
import { Spinner } from '../ui/Spinner.js';
import { Empty, Forbidden, Loading, NotFound, Stale, Unavailable } from '../ui/states.js';
import { TabPanel, Tabs } from '../ui/Tabs.js';
import { Textarea } from '../ui/Textarea.js';
import { useToast, type ToastTone } from '../ui/Toast.js';
import { Tooltip, TooltipProvider } from '../ui/Tooltip.js';

// Extract names only; swatch values always come from the active, computed theme.
const COLOUR_TOKENS = [
  ...new Set(
    Array.from(styles.matchAll(/(--color-[\w-]+)\s*:/g), (m) => m[1]).filter(
      (name): name is string => name !== undefined,
    ),
  ),
];
const TONES: readonly { badge: BadgeTone; alert: AlertTone; label: string }[] = [
  { badge: 'neutral', alert: 'info', label: 'Neutral' },
  { badge: 'accent', alert: 'info', label: 'Accent' },
  { badge: 'progress', alert: 'info', label: 'Progress' },
  { badge: 'hold', alert: 'hold', label: 'Hold' },
  { badge: 'ok', alert: 'ok', label: 'OK' },
  { badge: 'danger', alert: 'danger', label: 'Danger' },
];
const VARIANTS: readonly ButtonVariant[] = ['default', 'primary', 'danger', 'subtle'];
const TOAST_TONES: readonly ToastTone[] = ['neutral', 'hold', 'danger', 'ok'];
const CONFIG = {
  on: true,
  ui: { name: 'Kit', items: ['one', 'two'] },
};
const SAMPLE_ERROR = new ApiError(503, {
  error: 'sample-unavailable',
  title: 'Sample service unavailable',
  message: 'This is a sample error. Nothing was changed.',
  requestId: 'kit-sample-001',
});

function Tokens(): ReactElement {
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  useEffect(() => {
    const root = document.documentElement;
    const read = () => {
      const computed = getComputedStyle(root);
      setValues(
        Object.fromEntries(
          COLOUR_TOKENS.map((name) => [name, computed.getPropertyValue(name).trim()]),
        ),
      );
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener('change', read);
    return () => {
      observer.disconnect();
      media?.removeEventListener('change', read);
    };
  }, []);
  return (
    <Card title="Tokens">
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {COLOUR_TOKENS.map((name) => (
          <li key={name} className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className="size-9 shrink-0 rounded-control border border-line-strong"
              style={{ backgroundColor: values[name] }}
            />
            <div className="min-w-0 break-words">
              <code className="text-caption">{name}</code>
              <p className="text-caption text-ink-muted">{values[name] || 'Not available'}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-small text-ink-muted">
        Alerts and banners use info for neutral, accent and progress; their supported tones are
        info, hold, OK and danger.
      </p>
      <div className="mt-3 grid gap-3">
        {TONES.map((tone) => (
          <div key={tone.badge} className="grid gap-2 sm:grid-cols-3">
            <div>
              <Badge tone={tone.badge} icon={IconInfo}>
                {tone.label}
              </Badge>
            </div>
            <InlineAlert tone={tone.alert} title={`${tone.label} sample`}>
              Nothing was changed.
            </InlineAlert>
            <Banner tone={tone.alert}>{tone.label} sample banner</Banner>
          </div>
        ))}
      </div>
    </Card>
  );
}

function CrashChild({ fail }: { readonly fail: boolean }): ReactElement {
  if (fail) throw new Error('Kit test error');
  return <p className="text-body">The crash demo is working.</p>;
}

function KitContent(): ReactElement {
  const toast = useToast();
  const [select, setSelect] = useState('one');
  const [radio, setRadio] = useState('first');
  const [tab, setTab] = useState('first');
  const [page, setPage] = useState(1);
  const [fail, setFail] = useState(false);
  const [crashKey, setCrashKey] = useState(0);
  const [updatedAt, setUpdatedAt] = useState(() => Date.now() - 300_000);
  return (
    <TooltipProvider>
      <div className="grid gap-6">
        <header>
          <h1 className="text-title font-semibold">UI kit</h1>
          <p className="mt-1 text-body text-ink-muted">
            Switch the theme with the toggle to check both. Nothing on this page changes any data.
          </p>
        </header>
        <Tokens />
        <Card title="Type">
          <div className="grid gap-3">
            <p className="text-title font-semibold">Title: A clear view of your server.</p>
            <p className="text-section font-semibold">Section: A clear view of your server.</p>
            <p className="text-body">Body: A clear view of your server.</p>
            <p className="text-small">Small: A clear view of your server.</p>
            <p className="text-caption">Caption: A clear view of your server.</p>
            <p className="font-mono text-small leading-5">Mono: A clear view of your server.</p>
          </div>
        </Card>
        <Card title="Buttons">
          <div className="flex flex-wrap gap-3">
            {VARIANTS.flatMap((variant) =>
              (['sm', 'md'] as const).map((size) => (
                <div key={`${variant}-${size}`} className="flex flex-wrap gap-2">
                  <Button variant={variant} size={size}>
                    {variant} {size}
                  </Button>
                  <Button variant={variant} size={size} disabled>
                    {variant} {size} disabled
                  </Button>
                  <Button variant={variant} size={size} busy>
                    {variant} {size} busy
                  </Button>
                </div>
              )),
            )}
            <Button icon={IconRefresh}>Sample icon button</Button>
          </div>
        </Card>
        <Card title="Form">
          <div className="grid max-w-[720px] gap-4">
            <ErrorSummary
              errors={[{ fieldId: 'kit-sample-name', message: 'Enter a sample name.' }]}
            />
            <Field label="Sample title">
              <Input />
            </Field>
            <Field label="Sample choice" htmlFor="kit-choice">
              <Select
                value={select}
                onValueChange={setSelect}
                options={[
                  { value: 'one', label: 'Option one' },
                  { value: 'two', label: 'Option two' },
                  { value: 'three', label: 'Option three', disabled: true },
                  { value: 'four', label: 'Option four' },
                  { value: 'five', label: 'Option five' },
                ]}
              />
            </Field>
            <Field label="Sample notes" htmlFor="kit-notes">
              <Textarea showCount maxLength={200} />
            </Field>
            <RadioGroup
              legend="Sample mode"
              name="kit-mode"
              value={radio}
              onChange={setRadio}
              options={[
                { value: 'first', label: 'First mode' },
                { value: 'second', label: 'Second mode' },
              ]}
            />
            <Checkbox label="Enable sample option" />
            <Field label="Sample name" error="Enter a sample name." htmlFor="kit-sample-name">
              <Input />
            </Field>
          </div>
        </Card>
        <Card title="Structure">
          <div className="grid gap-4">
            <Tabs
              value={tab}
              onValueChange={setTab}
              aria-label="Sample tabs"
              tabs={[
                { value: 'first', label: 'First' },
                { value: 'second', label: 'Second' },
                { value: 'third', label: 'Third' },
              ]}
            >
              <TabPanel value="first">First sample panel</TabPanel>
              <TabPanel value="second">Second sample panel</TabPanel>
              <TabPanel value="third">Third sample panel</TabPanel>
            </Tabs>
            <div className="flex flex-wrap items-center gap-3">
              <DropdownMenu
                label="Sample actions"
                items={[
                  {
                    label: 'Show sample toast',
                    onSelect: () =>
                      toast({
                        tone: 'neutral',
                        title: 'Sample menu action',
                        message: 'Nothing was changed.',
                      }),
                  },
                  { label: 'Disabled sample action', onSelect: () => undefined, disabled: true },
                ]}
              />
              <Tooltip content="This button does not change data.">
                <Button>Sample tooltip</Button>
              </Tooltip>
              <Link href="/kit">Kit link</Link>
              <Kbd>Enter</Kbd>
            </div>
            <DescriptionList
              items={[
                { term: 'Purpose', value: 'Local UI samples' },
                { term: 'Access', value: 'Instance owner' },
              ]}
              columns={2}
            />
            <KeyValueTable data={CONFIG} caption="Sample config" />
            <CodeBlock code={JSON.stringify(CONFIG, null, 2)} language="json" label="Sample JSON" />
            <Pagination page={page} pageCount={3} onPageChange={setPage} label="Sample pages" />
          </div>
        </Card>
        <Card title="States">
          <div className="grid gap-4">
            <Loading label="sample" forceVisible />
            <Loading label="small sample" variant="spinner" forceVisible />
            <Empty title="No sample items" detail="This is the empty state." />
            <Unavailable what="sample items" error={SAMPLE_ERROR} />
            <Forbidden permission="the instance owner" />
            <NotFound what="Sample item" backHref="/kit" backLabel="Back to kit" />
            <Stale updatedAt={updatedAt} onRefresh={() => setUpdatedAt(Date.now())} />
            <div className="flex items-center gap-2">
              <Spinner />
              <span className="text-small">Sample spinner</span>
            </div>
            <Skeleton lines={2} />
            <ProgressBar value={60} label="Sample progress" />
          </div>
        </Card>
        <Card title="Feedback">
          <div className="flex flex-wrap gap-3">
            {TOAST_TONES.map((tone) => (
              <Button
                key={tone}
                onClick={() =>
                  toast({ tone, title: `${tone} sample toast`, message: 'Nothing was changed.' })
                }
              >
                {tone} toast
              </Button>
            ))}
            <Button
              onClick={() =>
                toast({
                  tone: 'ok',
                  title: 'Sample action',
                  message: 'This is a local demo.',
                  action: {
                    label: 'Undo',
                    onClick: () =>
                      toast({
                        tone: 'neutral',
                        title: 'Sample action undone',
                        message: 'Nothing was changed.',
                      }),
                  },
                })
              }
            >
              Toast with Undo
            </Button>
          </div>
        </Card>
        <Card title="Crash">
          <div className="grid gap-3">
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => setFail(true)}>Throw a test error</Button>
              <Button
                onClick={() => {
                  setFail(false);
                  setCrashKey((key) => key + 1);
                }}
              >
                Reset test error
              </Button>
            </div>
            <CrashBoundary key={crashKey} scope="page" resetKey="/kit">
              <CrashChild fail={fail} />
            </CrashBoundary>
          </div>
        </Card>
      </div>
    </TooltipProvider>
  );
}

/** Owner-only samples. No resources are fetched and no server data is written. */
export function KitPage(): ReactElement {
  const session = useSession();
  if (session.info.instanceOwner !== true) return <Forbidden permission="the instance owner" />;
  return <KitContent />;
}
