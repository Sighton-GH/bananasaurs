import { nextProviderDayStart, providerDayStart } from '@bananasaurs/core';
import { modelCallsRepo, type InstanceScope } from '@bananasaurs/storage';
import { ENV_KEY_ID, type ChainEntry } from './model-chain.js';

export type LocalLimitCode = 'local-rpm-limit' | 'local-rpd-limit';

export class LocalLimitError extends Error {
  constructor(
    readonly availableAt: number,
    readonly code: LocalLimitCode,
  ) {
    super('every assistant model is at its configured limit');
    this.name = 'LocalLimitError';
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
  const time = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(availableAt);
  return `All AI models have reached the limits set for them. The next one frees up at ${time}.`;
};

export type ReserveOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: LocalLimitCode; readonly availableAt: number };

type EntryLimits = Pick<ChainEntry, 'keyId' | 'model' | 'providerId' | 'rpmLimit' | 'rpdLimit'>;

/** One provider call against an entry's RPM/RPD limits (ADR 0081). The `.env` seed is never limited or recorded. */
export const reserveEntryCall = (
  instance: InstanceScope,
  entry: EntryLimits,
  guildId: string,
  now: number,
): ReserveOutcome => {
  if (entry.keyId === ENV_KEY_ID) return { ok: true };
  const r = modelCallsRepo.reserveModelCall(instance, {
    keyId: entry.keyId,
    model: entry.model,
    guildId,
    now,
    rpmLimit: entry.rpmLimit,
    rpdLimit: entry.rpdLimit,
    dayStart: providerDayStart(entry.providerId, now),
    nextDayStart: nextProviderDayStart(entry.providerId, now),
  });
  return r.ok
    ? r
    : {
        ok: false,
        code: r.limit === 'rpm' ? 'local-rpm-limit' : 'local-rpd-limit',
        availableAt: r.availableAt,
      };
};

/** Live usage for the chain editor; `undefined` for the `.env` seed. */
export const entryUsage = (
  instance: InstanceScope,
  entry: EntryLimits,
  now: number,
):
  | { readonly lastMinute: number; readonly today: number; readonly availableAt?: number }
  | undefined => {
  if (entry.keyId === ENV_KEY_ID) return undefined;
  const usage = modelCallsRepo.modelUsage(instance, {
    keyId: entry.keyId,
    model: entry.model,
    now,
    dayStart: providerDayStart(entry.providerId, now),
  });
  const rpmAtLimit =
    entry.rpmLimit !== null &&
    usage.lastMinute >= entry.rpmLimit &&
    usage.oldestInMinute !== undefined
      ? usage.oldestInMinute + 60_000
      : undefined;
  const rpdAtLimit =
    entry.rpdLimit !== null && usage.today >= entry.rpdLimit
      ? nextProviderDayStart(entry.providerId, now)
      : undefined;
  const availableAt =
    rpmAtLimit !== undefined && rpdAtLimit !== undefined
      ? Math.max(rpmAtLimit, rpdAtLimit)
      : (rpmAtLimit ?? rpdAtLimit);
  return {
    lastMinute: usage.lastMinute,
    today: usage.today,
    ...(availableAt === undefined ? {} : { availableAt }),
  };
};
