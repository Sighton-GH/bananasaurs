import { useState } from 'react';
import { useSession } from '../../app/session.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { ConfirmDialog } from '../../ui/ConfirmDialog.js';
import { useToast } from '../../ui/Toast.js';
import type { TaskPosts } from '../../ui/TaskPostsBanner.js';

/**
 * ADR 0131: the per-server Task posts switch, at the top of the Tasks page.
 * Turning it on asks first; turning it off does not. Dry run can still hold
 * posts back, and the text says so.
 */
export function TaskPostsSwitch({
  posts,
  onChanged,
}: {
  readonly posts: TaskPosts;
  readonly onChanged: () => void;
}) {
  const session = useSession();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const apply = async (enabled: boolean) => {
    setBusy(true);
    try {
      const result = await session.write<{ enabled: boolean }>(
        '/api/tasks/posting',
        { enabled },
        'PUT',
      );
      if (result !== undefined) {
        toast({ tone: 'ok', title: `Task posts are now ${enabled ? 'on' : 'off'}` });
        onChanged();
      }
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <Card title="Task posts">
      <p
        className={
          posts.enabled
            ? 'text-sm text-ink-muted'
            : 'rounded-md border border-tone-hold bg-tone-hold-bg px-3 py-2 text-sm text-tone-hold-ink'
        }
        role="status"
      >
        {posts.message}
      </p>
      <div className="mt-2">
        {posts.switchOn ? (
          <Button disabled={busy} onClick={() => void apply(false)}>
            Turn off task posts
          </Button>
        ) : (
          <Button variant="primary" disabled={busy} onClick={() => setConfirming(true)}>
            Turn on task posts
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        title="Turn on task posts?"
        scope={
          <p>
            Bananasaurs will post new tasks, reminders, check-ins and weekly digests in this
            server&apos;s task channels. Posts skipped while the switch was off are not sent later.
          </p>
        }
        confirmLabel="Turn on"
        busy={busy}
        onConfirm={() => void apply(true)}
        onCancel={() => setConfirming(false)}
      />
    </Card>
  );
}
