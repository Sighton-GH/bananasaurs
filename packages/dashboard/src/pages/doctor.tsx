import { useCallback } from 'react';
import type { DoctorReport, PublicSurfaceReport } from '../api/ops.js';
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
    <>
      <pre className="text-sm break-words whitespace-pre-wrap">{text}</pre>
      <details className="mt-2">
        <summary className="cursor-pointer text-sm text-ink-muted">Raw report</summary>
        <pre className="mt-1 overflow-x-auto text-xs break-words whitespace-pre-wrap">
          {JSON.stringify(data, null, 2)}
        </pre>
      </details>
    </>
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
              permissions, role messages and archive health. Running them changes nothing.
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
                <ReportBody text={report.text} data={report.data} />
              </>
            )}
          </DataState>
        </Card>
      </div>
    </>
  );
}
