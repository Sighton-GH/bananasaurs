const zoneOffsetMs = (timeZone: string, ms: number): number => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );
  const hour = parts.hour === '24' ? '0' : parts.hour;
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(ms / 1000) * 1000;
};
const zonedDayStart = (timeZone: string, ms: number): number => {
  const offset = zoneOffsetMs(timeZone, ms);
  const local = new Date(ms + offset);
  const midnightAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const guess = midnightAsUtc - offset;
  return midnightAsUtc - zoneOffsetMs(timeZone, guess);   // DST correction
};
/** Gemini's day follows Pacific time; OpenRouter and NVIDIA NIM use UTC. */
export const providerDayZone = (provider: string): string =>
  provider === 'gemini' ? 'America/Los_Angeles' : 'UTC';
export const providerDayStart = (provider: string, ms: number): number =>
  zonedDayStart(providerDayZone(provider), ms);
export const nextProviderDayStart = (provider: string, ms: number): number =>
  zonedDayStart(providerDayZone(provider), providerDayStart(provider, ms) + 36 * 3_600_000);
