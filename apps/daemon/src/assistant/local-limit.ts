export class LocalLimitError extends Error {
  constructor(readonly availableAt: number, readonly code: 'local-rpm-limit' | 'local-rpd-limit') {
    super('every assistant model is at its configured limit'); this.name = 'LocalLimitError';
  }
}
/** Member-facing text. ≤ 90 minutes away: minutes; otherwise a clock time in `timeZone`. */
export const localLimitReply: (availableAt: number, now: number, timeZone: string) => string = (
  availableAt,
  now,
  timeZone,
) => {
  if (availableAt - now <= 90 * 60_000) {
    const n = Math.max(1, Math.ceil((availableAt - now) / 60000));
    return `All AI models have reached the limits set for them. The next one frees up in about ${n} ${n === 1 ? 'minute' : 'minutes'}.`;
  }
  const time = new Intl.DateTimeFormat('en-CA', { timeZone, hour: 'numeric', minute: '2-digit' }).format(availableAt);
  return `All AI models have reached the limits set for them. The next one frees up at ${time}.`;
};
