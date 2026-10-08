import { useCallback, useState } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import { ApiError } from '../api.js';
import {
  conversationEndUrl,
  conversationPageUrl,
  conversationUrl,
  type ConversationDetailResponse,
  type ConversationLinkRow,
  type ConversationTurnRow,
} from '../api/conversations.js';
import { historyUrl } from '../api/traces.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DataState } from '../ui/DataState.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';
import { WhatTheAiSaw } from './what-the-ai-saw.js';

const feedbackBadge = (feedback: 'up' | 'down') => (
  <Badge>
    <span role="img" aria-label={feedback === 'up' ? 'Thumbs up' : 'Thumbs down'}>
      {feedback === 'up' ? '👍' : '👎'}
    </span>
  </Badge>
);

/** Plain-words notes for the continue rules; starting rules show nothing. */
const JOIN_NOTES: Record<string, string> = {
  'reply-to-bot': 'Replied to the bot',
  'reply-to-turn': 'Replied to an earlier message',
  'follow-up': 'Follow-up from the same member',
  thread: 'Asked in the same thread',
  'channel-follow-up': 'Joined as a follow-up from another member in the channel',
};

/** The link kind in words, with the direction where the kind needs it. */
const linkWords = (link: ConversationLinkRow): string => {
  if (link.kind === 'same-channel') return 'In the same channel at the same time';
  if (link.kind === 'thread-parent') {
    return link.direction === 'outgoing'
      ? 'Continues in a thread started from'
      : 'Has a thread conversation';
  }
  return link.direction === 'outgoing' ? 'Looked back at' : 'Looked back at by';
};

function Turn({ turn }: { readonly turn: ConversationTurnRow }) {
  const at = new Date(turn.at);
  const joinNote =
    turn.role === 'user' && turn.joinRule !== undefined
      ? (JOIN_NOTES[turn.joinRule] ?? null)
      : null;
  if (turn.role === 'quote') {
    return (
      <figure className="rounded-sm border border-line bg-canvas px-3 py-2">
        <figcaption className="text-xs text-ink-muted">
          <span>Quoted message</span>
          {` from ${turn.authorName}`} ·{' '}
          <time dateTime={at.toISOString()}>{at.toLocaleString('en-CA')}</time>
        </figcaption>
        <blockquote className="mt-1 border-l-2 border-line pl-3 text-sm whitespace-pre-wrap text-ink-muted">
          {turn.text}
        </blockquote>
      </figure>
    );
  }
  const who = turn.role === 'assistant' ? 'Bananasaurs' : turn.authorName;
  // ADR 0129: a failed assistant turn renders inside a danger container, with
  // the failure's title, model and provider message above the saved reply. A
  // refused turn gets a neutral badge; answered turns are unchanged.
  const failed = turn.role === 'assistant' && turn.outcome === 'failed';
  const refused = turn.role === 'assistant' && turn.outcome === 'refused';
  const inner = (
    <div>
      <p className="text-sm">
        <span className="font-medium">{who}</span>{' '}
        <span className="text-xs text-ink-muted">
          <time dateTime={at.toISOString()}>{at.toLocaleString('en-CA')}</time>
        </span>{' '}
        {turn.feedback !== undefined && feedbackBadge(turn.feedback)}
        {refused && (
          <>
            {' '}
            <Badge>Refused</Badge>
          </>
        )}
        {failed && (
          <>
            {' '}
            <Badge tone="danger">Failed</Badge>
          </>
        )}
      </p>
      {joinNote !== null && <p className="text-xs text-ink-muted">{joinNote}</p>}
      {failed && turn.failure !== undefined && (
        <div className="mt-1">
          <p className="text-sm">
            <strong>{turn.failure.title}</strong>
            {turn.failure.model !== undefined && (
              <span className="text-ink-muted"> — {turn.failure.model}</span>
            )}
          </p>
          {turn.failure.providerMessage !== undefined && (
            <code className="mt-1 block overflow-x-auto font-mono text-xs whitespace-pre-wrap">
              {turn.failure.providerMessage}
            </code>
          )}
        </div>
      )}
      <p className="mt-1 text-sm whitespace-pre-wrap">{turn.text}</p>
      {turn.role === 'assistant' && (
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {turn.sources !== undefined && turn.sources.length > 0 && (
            <span className="text-ink-muted">
              Sources:{' '}
              {turn.sources.map((s, i) => (
                <span key={s.url}>
                  {i > 0 && ', '}
                  <a href={s.url} target="_blank" rel="noreferrer">
                    {s.title}
                  </a>
                </span>
              ))}
            </span>
          )}
          {turn.traceId !== undefined && <Link href={historyUrl(turn.traceId)}>View details</Link>}
        </div>
      )}
      {turn.role === 'assistant' && turn.traceId !== undefined && (
        <WhatTheAiSaw traceId={turn.traceId} />
      )}
    </div>
  );
  if (failed) {
    return <div className="rounded border border-danger/40 bg-danger/5 p-3">{inner}</div>;
  }
  return inner;
}

/**
 * `/assistant/conversations/:id`: one conversation as a chat transcript —
 * oldest first, quote turns as muted quoted blocks, user turns with a
 * plain-words note for how they joined, assistant turns with their sources
 * line and a link to the History trace, feedback and dashboard-test badges,
 * a Links card for the linked conversations, and End / Delete (confirmed)
 * buttons.
 */
export function AssistantConversationPage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession();
  const toast = useToast();
  const [, setLocation] = useLocation();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    return session.read<ConversationDetailResponse>(conversationUrl(id)).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) {
        throw new Error('no conversation with this id is stored for this server');
      }
      if (err instanceof ApiError && err.status === 403) {
        throw new Error('your account does not hold the audit view grant (audit.read)');
      }
      throw err;
    });
  }, [session, id]);
  const detail = useResource('conversation', load);

  const endConversation = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const saved = await session.write(conversationEndUrl(id), {}, 'POST');
      if (saved !== undefined) {
        toast({ tone: 'ok', title: 'Ended the conversation.' });
        detail.reload();
      }
    } finally {
      setBusy(false);
    }
  };

  const deleteConversation = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const deleted = await session.write(conversationUrl(id), undefined, 'DELETE');
      if (deleted !== undefined) {
        setConfirmDelete(false);
        toast({ tone: 'ok', title: 'Deleted the conversation.' });
        setLocation('/assistant/conversations');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Conversation"
        purpose="Every turn of one conversation, oldest first."
        actions={
          <Link href="/assistant/conversations">
            <Button>Conversations</Button>
          </Link>
        }
      />
      <DataState resource={detail.resource}>
        {({ conversation, summary, turns, links }) => (
          <div className="grid gap-4">
            <Card title="Summary">
              <h2 className="text-base font-medium">{conversation.title}</h2>
              <div className="mt-2 flex flex-wrap gap-2">
                <Badge tone={conversation.status === 'open' ? 'ok' : 'neutral'}>
                  {conversation.status === 'open' ? 'Open' : 'Ended'}
                </Badge>
                {conversation.source === 'dashboard-test' && <Badge>Dashboard test</Badge>}
              </div>
              <dl className="mt-2 grid gap-1 text-sm text-ink-muted">
                <div>
                  <dt className="inline">Channel </dt>
                  <dd className="inline font-mono text-xs">{conversation.channelId}</dd>
                </div>
                <div>
                  <dt className="inline">Behaviour </dt>
                  <dd className="inline">{conversation.behaviourId}</dd>
                </div>
                <div>
                  <dt className="inline">Started by </dt>
                  <dd className="inline font-mono text-xs">{conversation.startedBy}</dd>
                </div>
                <div>
                  <dt className="inline">Turns </dt>
                  <dd className="inline">{turns.length}</dd>
                </div>
                <div>
                  <dt className="inline">Last activity </dt>
                  <dd className="inline">
                    {new Date(conversation.lastActivityAt).toLocaleString('en-CA')}
                  </dd>
                </div>
              </dl>
              <div className="mt-3 flex flex-wrap gap-2">
                {conversation.status === 'open' && (
                  <Button onClick={() => void endConversation()} busy={busy}>
                    End conversation
                  </Button>
                )}
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                  Delete conversation
                </Button>
              </div>
            </Card>
            <Card title="Summary so far">
              {summary === null || summary === undefined ? (
                <p className="text-sm text-ink-muted">
                  No summary yet. Long conversations get one once earlier messages drop out of what
                  the AI sees.
                </p>
              ) : (
                <>
                  <p className="text-sm whitespace-pre-wrap">{summary.text}</p>
                  <p className="mt-2 text-xs text-ink-muted">
                    Updated{' '}
                    <time dateTime={new Date(summary.updatedAt).toISOString()}>
                      {new Date(summary.updatedAt).toLocaleString('en-CA')}
                    </time>{' '}
                    · version {summary.version}
                  </p>
                </>
              )}
            </Card>
            <Card title="Transcript">
              {turns.length === 0 ? (
                <p className="text-sm text-ink-muted">No turns yet.</p>
              ) : (
                <ol className="grid gap-4">
                  {turns.map((turn) => (
                    <li key={turn.turnId}>
                      <Turn turn={turn} />
                    </li>
                  ))}
                </ol>
              )}
            </Card>
            <Card title="Linked conversations">
              {links.length === 0 ? (
                <p className="text-sm text-ink-muted">No linked conversations.</p>
              ) : (
                <ul className="grid gap-2">
                  {links.map((link) => {
                    const at = new Date(link.at);
                    return (
                      <li
                        key={`${link.otherConversationId}-${link.kind}-${link.direction}`}
                        className="text-sm"
                      >
                        <Link href={conversationPageUrl(link.otherConversationId)}>
                          {link.otherTitle}
                        </Link>{' '}
                        <span className="text-ink-muted">
                          <span>{linkWords(link)}</span> ·{' '}
                          <time dateTime={at.toISOString()}>{at.toLocaleString('en-CA')}</time>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
            <ConfirmDialog
              open={confirmDelete}
              title="Delete this conversation?"
              scope={
                <p>
                  This deletes “{conversation.title}” and its {turns.length} turns for good. Its run
                  details go too.
                </p>
              }
              confirmLabel="Delete conversation"
              danger
              busy={busy}
              onConfirm={() => void deleteConversation()}
              onCancel={() => setConfirmDelete(false)}
            />
          </div>
        )}
      </DataState>
    </>
  );
}
