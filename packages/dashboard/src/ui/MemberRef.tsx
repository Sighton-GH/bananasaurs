import { Link } from 'wouter';

export interface MemberIdentity {
  readonly username: string;
  readonly displayName: string;
}

/**
 * A member as a person, not a snowflake: server nickname and username from
 * the live directory, with the id kept for precision and the member-history
 * link preserved. When Discord no longer knows the id (departed member, or
 * the directory is unavailable) the bare id renders with an honest note —
 * never a guessed name.
 */
export function MemberRef({
  id,
  member,
}: {
  readonly id: string;
  readonly member: MemberIdentity | null | undefined;
}) {
  const body =
    member === null || member === undefined ? (
      <>
        {id} <span className="text-xs text-ink-muted">(not in the live member directory)</span>
      </>
    ) : (
      <>
        {member.displayName}{' '}
        <span className="text-xs text-ink-muted">
          @{member.username} · {id}
        </span>
      </>
    );
  return <Link href={`/members/${encodeURIComponent(id)}`}>{body}</Link>;
}
