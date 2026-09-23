import { useCallback } from 'react';
import { Link } from 'wouter';
import type { DoctorProblem, DoctorReport, PublicSurfaceReport } from '../api/ops.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { DataState } from '../ui/DataState.js';
import { HelpTip } from '../ui/HelpTip.js';
import { PageHeader } from '../ui/PageHeader.js';

function ReportBody({ text, data }: { readonly text: string; readonly data: unknown }) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-sm text-ink-muted">Raw diagnostics</summary>
      <pre className="mt-1 text-sm break-words whitespace-pre-wrap">{text}</pre>
      <pre className="mt-1 overflow-x-auto text-xs break-words whitespace-pre-wrap">
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  );
}

/**
 * One finding, led by what to do about it: what is wrong, why it matters,
 * the exact fix, and a direct link to the dashboard control when one exists.
 */
function ProblemCard({ problem }: { readonly problem: DoctorProblem }) {
  return (
    <li className="rounded border border-line p-3">
      <p className="text-sm font-medium">{problem.title}</p>
      <p className="mt-1 text-sm text-ink-muted">Why it matters: {problem.impact}</p>
      <p className="mt-1 text-sm">Fix: {problem.fix}</p>
      {problem.route !== undefined && (
        <p className="mt-1 text-sm">
          <Link href={problem.route} className="text-accent underline">
            Open {problem.route}
          </Link>
        </p>
      )}
      {problem.details !== undefined && (
        <p className="mt-1 text-xs text-ink-muted">{problem.details}</p>
      )}
    </li>
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
                  <ol className="mb-3 grid gap-2">
                    {report.data.problems!.map((problem, index) => (
                      <ProblemCard key={`${problem.title}:${String(index)}`} problem={problem} />
                    ))}
                  </ol>
                )}
                {(report.data.advisories?.length ?? 0) > 0 && (
                  <div className="mb-3">
                    <p className="text-sm font-medium">Worth knowing (not problems)</p>
                    <ul className="mt-1 list-disc pl-5 text-sm text-ink-muted">
                      {report.data.advisories!.map((advisory) => (
                        <li key={advisory}>{advisory}</li>
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
                <ReportBody text={report.text} data={report.data} />
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
                    <Badge tone="neutral">
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
                <ReportBody text={report.text} data={report.data} />
              </>
            )}
          </DataState>
        </Card>
      </div>
    </>
  );
}
