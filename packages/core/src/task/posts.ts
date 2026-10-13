/**
 * Whether Discord posts for club tasks go out, and the one wording every
 * surface (MCP results, dashboard banner, doctor) uses to say so.
 *
 * Posts go out only when the guild's switch (`guilds.task_posts_enabled`,
 * ADR 0131) is on and `BANANASAURS_DRY_RUN` is off. Posts skipped while off settle as `planned` and are never sent later
 * (ADR 0111 R9). The text names env var names only, never values or secrets.
 */
export type TaskPostsOffReason = 'switch' | 'dry-run';

export type TaskPostsState =
  { readonly enabled: true } | { readonly enabled: false; readonly offReason: TaskPostsOffReason };

export const taskPostsState = (input: {
  readonly switchOn: boolean;
  readonly dryRun: boolean;
}): TaskPostsState => {
  if (input.dryRun) return { enabled: false, offReason: 'dry-run' };
  if (!input.switchOn) return { enabled: false, offReason: 'switch' };
  return { enabled: true };
};

/** What the post is called in the "on" sentence, e.g. `announcement`, `approval request`. */
export type TaskPostKind = 'announcement' | 'approval request' | 'update';

const SKIPPED = 'Posts skipped while off are not sent later.';

/** The text MCP results and doctor use when posts are off. */
export const taskPostsOffText = (offReason: TaskPostsOffReason): string =>
  offReason === 'dry-run'
    ? 'Nothing was posted to Discord: dry run is on for this install (BANANASAURS_DRY_RUN), so task posts are off whatever the server switch says. ' +
      "To end dry run, set BANANASAURS_DRY_RUN=0 in the bot's .env file and restart the bot (sudo systemctl restart bananasaurs). " +
      SKIPPED
    : 'Nothing was posted to Discord: task posts are off for this server. ' +
      "The owner (or anyone with Manage club tasks) can turn them on with the Task posts switch on the dashboard's Tasks page. " +
      SKIPPED;

/** The banner text the dashboard shows when posts are off. */
export const taskPostsBannerText = (offReason: TaskPostsOffReason): string =>
  offReason === 'dry-run'
    ? 'Task posts are off because dry run is on for this install (BANANASAURS_DRY_RUN): tasks are saved but nothing is posted to Discord.'
    : 'Task posts are off for this server — tasks are saved but nothing is posted to Discord. Turn them on with the Task posts switch on the Tasks page.';

export const taskPostsMessage = (state: TaskPostsState, kind: TaskPostKind): string =>
  state.enabled
    ? `Task posts are on: the ${kind} is posted to Discord within a minute.`
    : taskPostsOffText(state.offReason);

/**
 * ADR 0131: `TASK_NUDGE_SEND_ENABLED` is gone (the schema ignores unknown keys,
 * so a leftover .env line cannot break startup). The warning for the operator
 * who still has it set, or undefined when there is nothing to say.
 */
export const staleTaskPostsEnvWarning = (
  env: Record<string, string | undefined>,
): string | undefined =>
  env['TASK_NUDGE_SEND_ENABLED'] === undefined
    ? undefined
    : 'TASK_NUDGE_SEND_ENABLED is no longer used; turn task posts on per server in the dashboard';
