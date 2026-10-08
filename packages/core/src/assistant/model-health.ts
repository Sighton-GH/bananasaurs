/**
 * Per-model health from the run ledger (ADR 0129 §8).
 *
 * Advisory only (CLAUDE.md rule 1): nothing here disables, reorders or skips
 * a chain entry. The health route and the doctor finding read these structs;
 * the model chain never does.
 */

/** ADR 0129 §8: failure codes that will not clear by themselves; three in a row raise the alarm. */
export const PERSISTENT_CODES = [
  'provider-bad-model',
  'provider-auth',
  'provider-credits',
] as const;

/** ADR 0129 §8: the trailing-run length that raises the alarm. */
export const PERSISTENT_RUN = 3;

export interface ModelResult {
  readonly at: number;
  readonly model: string;
  readonly keyId: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly code?: string;
  readonly providerMessage?: string;
  readonly tokens?: number;
  readonly costUsd?: number;
}

export interface ModelHealth {
  readonly model: string;
  readonly keyId: string;
  readonly calls: number;
  readonly ok: number;
  /** ok / calls, or null with no calls. */
  readonly successRate: number | null;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly tokens: number;
  readonly costUsd: number;
  readonly failuresByCode: Readonly<Record<string, number>>;
  readonly lastError?:
    { readonly at: number; readonly code: string; readonly providerMessage?: string } | undefined;
  readonly lastOkAt?: number | undefined;
  /** The trailing run of failures with one persistent code, when it is at least PERSISTENT_RUN long. */
  readonly persistent?:
    { readonly code: string; readonly since: number; readonly count: number } | undefined;
}

/** Nearest-rank percentile over sorted `ms`, or null for an empty group. */
const percentile = (sortedMs: readonly number[], rank: number): number | null => {
  if (sortedMs.length === 0) return null;
  return sortedMs[Math.ceil(rank * sortedMs.length) - 1] ?? null;
};

const healthOf = (model: string, keyId: string, group: readonly ModelResult[]): ModelHealth => {
  // Oldest first: the trailing-run walk and `lastError` both read from the end.
  const sorted = [...group].sort((a, b) => a.at - b.at);
  const calls = sorted.length;
  const ok = sorted.filter((r) => r.ok).length;
  const ms = sorted.map((r) => r.ms).sort((a, b) => a - b);
  const failuresByCode: Record<string, number> = {};
  for (const r of sorted) {
    if (r.ok) continue;
    const code = r.code ?? 'unknown';
    failuresByCode[code] = (failuresByCode[code] ?? 0) + 1;
  }
  // ADR 0129 §8: walk from the newest result backwards while the result is
  // failed AND its code equals the newest result's code AND that code is in
  // PERSISTENT_CODES.
  let persistent: ModelHealth['persistent'] = undefined;
  const newest = sorted.at(-1);
  const newestCode = newest !== undefined && !newest.ok ? (newest.code ?? 'unknown') : undefined;
  if (newestCode !== undefined && (PERSISTENT_CODES as readonly string[]).includes(newestCode)) {
    let count = 0;
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      const r = sorted[i]!;
      if (r.ok || (r.code ?? 'unknown') !== newestCode) break;
      count += 1;
    }
    if (count >= PERSISTENT_RUN)
      persistent = { code: newestCode, count, since: sorted[sorted.length - count]!.at };
  }
  const lastFailure = sorted.findLast((r) => !r.ok);
  const lastOk = sorted.findLast((r) => r.ok);
  return {
    model,
    keyId,
    calls,
    ok,
    successRate: calls === 0 ? null : ok / calls,
    p50Ms: percentile(ms, 0.5),
    p95Ms: percentile(ms, 0.95),
    tokens: sorted.reduce((sum, r) => sum + (r.tokens ?? 0), 0),
    costUsd: sorted.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
    failuresByCode,
    ...(lastFailure === undefined
      ? {}
      : {
          lastError: {
            at: lastFailure.at,
            code: lastFailure.code ?? 'unknown',
            ...(lastFailure.providerMessage === undefined
              ? {}
              : { providerMessage: lastFailure.providerMessage }),
          },
        }),
    ...(lastOk === undefined ? {} : { lastOkAt: lastOk.at }),
    ...(persistent === undefined ? {} : { persistent }),
  };
};

/** Groups by (keyId, model), sorts each group by `at`, computes the fields above. Pure. */
export const modelHealth = (results: readonly ModelResult[]): ModelHealth[] => {
  const groups = new Map<string, { model: string; keyId: string; rows: ModelResult[] }>();
  for (const r of results) {
    const key = JSON.stringify([r.keyId, r.model]);
    const group = groups.get(key) ?? { model: r.model, keyId: r.keyId, rows: [] };
    group.rows.push(r);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) =>
      a.keyId < b.keyId
        ? -1
        : a.keyId > b.keyId
          ? 1
          : a.model < b.model
            ? -1
            : a.model > b.model
              ? 1
              : 0,
    )
    .map((g) => healthOf(g.model, g.keyId, g.rows));
};
