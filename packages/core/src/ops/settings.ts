/**
 * The per-guild settings `bananasaurs config set` may write (ADR 0025).
 *
 * A closed, enumerated list — not "every column on `guilds`". `killswitch` has
 * its own command, and `enabled`, `name` and the timestamps are not settings an
 * operator tunes. Adding one means adding it here and to the exhaustive
 * `switch` in the composition root, and the compiler fails the build if the
 * second is forgotten.
 *
 * These are spelled `lower_snake`; process configuration keeps its environment
 * spelling (`BANANASAURS_DRY_RUN`). The spelling is the namespace, so an
 * operator can see which of the two they are holding.
 */

/**
 * One settable key and how to read a command-line string as its value.
 *
 * `overriddenBy` is the load-bearing field. `applyConfiguredDryRun` writes
 * `guilds.dry_run` from the environment at every start, so `config set dry_run`
 * is durable only until the next restart unless the environment agrees. A
 * setting that silently reverts on the next deploy is the kind of thing an
 * operator discovers at the worst possible moment, so the command reports the
 * conflict rather than leaving it to be found.
 */
export interface OpsSettingSpec {
  readonly key: string;
  readonly kind: 'boolean' | 'positive-integer' | 'breaker';
  readonly describe: string;
  /** The environment key that overwrites this one at every start, if any. */
  readonly overriddenBy?: string;
}

export const OPS_SETTINGS: readonly OpsSettingSpec[] = [
  {
    key: 'dry_run',
    kind: 'boolean',
    describe: 'docs/18 layer 4: compute every effect, perform none',
    overriddenBy: 'BANANASAURS_DRY_RUN',
  },
  {
    key: 'role_rate_per_min',
    kind: 'positive-integer',
    describe: 'docs/18 layer 3: the standing per-source ceiling on role changes',
  },
  {
    key: 'reconcile_budget',
    kind: 'positive-integer',
    describe: 'the most role changes one reconciliation pass may make',
  },
  {
    key: 'breaker_threshold',
    kind: 'positive-integer',
    describe: 'consecutive failures before docs/18 layer 5 opens the breaker',
  },
  {
    key: 'breaker',
    kind: 'breaker',
    describe: 'set to `closed` to clear a tripped breaker; `open` is what `killswitch on` is for',
  },
];

/**
 * A validated change, ready for the composition root.
 *
 * Discriminated on `key`, so the `switch` that applies it narrows `value` to
 * the right type without a cast, and a new key with no branch fails to compile.
 */
export type OpsSettingChange =
  | { readonly key: 'dry_run'; readonly value: boolean }
  | { readonly key: 'role_rate_per_min'; readonly value: number }
  | { readonly key: 'reconcile_budget'; readonly value: number }
  | { readonly key: 'breaker_threshold'; readonly value: number }
  | { readonly key: 'breaker'; readonly value: 'closed' };

/** What a setting currently holds, for the audit row's `before`. */
export type OpsSettingValue = boolean | number | string;

/**
 * Reads a command-line string as the value its key expects.
 *
 * Returns a message rather than throwing, because every one of these is an
 * operator typo and the useful answer names the accepted values. `on`/`off` and
 * `true`/`false` are both accepted for a boolean: `docs/17` and `docs/21` use
 * both spellings and refusing either would be pedantry at the wrong moment.
 */
export const parseSettingValue = (
  spec: OpsSettingSpec,
  raw: string,
): { ok: true; change: OpsSettingChange } | { ok: false; message: string } => {
  const text = raw.trim().toLowerCase();

  switch (spec.kind) {
    case 'boolean': {
      const on = text === 'on' || text === 'true' || text === '1';
      const off = text === 'off' || text === 'false' || text === '0';
      if (!on && !off) {
        return { ok: false, message: `${spec.key} takes on|off, not "${raw}"` };
      }
      // `dry_run` is the only boolean setting; the cast-free way to say so is
      // to name the key rather than widen the union.
      return { ok: true, change: { key: 'dry_run', value: on } };
    }

    case 'positive-integer': {
      const value = Number(text);
      if (!Number.isInteger(value) || value <= 0) {
        // Zero is refused here as well as by the `guilds_positive_limits`
        // CHECK. A rate cap of zero does not throttle, it stops every role
        // change in the guild and reports nothing.
        return {
          ok: false,
          message: `${spec.key} takes a positive whole number, not "${raw}"`,
        };
      }
      if (spec.key === 'role_rate_per_min') {
        return { ok: true, change: { key: 'role_rate_per_min', value } };
      }
      if (spec.key === 'reconcile_budget') {
        return { ok: true, change: { key: 'reconcile_budget', value } };
      }
      return { ok: true, change: { key: 'breaker_threshold', value } };
    }

    case 'breaker': {
      if (text === 'closed') return { ok: true, change: { key: 'breaker', value: 'closed' } };
      if (text === 'open') {
        return {
          ok: false,
          message:
            'the breaker cannot be opened by hand: it opens on consecutive failures, and ' +
            'stopping the bot deliberately is what `killswitch on --confirm` is for. ' +
            'Two ways to halt effects would mean two states to check when it will not act.',
        };
      }
      return { ok: false, message: `breaker takes \`closed\`, not "${raw}"` };
    }
  }
};

export const findSetting = (key: string): OpsSettingSpec | undefined =>
  OPS_SETTINGS.find((s) => s.key === key);
