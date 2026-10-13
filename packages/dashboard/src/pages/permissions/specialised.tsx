import { Card } from '../../ui/Card.js';
import { Link } from '../../ui/Link.js';

export function SpecialisedPermissions() {
  return (
    <Card title="Specialised controls">
      <ul className="grid gap-2 text-body">
        <li>
          <Link href="/mcp">Connected apps</Link> - the connector&apos;s tokens and clients, and the
          ledger of what it posted. The send scope itself is managed on the Channels tab.
        </li>
        <li>
          <Link href="/archive">Archive</Link> - browse archived messages, run backfills, set
          retention, and delete archived messages.
        </li>
        <li>
          <Link href="/logging">Logging</Link> - which events get logged and where the log posts.
        </li>
        <li>
          <Link href="/accounts">Accounts</Link> - who may sign in to this dashboard and what each
          account may change.
        </li>
        <li>
          <Link href="/assistant">Behaviours</Link> - which assistant skills the server allows at
          all, before any per-member check.
        </li>
        <li>
          <Link href="/panels">Role panels</Link> - per-panel limits on who may pick up roles.
        </li>
      </ul>
    </Card>
  );
}
