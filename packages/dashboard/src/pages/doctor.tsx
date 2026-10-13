import { useCallback } from 'react';
import { Link } from '../ui/Link.js';
import type { DoctorProblem, DoctorReport, PublicSurfaceReport } from '../api/ops.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { DataState } from '../ui/DataState.js';
import { HelpTip } from '../ui/HelpTip.js';
import { CodeBlock } from '../ui/CodeBlock.js';
import { DataTable } from '../ui/DataTable.js';
import { PageHeader } from '../ui/PageHeader.js';

function ReportBody({
  text,
  data,
  label,
}: {
  readonly text: string;
  readonly data: unknown;
  readonly label: string;
}) {
  return (
    <details className="mt-3 min-w-0">
      <summary className="cursor-pointer text-small text-ink-muted">Advanced</summary>
      <p className="my-2 text-small text-ink-muted">Copy report</p>
      <CodeBlock
        label={label}
        code={`${text}\n\n${JSON.stringify(data, null, 2)}`}
        maxHeight={320}
      />
    </details>
  );
}

function Problems({ problems }: { readonly problems: readonly DoctorProblem[] }) {
  return (
    <DataTable
      caption="Doctor problems"
      rows={problems}
      rowKey={(p) => p.title}
      columns={[
        { key: 'state', header: 'State', cell: () => <Badge tone="danger">Needs attention</Badge> },
        {
          key: 'name',
          header: 'Problem',
          cell: (p) => (
            <>
              <p className="font-medium">{p.title}</p>
              {p.details !== undefined && <p className="text-small text-ink-muted">{p.details}</p>}
            </>
          ),
        },
        { key: 'impact', header: 'Why it matters', cell: (p) => p.impact },
        {
          key: 'fix',
          header: 'Fix',
          cell: (p) => (
            <>
              <p>{p.fix}</p>
              {p.route !== undefined && <Link href={p.route}>Open {p.route}</Link>}
            </>
          ),
        },
      ]}
    />
  );
}

/**
 * `/doctor`: the two halves of `bananasaurs doctor` — the on-box checks
 * (`GET /api/doctor`) and the public-surface probe through Cloudflare Access
 * (`GET /api/doctor/public-surface`). Read-only observation; the probe is the
 * only on-box check of a configuration that lives entirely in Cloudflare.
 */
export function DoctorPage() {
  const session = useSession();
  const loadDoctor = useCallback(() => session.read<DoctorReport>('/api/doctor'), [session]);
  const loadPublic = useCallback(
    () => session.read<PublicSurfaceReport>('/api/doctor/public-surface'),
    [session],
  );
  const doctor = useResource('the doctor report', loadDoctor);
  const publicSurface = useResource('the public-surface probe', loadPublic);

  return (
    <>
      <PageHeader
        title="Doctor"
        purpose="Checks the bot connection, Discord permissions, role assignments, archive and public access. Re-run after changing setup."
        actions={
          <Button
            onClick={() => {
              doctor.reload();
              publicSurface.reload();
            }}
          >
            Re-run checks
          </Button>
        }
      />
      <div className="grid max-w-4xl gap-3">
        <Card title="Bot and server checks">
          <p className="mb-2 text-sm text-ink-muted">
            What this runs{' '}
            <HelpTip label="the bot and server checks">
              The same checks as the bananasaurs doctor command on the host: gateway connection, bot
              permissions, role messages and archive health. READ means seeing current content;
              ARCHIVE means collecting and keeping a searchable copy. Running checks changes
              nothing.
            </HelpTip>
          </p>
          <DataState resource={doctor.resource}>
            {(report) => (
              <>
                <p className="mb-2">
                  {report.ok ? (
                    <Badge tone="ok">no problems found</Badge>
                  ) : (
                    <Badge tone="danger">problems found</Badge>
                  )}
                </p>
                {(report.data.problems?.length ?? 0) > 0 && (
                  <Problems problems={report.data.problems!} />
                )}
                {(report.data.advisories?.length ?? 0) > 0 && (
                  <div className="mb-3">
                    <p className="text-sm font-medium">Worth knowing (not problems)</p>
                    <ul className="mt-1 list-disc pl-5 text-sm text-ink-muted">
                      {report.data.advisories!.map((advisory) => (
                        <li key={advisory}>
                          <Badge tone="hold">Advisory</Badge> {advisory}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {!report.ok && (report.data.problems?.length ?? 0) === 0 && (
                  <div className="mb-3 rounded border border-danger/40 bg-danger/5 p-3">
                    <p className="text-sm font-medium">
                      The structured fix is unavailable in this report.
                    </p>
                    <p className="mt-1 text-sm whitespace-pre-wrap">{report.text}</p>
                    <p className="mt-2 text-sm">
                      Fix: update to a server build that returns Doctor problems with issue, impact,
                      fix and route fields, then re-run this check.
                    </p>
                  </div>
                )}
                <ReportBody text={report.text} data={report.data} label="Bot and server report" />
              </>
            )}
          </DataState>
        </Card>
        <Card title="Internet access check">
          <p className="mb-2 text-sm text-ink-muted">
            Why a separate probe{' '}
            <HelpTip label="the internet access check">
              Checks the public hostname from outside, through Cloudflare Access, to confirm it
              exposes exactly what was intended. It is the only check of configuration that lives
              entirely in Cloudflare.
            </HelpTip>
          </p>
          <DataState resource={publicSurface.resource}>
            {(report) => (
              <>
                <p className="mb-2">
                  {!report.probed ? (
                    <Badge wrap tone="neutral">
                      not checked - the public connector URL is not configured
                    </Badge>
                  ) : report.ok ? (
                    <Badge tone="ok">as intended</Badge>
                  ) : (
                    <Badge tone="danger">problems found</Badge>
                  )}
                </p>
                {report.probed && !report.ok && (
                  <div className="mb-3 rounded border border-danger/40 bg-danger/5 p-3">
                    <p className="text-sm font-medium">
                      Internet access is not configured as intended
                    </p>
                    <p className="mt-1 text-sm whitespace-pre-wrap">{report.text}</p>
                    <p className="mt-2 text-sm">
                      Fix the public connector or Cloudflare Access policy named above, then re-run
                      this check.
                    </p>
                    <Link href="/mcp" className="mt-2 inline-block text-sm text-accent underline">
                      Open connector settings
                    </Link>
                  </div>
                )}
                <ReportBody text={report.text} data={report.data} label="Internet access report" />
              </>
            )}
          </DataState>
        </Card>
      </div>
    </>
  );
}
