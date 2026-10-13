import { useCallback, useState } from 'react';
import { Link } from 'wouter';
import { ApiError } from '../../api.js';
import {
  behaviourPreviewUrl,
  behaviourTryUrl,
  type BehaviourPreview,
  type TryItResponse,
} from '../../api/assistant.js';
import { historyUrl } from '../../api/traces.js';
import { useSession } from '../../app/session.js';
import { useResource } from '../../hooks/useResource.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { DataState } from '../../ui/DataState.js';
import { ErrorNotice } from '../../ui/ErrorNotice.js';
import { Field } from '../../ui/Field.js';
import { Textarea } from '../../ui/Textarea.js';

/**
 * Task 18: the full compiled prompt for one behaviour, fetched from
 * `GET /api/assistant/behaviours/:id/preview`. Every section the model
 * receives, in plain words with its size, each expandable to its text.
 */
const PREVIEW_LABELS: Readonly<Record<string, string>> = {
  surface: 'How members reach it',
  'behaviour-prompt': 'Your prompt',
  'safety-suffix': 'Bananasaurs safety rules (locked)',
  'evidence-rule': 'Evidence rule',
  'server-card': 'Server card',
  resources: 'Club resources',
  skills: 'Allowed skills',
};

export function BehaviourPreviewPanel({
  behaviourId,
  onClose,
}: {
  readonly behaviourId: string;
  readonly onClose: () => void;
}) {
  const session = useSession();
  const load = useCallback(
    () => session.read<BehaviourPreview>(behaviourPreviewUrl(behaviourId)),
    [session, behaviourId],
  );
  const preview = useResource('full prompt', load);
  return (
    <section
      aria-label="Full prompt preview"
      className="mt-2 rounded-sm border border-line bg-canvas p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Full prompt</h3>
        <Button className="px-1.5 py-0 text-xs" onClick={onClose}>
          Close preview
        </Button>
      </div>
      <DataState resource={preview.resource}>
        {(data) => (
          <>
            <ul className="mt-2 grid gap-1">
              {data.sections.map((section) => (
                <li key={section.name}>
                  <details className="rounded-sm border border-line bg-panel px-2 py-1">
                    <summary className="cursor-pointer text-sm">
                      <span>{PREVIEW_LABELS[section.name] ?? section.name}</span>{' '}
                      <span className="text-xs text-ink-muted">
                        {section.chars} characters · ~{section.estTokens} tokens
                      </span>
                    </summary>
                    <pre className="mt-1 overflow-x-auto font-mono text-xs whitespace-pre-wrap">
                      {section.text}
                    </pre>
                  </details>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-ink-muted">
              Total: {data.totalChars} characters · ~{data.totalEstTokens} tokens
            </p>
          </>
        )}
      </DataState>
    </section>
  );
}

/**
 * The answer as Discord-like text. There is no markdown renderer in the
 * dashboard (and no new dependency may be added), so this renders plain
 * text with its line breaks kept and fenced code blocks as `<pre>`.
 */
export function AnswerText({ text }: { readonly text: string }) {
  const parts = text.split('```');
  if (parts.length === 1) return <p className="text-sm whitespace-pre-wrap">{text}</p>;
  // Only a part whose fence closes is code: an odd part count means every
  // opened fence closed; an even count leaves the last opened fence
  // unclosed, so its tail stays plain text instead of a `<pre>`.
  const closed = parts.length % 2 === 1;
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 && (closed || index < parts.length - 1) ? (
          <pre
            key={index}
            className="mt-1 overflow-x-auto rounded-sm bg-panel p-2 font-mono text-xs whitespace-pre-wrap"
          >
            {part}
          </pre>
        ) : part === '' ? null : (
          <p key={index} className="mt-1 text-sm whitespace-pre-wrap">
            {part}
          </p>
        ),
      )}
    </>
  );
}

/**
 * Task 20: Try it — ask the selected behaviour a question from the
 * dashboard and read its answer. Nothing is posted to Discord. "Continue
 * this conversation" asks the follow-up in the same conversation; asking
 * with "Try it" starts over. Rendered with `key={behaviourId}` so switching
 * behaviours drops the previous answer and conversation.
 */
export function TryItBox({ behaviourId }: { readonly behaviourId: string }) {
  const session = useSession();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | undefined>(undefined);
  const [traceId, setTraceId] = useState<string | undefined>(undefined);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [quotaText, setQuotaText] = useState<string | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);

  const run = async (continuing: boolean): Promise<void> => {
    const cleaned = question.trim();
    if (cleaned === '' || busy) return;
    setBusy(true);
    setQuotaText(undefined);
    setError(undefined);
    try {
      // The 429 rethrows (rather than toasting and resolving `undefined`)
      // so the rate limit lands in this call's inline error below.
      const result = await session.writeOrThrow<TryItResponse>(
        behaviourTryUrl(behaviourId),
        {
          question: cleaned,
          ...(continuing && conversationId !== undefined ? { conversationId } : {}),
        },
        'POST',
        [429],
      );
      // `undefined` means the session already toasted the reason.
      if (result === undefined) return;
      setAnswer(result.answer);
      setTraceId(result.traceId);
      setConversationId(result.conversationId);
    } catch (err) {
      // The 429 branch stays: the hourly quota sentence says more than the
      // catalog text. Anything else renders as the server's answer.
      if (err instanceof ApiError && err.body.error === 'rate-limited') {
        setQuotaText('You have used your 20 tries for this hour. Try again later.');
      } else {
        setError(err);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Try it">
      <p className="mb-3 text-sm text-ink-muted">
        Ask this behaviour a question and read its answer here. Only you see it — nothing is posted
        to Discord.
      </p>
      <Field label="Try it question" hint="At most 2,000 characters. Twenty tries per hour." htmlFor="try-it-question">
        <Textarea
          id="try-it-question"
          showCount
          value={question}
          maxLength={2_000}
          onChange={(e) => setQuestion(e.target.value)}
        />
      </Field>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="primary"
          busy={busy}
          disabled={question.trim() === '' || busy}
          onClick={() => void run(false)}
        >
          Try it
        </Button>
        {conversationId !== undefined && (
          <Button
            busy={busy}
            disabled={question.trim() === '' || busy}
            onClick={() => void run(true)}
          >
            Continue this conversation
          </Button>
        )}
      </div>
      {quotaText !== undefined && (
        <p role="alert" className="mt-3 text-sm text-tone-danger-ink">
          {quotaText}
        </p>
      )}
      {error !== undefined && (
        <div className="mt-3">
          <ErrorNotice error={error} />
        </div>
      )}
      {answer !== undefined && traceId !== undefined && (
        <section
          aria-label="Tried answer"
          className="mt-3 rounded-sm border border-line bg-canvas p-2"
        >
          <AnswerText text={answer} />
          <p className="mt-2">
            <Link className="text-sm underline underline-offset-4" href={historyUrl(traceId)}>
              View details
            </Link>
          </p>
        </section>
      )}
    </Card>
  );
}
