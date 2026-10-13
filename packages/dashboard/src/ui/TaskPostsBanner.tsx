import type { ReactElement } from 'react';
import { Link } from 'wouter';

/** The `taskPosts` block `/api/tasks` and `/api/tasks/setup` return. */
export type TaskPosts = {
  readonly enabled: boolean;
  readonly offReason?: 'switch' | 'dry-run';
  /** The guild's own switch, which dry run can override. */
  readonly switchOn: boolean;
  readonly message: string;
};

/**
 * Says whether Discord posts for tasks go out. Off is a warning that carries
 * the server's text (how to turn it on); on is a short muted line. Renders
 * nothing when the API sent no state.
 */
export function TaskPostsBanner({
  posts,
}: {
  readonly posts: TaskPosts | undefined;
}): ReactElement | null {
  if (posts === undefined) return null;
  if (posts.enabled) {
    return <p className="mb-4 text-xs text-ink-muted">{posts.message}</p>;
  }
  return (
    <div
      className="mb-4 rounded-md border border-tone-hold bg-tone-hold-bg px-3 py-2 text-sm text-tone-hold-ink"
      role="status"
    >
      {posts.message}{' '}
      <Link href="/tasks" className="text-accent underline underline-offset-2">
        Open Tasks
      </Link>
    </div>
  );
}
