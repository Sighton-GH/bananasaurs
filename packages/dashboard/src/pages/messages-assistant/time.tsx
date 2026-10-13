export function relativeMoment(at: number | undefined, now: number): string {
  if (at === undefined || !Number.isFinite(at) || !Number.isFinite(now)) return 'Time unavailable';
  const delta = at - now;
  const amount = Math.abs(delta);
  if (amount < 60_000) return delta > 0 ? 'in less than a minute' : 'just now';
  const unit = amount < 3_600_000 ? 'minute' : amount < 86_400_000 ? 'hour' : 'day';
  const count = Math.round(
    amount / (unit === 'minute' ? 60_000 : unit === 'hour' ? 3_600_000 : 86_400_000),
  );
  const text = `${count} ${unit}${count === 1 ? '' : 's'}`;
  return delta > 0 ? `in ${text}` : `${text} ago`;
}
export function absoluteMoment(at: number, timeZone?: string): string {
  if (!Number.isFinite(at)) return 'Time unavailable';
  return new Intl.DateTimeFormat('en-CA', {
    dateStyle: 'medium',
    timeStyle: 'long',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(at);
}
export function Moment({ at }: { at: number | undefined }) {
  if (at === undefined || !Number.isFinite(at)) return <span>Time unavailable</span>;
  return (
    <time dateTime={new Date(at).toISOString()} title={absoluteMoment(at)}>
      {relativeMoment(at, Date.now())}
    </time>
  );
}
