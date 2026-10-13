import { DescriptionList } from '../../ui/DescriptionList.js';
import { HelpTip } from '../../ui/HelpTip.js';

const SWITCHES = [
  {
    term: 'Read',
    value:
      'May look up recent messages live from Discord. Off: the bot only sees the message that tagged it, the one it replies to, and the archive.',
  },
  {
    term: 'Write',
    value: 'May post here, including answering when tagged. Off: the bot stays silent here.',
  },
  {
    term: 'Archive',
    value:
      'Records new messages into a searchable copy. Turning it off stops recording; nothing is deleted. Delete archived messages on the Archive page.',
  },
  {
    term: 'No access',
    value:
      'Overrides everything above and hides archived copies. Moderation and automod still work.',
  },
] as const;

export function ScopeHeader({ name }: { readonly name: (typeof SWITCHES)[number]['term'] }) {
  return (
    <span className="inline-flex items-center gap-1">
      {name}
      <HelpTip label={name}>{SWITCHES.find((item) => item.term === name)?.value}</HelpTip>
    </span>
  );
}

export function ScopeHelp() {
  return (
    <details className="mb-4 rounded-panel border border-line bg-panel p-4">
      <summary className="cursor-pointer text-section font-medium focus-visible:outline-accent">
        What the switches mean
      </summary>
      <div className="mt-3">
        <DescriptionList items={SWITCHES} columns={2} />
      </div>
      <p className="mt-3 text-small text-ink-muted">
        To switch one channel off inside a category that is on, turn the category off and turn on
        the channels you want, or mark the channel No access.
      </p>
    </details>
  );
}
