import { createHash } from 'node:crypto';
import type { GuildId } from '../ids.js';
import { safeLogFields, type Logger } from '../obs/logger.js';
import type { SafetyStateForSend } from './message-gateway.js';

/**
 * The one pipeline every MCP write runs through (ADR 0116 §1).
 *
 * A generalisation of `message-gateway.ts`'s `sendMessageEffect`, which stays
 * unchanged for any non-MCP caller: the MCP no longer calls it. The layer
 * order is the same order that module argues for, with the allowlist replaced
 * by the caller's target policy:
 *
 *   1. target policy                 -> refuse
 *   2. kill switch                   -> refuse
 *   3. circuit breaker               -> refuse
 *   4. idempotency read              -> replay, or refuse on mismatch
 *   5. identical-content window      -> refuse (message posts only)
 *   6. rate cap                      -> refuse   [new actions only]
 *   7. idempotency claim             -> INSERT OR IGNORE
 *   8. dry run                       -> record, no Discord call
 *   9. execute                       -> the caller's single REST call
 *  10. record                        -> outcome, result ids, audit row
 *
 * The order is not arbitrary. The target refusal comes before the state read
 * so nothing else — not even a safety-state read — runs for a target the
 * policy never allowed. The idempotency read comes before the rate cap
 * because a replay is not a new action (the M5-D9 argument): with the cap
 * ahead of the ledger read, a client retrying an already-succeeded action
 * would be told `rate-cap` once the hour filled — told its action failed
 * while the effect sat in Discord. The cap still binds every genuinely new
 * action, because a replay returns the stored result and calls nothing. The
 * claim stays immediately before the dry run and the call, which is the
 * property that makes a crash between claim and call safe; moving it earlier
 * would be a different mistake. A dry run claims first, so it still costs
 * rate-cap room — letting it be free would make the cap depend on a safety
 * toggle.
 *
 * NOTE (M5-D12, carried over): this pipeline respects the circuit breaker but
 * must never trip it — deliberately asymmetric with `gateway.ts`, where a
 * rate-cap overflow trips the breaker. The breaker is guild-wide and shared
 * with the moderation effect path: if an MCP action hitting its cap opened
 * it, the owner's Claude client — or anything driving that client — would
 * hold a lever that pauses moderation effects for the entire guild. So this
 * module refuses when the breaker is open and calls nothing that opens it.
 * That is why `McpActionDeps.state` has no `tripBreaker`: there is nowhere
 * to thread one through. Do not "fix" the asymmetry by adding a trip on the
 * rate-cap path.
 *
 * The pipeline takes no `DiscordPort`: the caller's `execute` closure owns
 * the single REST call. Content never reaches the logs or the audit rows —
 * only the action kind, ids, the outcome and the action id.
 */

export type McpCapGroup = 'message' | 'edit' | 'member_role' | 'structure' | 'pin_react';

/**
 * Caps per guild per rolling hour, counted from `mcp_actions` rows by cap
 * group (ADR 0116 §6). Exists only as the defaults source for the
 * `mcp.cap.*` instance settings (ADR 0119 §4): `runMcpAction` reads its cap
 * from `McpActionDeps.capFor`, never from this constant.
 */
export const MCP_ACTION_CAPS: Readonly<Record<McpCapGroup, number>> = {
  message: 300,
  edit: 300,
  /** Each member counts; a bulk job of 100 members uses 100 (ADR 0118 §8). */
  member_role: 1000,
  /** Threads, polls, events, panels, role create/edit (ADR 0118 §8). */
  structure: 100,
  pin_react: 300,
};

export const MCP_ACTION_WINDOW_MS = 60 * 60 * 1000;

/**
 * The identical-content window (M5-D8 layer B, carried over by ADR 0116 §7):
 * identical arguments to the same target inside sixty seconds are a refusal,
 * whatever the key says — a model client that retries a timed-out call
 * regenerates its arguments, including a random key, so the key cannot see
 * that retry. Sixty seconds, not the cap's hour, so the same action is still
 * possible tomorrow. Applies to message posts only, via
 * `McpActionIntent.duplicateContentGuard`.
 */
export const MCP_ACTION_DUPLICATE_WINDOW_MS = 60 * 1000;

/**
 * The argument hash. `sha256` of the canonical JSON (object keys sorted
 * recursively) of `{ kind, args }` — the kind is in the hash so two tools
 * with the same arguments are never the same action. A pure function rather
 * than a port, like `contentHashFor`: getting it wrong silently breaks
 * idempotency, and a port would let each caller get it wrong differently.
 *
 * Plain-text sends keep `contentHashFor(channelId, content)` instead, so a
 * retry that straddles the migration-0092 deploy replays rather than posting
 * twice (ADR 0116 §2).
 */
export const argsHashFor = (kind: string, args: unknown): string =>
  createHash('sha256').update(canonicalJson({ kind, args })).digest('hex');

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
};

// NOTE: the plan sketches this as `McpActionIntent<A>`, but the parameter is
// vestigial — only `argsHash` crosses this boundary, never the args, so there
// is nothing for `A` to describe. Both `tsc --noUnusedLocals` (TS6133) and
// `@typescript-eslint/no-unused-vars` reject the unused parameter, so the
// interface is non-generic. Callers needing the argument shape keep it on
// their own side and hash it with `argsHashFor`.
export interface McpActionIntent {
  readonly kind: string;
  readonly capGroup: McpCapGroup;
  readonly idempotencyKey: string;
  /** The `tok_…` row id that authorised this action. Never a token value. */
  readonly tokenId: string;
  readonly argsHash: string;
  readonly targetChannelId: string | undefined;
  readonly dryRun: boolean;
  /** M5-D8 layer B: message posts only. */
  readonly duplicateContentGuard: boolean;
  /**
   * How many cap units this action costs (ADR 0118 §8: a bulk role change
   * costs its member count). Absent means 1, so every existing caller keeps
   * the old `countSince >= cap` behaviour exactly — `count + 1 > cap` is the
   * same comparison.
   */
  readonly weight?: number | undefined;
}

export type McpActionRefusal =
  | 'target'
  | 'killswitch'
  | 'breaker-open'
  | 'rate-cap'
  | 'key-reused-with-other-args'
  | 'duplicate-content-recently'
  | 'guild-unknown';

export type McpActionOutcome<R> =
  | { status: 'done'; actionId: string; result: R }
  | { status: 'dry-run'; actionId: string }
  | { status: 'replayed'; actionId: string; resultMessageId?: string; resultThreadId?: string }
  | { status: 'refused'; reason: McpActionRefusal; detail?: string }
  | { status: 'failed'; actionId: string; code: string };

/** One claimed row of the `mcp_actions` ledger, as the pipeline sees it. */
export interface McpActionLedgerRow {
  readonly actionId: string;
  readonly argsHash: string;
  readonly resultMessageId?: string;
  readonly resultThreadId?: string;
}

/** The row the pipeline claims: INSERT OR IGNORE on the idempotency key. */
export interface McpActionClaim {
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly capGroup: McpCapGroup;
  readonly argsHash: string;
  readonly tokenId: string;
  readonly targetChannelId?: string;
  readonly dryRun: boolean;
  readonly now: number;
}

export interface McpActionCompletion {
  readonly status: 'done' | 'failed';
  readonly resultMessageId?: string;
  readonly resultThreadId?: string;
  readonly undo?: unknown;
  readonly now: number;
}

/**
 * What the pipeline reports per accepted action. Carries the kind and the
 * ids, never content — content lives in Discord, and only the bot's own
 * previous content may rest in `undo_json` (a storage concern, opaque here).
 */
export interface McpActionAuditInput {
  readonly kind: string;
  readonly actionId: string;
  readonly outcome: 'done' | 'dry-run' | 'failed';
  readonly targetChannelId?: string;
  readonly resultMessageId?: string;
  readonly resultThreadId?: string;
  readonly tokenId: string;
  readonly dryRun: boolean;
  readonly atMs: number;
}

/**
 * Everything the pipeline needs, as ports.
 *
 * `core` holds the ordering and the decisions; the guild scope, the database
 * handle and the concrete Discord client all stay on the other side of these
 * interfaces — the same split `EffectGatewayDeps` uses. Note what is absent:
 * there is no `DiscordPort` (the caller's `execute` closure owns the single
 * REST call) and no `tripBreaker` (M5-D12: this pipeline never trips the
 * breaker, so there is nothing to call).
 */
export interface McpActionDeps {
  readonly guildId: GuildId;
  readonly logger: Logger;
  now(): number;
  newActionId(): string;
  capFor(capGroup: McpCapGroup): number;
  readonly state: {
    read(): SafetyStateForSend | undefined;
  };
  readonly ledger: {
    find(key: string): McpActionLedgerRow | undefined;
    claim(row: McpActionClaim): { claimed: boolean };
    complete(actionId: string, result: McpActionCompletion): void;
    countSince(capGroup: McpCapGroup, sinceMs: number): number;
    /** M5-D8 layer B: identical arguments against this target within the window. */
    recentSameContent(argsHash: string, channelId: string | undefined, sinceMs: number): boolean;
  };
  readonly audit: { record(input: McpActionAuditInput): void };
}

export const runMcpAction = async <
  R extends { resultMessageId?: string; resultThreadId?: string; undo?: unknown },
>(
  deps: McpActionDeps,
  intent: McpActionIntent,
  /** Policy result computed by the caller from live state BEFORE calling; a string is the refusal detail. */
  targetCheck: true | string,
  execute: () => Promise<R>,
): Promise<McpActionOutcome<R>> => {
  const now = deps.now();
  const refuse = (reason: McpActionRefusal, detail?: string): McpActionOutcome<R> => {
    deps.logger.warn(
      safeLogFields({
        component: 'mcp-actions',
        guildId: deps.guildId,
        ...(intent.targetChannelId !== undefined ? { channelId: intent.targetChannelId } : {}),
        oauthTokenId: intent.tokenId,
        dedupeKey: intent.idempotencyKey,
        kind: intent.kind,
        outcome: 'refused',
        reason,
      }),
      'mcp action refused',
    );
    return {
      status: 'refused',
      reason,
      ...(detail !== undefined ? { detail } : {}),
    };
  };

  // --- 1. target policy -----------------------------------------------------
  // The caller's verdict from live state, checked before anything else so
  // nothing — not even a safety-state read — runs for a target the policy
  // never allowed.
  if (targetCheck !== true) return refuse('target', targetCheck);

  // --- 2, 3. kill switch and breaker ----------------------------------------
  const state = deps.state.read();
  if (state === undefined) return refuse('guild-unknown');
  if (state.killswitch) return refuse('killswitch');
  if (state.breakerOpen) return refuse('breaker-open');

  // --- 4. idempotency read ----------------------------------------------------
  // Read before anything that depends on present conditions. Three outcomes:
  // key absent means continue toward the call; key present with a matching
  // hash means replay the first result and call nothing; key present with a
  // different hash means refuse, because a client told its action succeeded
  // when it never ran is the failure this design is against.
  const existing = deps.ledger.find(intent.idempotencyKey);
  if (existing !== undefined) {
    if (existing.argsHash === intent.argsHash) {
      return {
        status: 'replayed',
        actionId: existing.actionId,
        ...(existing.resultMessageId !== undefined
          ? { resultMessageId: existing.resultMessageId }
          : {}),
        ...(existing.resultThreadId !== undefined
          ? { resultThreadId: existing.resultThreadId }
          : {}),
      };
    }
    return refuse('key-reused-with-other-args');
  }

  // --- 5. identical-content window ---------------------------------------------
  // Layer B: identical arguments against this target inside sixty seconds are
  // a refusal whatever the key says, but only for message posts
  // (`duplicateContentGuard`). Checked before the cap and the claim so it
  // costs no capacity, no key and no row.
  if (
    intent.duplicateContentGuard &&
    deps.ledger.recentSameContent(
      intent.argsHash,
      intent.targetChannelId,
      now - MCP_ACTION_DUPLICATE_WINDOW_MS,
    )
  ) {
    return refuse('duplicate-content-recently');
  }

  // --- 6. rate cap -------------------------------------------------------------
  // Durable: counted from `mcp_actions` rows, never an in-memory bucket, so a
  // restart does not hand out more. Counted: claimed, done and dry_run rows.
  // Not counted: refusals — otherwise a client hammering a refused target
  // would lock the owner out of the actions they can take — and failures. And
  // not consulted for replays at all: those returned above, because a replay
  // is not a new action — only genuinely new actions reach this line. The
  // detail is the reset time: with a rolling window the ledger cannot name
  // the exact freeing row through this port, so it is the conservative upper
  // bound, one full window out. It never trips the breaker (M5-D12). A bulk
  // role change carries its member count as the weight, so one confirm of 100
  // members costs 100 units of the member_role cap (ADR 0118 §8).
  const weight = intent.weight ?? 1;
  if (
    deps.ledger.countSince(intent.capGroup, now - MCP_ACTION_WINDOW_MS) + weight >
    deps.capFor(intent.capGroup)
  ) {
    return refuse('rate-cap', new Date(now + MCP_ACTION_WINDOW_MS).toISOString());
  }

  // --- 7. idempotency claim ------------------------------------------------------
  // Before the dry run and the call, deliberately (hard rule 6). If the
  // process dies between the claim and the call, the row is already there and
  // a retry replays it — the failure direction that does not double-execute.
  // A lost race on one key re-reads to decide replay (hash matches) from
  // collision (hash differs) rather than guessing. The claim carries the
  // dry-run flag so the row already records the dry run's status: a dry run
  // still costs rate-cap room.
  const dry = intent.dryRun || state.dryRun;
  const actionId = deps.newActionId();
  const claim = deps.ledger.claim({
    actionId,
    idempotencyKey: intent.idempotencyKey,
    kind: intent.kind,
    capGroup: intent.capGroup,
    argsHash: intent.argsHash,
    tokenId: intent.tokenId,
    ...(intent.targetChannelId !== undefined ? { targetChannelId: intent.targetChannelId } : {}),
    dryRun: dry,
    now,
  });
  if (!claim.claimed) {
    const raced = deps.ledger.find(intent.idempotencyKey);
    if (raced !== undefined && raced.argsHash === intent.argsHash) {
      return {
        status: 'replayed',
        actionId: raced.actionId,
        ...(raced.resultMessageId !== undefined ? { resultMessageId: raced.resultMessageId } : {}),
        ...(raced.resultThreadId !== undefined ? { resultThreadId: raced.resultThreadId } : {}),
      };
    }
    return refuse('key-reused-with-other-args');
  }

  // --- 8. dry run -----------------------------------------------------------------
  // Recorded, not executed: the ledger row already exists (claimed above as a
  // dry run), so a dry-run action still costs rate-cap room — letting it be
  // free would make the cap depend on a safety toggle.
  if (dry) {
    deps.audit.record({
      kind: intent.kind,
      actionId,
      outcome: 'dry-run',
      ...(intent.targetChannelId !== undefined ? { targetChannelId: intent.targetChannelId } : {}),
      tokenId: intent.tokenId,
      dryRun: true,
      atMs: deps.now(),
    });
    deps.logger.info(
      safeLogFields({
        component: 'mcp-actions',
        guildId: deps.guildId,
        ...(intent.targetChannelId !== undefined ? { channelId: intent.targetChannelId } : {}),
        oauthTokenId: intent.tokenId,
        dedupeKey: intent.idempotencyKey,
        effectId: actionId,
        kind: intent.kind,
        dryRun: true,
        outcome: 'dry-run',
      }),
      'dry run: no Discord call was made',
    );
    return { status: 'dry-run', actionId };
  }

  // --- 9. execute -------------------------------------------------------------------
  // The caller's single REST call. A throw completes the claim as `failed`
  // and audits the attempt as `failed` without claiming nothing was posted —
  // nobody knows that (the response may have been lost). The ledger row
  // stays, so a retry with the same key replays instead of double-executing.
  let result: R;
  try {
    result = await execute();
  } catch (err) {
    const code = err instanceof Error ? err.name : 'UnknownError';
    deps.ledger.complete(actionId, { status: 'failed', now: deps.now() });
    deps.audit.record({
      kind: intent.kind,
      actionId,
      outcome: 'failed',
      ...(intent.targetChannelId !== undefined ? { targetChannelId: intent.targetChannelId } : {}),
      tokenId: intent.tokenId,
      dryRun: false,
      atMs: deps.now(),
    });
    deps.logger.error(
      safeLogFields({
        component: 'mcp-actions',
        guildId: deps.guildId,
        ...(intent.targetChannelId !== undefined ? { channelId: intent.targetChannelId } : {}),
        oauthTokenId: intent.tokenId,
        dedupeKey: intent.idempotencyKey,
        effectId: actionId,
        kind: intent.kind,
        outcome: 'failed',
        code,
        err,
      }),
      'the Discord call failed',
    );
    return { status: 'failed', actionId, code };
  }

  // --- 10. record --------------------------------------------------------------------
  deps.ledger.complete(actionId, {
    status: 'done',
    ...(result.resultMessageId !== undefined ? { resultMessageId: result.resultMessageId } : {}),
    ...(result.resultThreadId !== undefined ? { resultThreadId: result.resultThreadId } : {}),
    ...(result.undo !== undefined ? { undo: result.undo } : {}),
    now: deps.now(),
  });
  deps.audit.record({
    kind: intent.kind,
    actionId,
    outcome: 'done',
    ...(intent.targetChannelId !== undefined ? { targetChannelId: intent.targetChannelId } : {}),
    ...(result.resultMessageId !== undefined ? { resultMessageId: result.resultMessageId } : {}),
    ...(result.resultThreadId !== undefined ? { resultThreadId: result.resultThreadId } : {}),
    tokenId: intent.tokenId,
    dryRun: false,
    atMs: deps.now(),
  });

  return { status: 'done', actionId, result };
};
