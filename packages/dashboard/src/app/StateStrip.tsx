import { useHealth } from './health.js';
import { useSession } from './session.js';

/**
 * The one bold element (ADR 0043 D4). Silent when nothing is held; amber with
 * every hold named when something is. It reads the same `/api/health` the
 * Overview page does, so the two can never disagree.
 */
export function StateStrip() {
  const session = useSession();
  const health = useHealth();

  const holds: string[] = [];
  if (session.info.readonly) holds.push('Read-only instance: writes are refused');
  if (health.resource.state === 'ready') {
    const safety = health.resource.data.safety;
    if (safety?.dryRun === true)
      holds.push('Dry run: Discord side effects are logged, not executed');
    if (safety?.killswitch === true)
      holds.push('Kill switch on: every side effect for this guild is stopped');
    if (safety?.breakerOpen === true) holds.push('Circuit breaker open: Discord writes are paused');
    if (!health.resource.data.gateway.connected) holds.push('Gateway disconnected');
  }

  if (holds.length === 0) return null;
  return (
    <div
      role="status"
      data-testid="state-strip"
      className="border-b border-hold bg-hold px-4 py-1.5 text-sm text-hold-ink"
    >
      <ul className="flex flex-wrap gap-x-6">
        {holds.map((h) => (
          <li key={h}>{h}</li>
        ))}
      </ul>
    </div>
  );
}
