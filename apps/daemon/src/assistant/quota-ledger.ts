/**
 * Process-wide record of spent `:free` daily allowances (ADR 0077, Task Q).
 * A daily-cap error marks the key exhausted until its reset; the tool loop
 * skips later `:free` entries on an exhausted key without a provider call,
 * so one member message cannot burn several of the day's requests. Entries
 * on other keys and paid models are still tried. The service owns one
 * instance for the process (constructed where the service is constructed
 * per daemon, not per request).
 */
export class QuotaLedger {
  private readonly resets = new Map<string, number>();

  readonly markExhausted = (keyId: string, until: number): void => {
    this.resets.set(keyId, until);
  };

  readonly exhaustedUntil = (keyId: string, now: number): number | undefined => {
    const until = this.resets.get(keyId);
    if (until === undefined) return undefined;
    if (now >= until) {
      this.resets.delete(keyId);
      return undefined;
    }
    return until;
  };
}
