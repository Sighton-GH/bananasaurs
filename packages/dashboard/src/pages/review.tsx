import { useCallback, useState } from 'react';
import { Link, useSearch } from 'wouter';
import { ApiError } from '../api.js';
import {
  NATIVE_OVERLAP_KINDS,
  suppressionFor,
  suppressionPrefill,
  type NativeHit,
  type ReviewableMatch,
  type ReviewQueue,
  type RuleSummary,
  type SuppressionKind,
  type Verdict,
  type VerdictCounts,
} from '../api/automod.js';
import { useSession } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Button } from '../ui/Button.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DataState } from '../ui/DataState.js';
import { DataTable } from '../ui/DataTable.js';
import { Field, Input } from '../ui/Field.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';

/** Everything the page needs, loaded together so `DataState` sees one resource. */
interface ReviewData {
  readonly queue: ReviewQueue;
  readonly rules: readonly RuleSummary[];
}

const ZERO_COUNTS: VerdictCounts = { falsePositive: 0, truePositive: 0, unclear: 0 };

/** One row's one-click narrowing, with the kind the page looked up from the rules list. */
interface SuppressTarget {
  readonly ruleId: string;
  readonly kind: SuppressionKind;
  readonly label: string;
  readonly prefill: boolean;
}

/** The `ConfirmDialog` scope for a suppression: the exact narrowing, stated. */
const suppressionScope = (kind: SuppressionKind, ruleId: string, value: string): string => {
  switch (kind) {
    case 'allowlist_phrase':
      return `Adds '${value}' to ${ruleId}'s allowlist. Messages containing it will no longer match this rule, in every mode.`;
    case 'invite_code':
      return `Allows invite code ${value} for ${ruleId}.`;
    case 'link_domain':
      return `Allows domain ${value} for ${ruleId}.`;
    case 'channel_exemption':
      return `Exempts channel ${value} from ${ruleId} entirely.`;
  }
};

/** The success toast repeats the verb on the button that was confirmed. */
const suppressionDoneTitle = (kind: SuppressionKind): string => {
  switch (kind) {
    case 'allowlist_phrase':
      return 'Phrase allowed';
    case 'invite_code':
      return 'Invite code allowed';
    case 'link_domain':
      return 'Domain allowed';
    case 'channel_exemption':
      return 'Channel exempted';
  }
};

/** Evidence: the fixture's whole message when one was captured, else the snippet with a note that it is not the whole message. */
function EvidenceCell({
  fixtureContent,
  matchedSnippet,
}: {
  readonly fixtureContent: string | undefined;
  readonly matchedSnippet: string;
}) {
  if (fixtureContent !== undefined) {
    return <p className="max-w-md text-sm break-words whitespace-pre-wrap">{fixtureContent}</p>;
  }
  return (
    <>
      <p className="max-w-md text-sm break-words whitespace-pre-wrap">{matchedSnippet}</p>
      <p className="mt-1 text-xs text-ink-muted">
        (snippet only — the message is not held: it was deleted in enforce mode, or removed at the
        member&apos;s request)
      </p>
    </>
  );
}

/**
 * `/review`: every match nobody has ruled on yet, the tally the release gate
 * reads (ADR 0042 §4), and the F3.2 warning about what native AutoMod hides
 * from the observe stream. Loads `GET /api/automod/review` and
 * `GET /api/automod/rules` together — the second supplies each rule's kind,
 * which the tally and the bias warning both need.
 */
export function ReviewPage() {
  const session = useSession();
  const toast = useToast();
  const search = useSearch();
  const ruleFilter = new URLSearchParams(search).get('rule') ?? undefined;

  const load = useCallback(
    () =>
      Promise.all([
        session.read<ReviewQueue>(
          `/api/automod/review?limit=50${ruleFilter !== undefined ? `&ruleId=${encodeURIComponent(ruleFilter)}` : ''}`,
        ),
        session.read<{ rules: RuleSummary[] }>('/api/automod/rules'),
      ]).then(([queue, r]): ReviewData => ({ queue, rules: r.rules })),
    [session, ruleFilter],
  );
  const review = useResource('the review queue', load);

  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [suppressTarget, setSuppressTarget] = useState<SuppressTarget | null>(null);
  const [suppressValue, setSuppressValue] = useState('');
  const [suppressBusy, setSuppressBusy] = useState(false);

  const openSuppress = useCallback(
    (
      match: ReviewableMatch,
      action: {
        readonly kind: SuppressionKind;
        readonly label: string;
        readonly prefillFromSnippet: boolean;
      },
    ) => {
      setSuppressTarget({
        ruleId: match.ruleId,
        kind: action.kind,
        label: action.label,
        prefill: action.prefillFromSnippet,
      });
      setSuppressValue(action.prefillFromSnippet ? suppressionPrefill(match) : '');
    },
    [],
  );

  const confirmSuppress = useCallback(async () => {
    if (suppressTarget === null) return;
    const { ruleId, kind } = suppressTarget;
    const value = suppressValue;
    setSuppressBusy(true);
    try {
      const result = await session.writeOrThrow<{ ok: boolean; outcome: string }>(
        `/api/automod/rules/${ruleId}/suppress`,
        { kind, value },
      );
      if (result === undefined) return;
      setSuppressTarget(null);
      if (result.outcome === 'already-present') {
        toast({ tone: 'neutral', title: 'Already allowed' });
      } else {
        toast({ tone: 'ok', title: suppressionDoneTitle(kind) });
        review.reload();
      }
    } catch (err) {
      const bodyError =
        err instanceof ApiError && err.status === 409
          ? (err.body as { error?: unknown }).error
          : undefined;
      if (bodyError === 'wrong-kind') {
        toast({ tone: 'danger', title: "That suppression does not apply to this rule's kind" });
        setSuppressTarget(null);
      } else if (bodyError === 'not-denied') {
        toast({
          tone: 'danger',
          title:
            "That domain is not on the rule's deny list — a parent domain may be. Narrow it in the configuration.",
        });
        setSuppressTarget(null);
      } else if (err instanceof Error) {
        toast({ tone: 'danger', title: 'The request failed', message: err.message });
        setSuppressTarget(null);
      } else {
        throw err;
      }
    } finally {
      setSuppressBusy(false);
    }
  }, [session, toast, review, suppressTarget, suppressValue]);

  const castVerdict = useCallback(
    async (eventId: string, verdict: Verdict) => {
      setBusyIds((s) => new Set(s).add(eventId));
      try {
        const result = await session.write<{ ok: boolean; outcome: string }>(
          `/api/automod/review/${eventId}/verdict`,
          { verdict },
        );
        if (result === undefined) return;
        if (result.outcome === 'recorded-with-label-conflict') {
          toast({
            tone: 'hold',
            title:
              "Verdict recorded — the fixture's label was reset because another rule's verdict on the same message disagrees",
          });
        } else {
          toast({ tone: 'ok', title: 'Verdict recorded' });
        }
        review.reload();
      } finally {
        setBusyIds((s) => {
          const next = new Set(s);
          next.delete(eventId);
          return next;
        });
      }
    },
    [session, toast, review],
  );

  const verdictButtons = useCallback(
    (eventId: string) => {
      const busy = busyIds.has(eventId);
      return (
        <div className="flex flex-wrap gap-1.5">
          <Button busy={busy} onClick={() => void castVerdict(eventId, 'false_positive')}>
            False positive
          </Button>
          <Button busy={busy} onClick={() => void castVerdict(eventId, 'true_positive')}>
            True positive
          </Button>
          <Button busy={busy} onClick={() => void castVerdict(eventId, 'unclear')}>
            Unclear
          </Button>
        </div>
      );
    },
    [busyIds, castVerdict],
  );

  return (
    <>
      <PageHeader
        title="Review"
        purpose="Every match nobody has ruled on yet. A verdict here is the evidence the release gate counts, and it labels the fixture the match came from."
      />
      <DataState resource={review.resource}>
        {({ queue, rules }) => {
          const ruleKindOf = new Map(rules.map((r) => [r.ruleId, r.kind]));

          const tallyRows = new Map<string, VerdictCounts>();
          for (const [ruleId, counts] of Object.entries(queue.verdicts)) {
            tallyRows.set(ruleId, counts);
          }
          for (const match of queue.matches) {
            if (!tallyRows.has(match.ruleId)) tallyRows.set(match.ruleId, ZERO_COUNTS);
          }
          const tally = Array.from(tallyRows.entries());

          const relevantRuleIds = new Set<string>([
            ...queue.matches.map((m) => m.ruleId),
            ...tally.map(([ruleId]) => ruleId),
          ]);
          const hasOverlapRule = Array.from(relevantRuleIds).some((ruleId) => {
            const kind = ruleKindOf.get(ruleId);
            return kind !== undefined && NATIVE_OVERLAP_KINDS.includes(kind);
          });
          const showNativeWarning = queue.nativeBlocked > 0 && hasOverlapRule;

          return (
            <>
              <h2 className="mt-2 text-lg">Reviewed matches per rule</h2>
              <p className="mt-1 text-sm text-ink-muted">
                Release 2&apos;s gate is measured from these numbers (ADR 0042 §4): zero
                false-positive or unclear verdicts for a rule that feeds the escalation counter; at
                most 5% for a delete-only rule; at least 20 reviewed or a sign-off.
              </p>
              <div className="mt-3">
                <DataTable
                  caption="Reviewed matches per rule"
                  rows={tally}
                  rowKey={([ruleId]) => ruleId}
                  columns={[
                    {
                      key: 'rule',
                      header: 'Rule',
                      cell: ([ruleId]) => <Link href={`/automod/${ruleId}`}>{ruleId}</Link>,
                    },
                    {
                      key: 'falsePositive',
                      header: 'False positive',
                      numeric: true,
                      cell: ([, counts]) => counts.falsePositive,
                    },
                    {
                      key: 'truePositive',
                      header: 'True positive',
                      numeric: true,
                      cell: ([, counts]) => counts.truePositive,
                    },
                    {
                      key: 'unclear',
                      header: 'Unclear',
                      numeric: true,
                      cell: ([, counts]) => counts.unclear,
                    },
                    {
                      key: 'reviewed',
                      header: 'Reviewed',
                      numeric: true,
                      cell: ([, counts]) =>
                        counts.falsePositive + counts.truePositive + counts.unclear,
                    },
                  ]}
                />
              </div>
              {showNativeWarning && (
                <p role="note" className="mt-4 rounded-sm border border-hold px-3 py-2 text-sm">
                  Native AutoMod has blocked {queue.nativeBlocked} messages before any rule here
                  could see them. For keyword, mention, rapid-message and duplicate rules the
                  false-positive rate is measured on what native let through, not on real traffic.
                </p>
              )}

              <h2 className="mt-6 text-lg">Unreviewed matches</h2>
              {queue.matches.length === 0 ? (
                <p className="mt-2 text-sm text-ink-muted">
                  Nothing to review. Matches recorded during the observe window appear here.
                </p>
              ) : (
                <div className="mt-3">
                  <DataTable
                    caption="Unreviewed matches"
                    rows={[...queue.matches].sort((a, b) => a.at - b.at)}
                    rowKey={(m: ReviewableMatch) => m.eventId}
                    columns={[
                      {
                        key: 'when',
                        header: 'When',
                        cell: (m) => new Date(m.at).toLocaleString(),
                      },
                      {
                        key: 'rule',
                        header: 'Rule',
                        cell: (m) => <Link href={`/automod/${m.ruleId}`}>{m.ruleId}</Link>,
                      },
                      {
                        key: 'member',
                        header: 'Member',
                        cell: (m) => <Link href={`/members/${m.memberId}`}>{m.memberId}</Link>,
                      },
                      { key: 'category', header: 'Category', cell: (m) => m.matchedCategory },
                      {
                        key: 'evidence',
                        header: 'Evidence',
                        cell: (m) => (
                          <EvidenceCell
                            fixtureContent={m.fixtureContent}
                            matchedSnippet={m.matchedSnippet}
                          />
                        ),
                      },
                      {
                        key: 'trace',
                        header: 'Trace',
                        cell: (m) =>
                          m.trace === undefined ? (
                            '—'
                          ) : (
                            <details>
                              <summary>Trace</summary>
                              <p className="max-w-md text-sm break-words whitespace-pre-wrap">
                                {m.trace}
                              </p>
                            </details>
                          ),
                      },
                      {
                        key: 'verdict',
                        header: 'Verdict',
                        cell: (m) => verdictButtons(m.eventId),
                      },
                      {
                        key: 'suppress',
                        header: 'Suppress',
                        cell: (m) => {
                          const kind = ruleKindOf.get(m.ruleId);
                          if (kind === undefined) return null;
                          const action = suppressionFor(kind);
                          if (action === undefined) {
                            return <Link href={`/automod/${m.ruleId}`}>Narrow the pattern</Link>;
                          }
                          return (
                            <Button onClick={() => openSuppress(m, action)}>{action.label}</Button>
                          );
                        },
                      },
                    ]}
                  />
                </div>
              )}

              {queue.nativeHits.length > 0 && (
                <>
                  <h2 className="mt-6 text-lg">Native AutoMod hits</h2>
                  <p className="mt-1 text-sm text-ink-muted">
                    Discord blocked these before any rule here saw them; a verdict records whether
                    native was right.
                  </p>
                  <div className="mt-3">
                    <DataTable
                      caption="Native AutoMod hits"
                      rows={[...queue.nativeHits].sort((a, b) => a.at - b.at)}
                      rowKey={(h: NativeHit) => h.eventId}
                      columns={[
                        {
                          key: 'when',
                          header: 'When',
                          cell: (h) => new Date(h.at).toLocaleString(),
                        },
                        {
                          key: 'rule',
                          header: 'Rule',
                          // Native rule ids are Discord's (`native:…`), not
                          // Bananasaurs routes — plain text, not a link.
                          cell: (h) => h.ruleId,
                        },
                        {
                          key: 'member',
                          header: 'Member',
                          cell: (h) => <Link href={`/members/${h.memberId}`}>{h.memberId}</Link>,
                        },
                        { key: 'category', header: 'Category', cell: (h) => h.matchedCategory },
                        {
                          key: 'evidence',
                          header: 'Evidence',
                          cell: (h) => (
                            <EvidenceCell
                              fixtureContent={undefined}
                              matchedSnippet={h.matchedSnippet}
                            />
                          ),
                        },
                        {
                          key: 'verdict',
                          header: 'Verdict',
                          cell: (h) => verdictButtons(h.eventId),
                        },
                      ]}
                    />
                  </div>
                </>
              )}
            </>
          );
        }}
      </DataState>
      {suppressTarget !== null && (
        <ConfirmDialog
          open
          title={`${suppressTarget.label}?`}
          scope={
            <p>{suppressionScope(suppressTarget.kind, suppressTarget.ruleId, suppressValue)}</p>
          }
          confirmLabel={suppressTarget.label}
          busy={suppressBusy}
          onConfirm={() => void confirmSuppress()}
          onCancel={() => setSuppressTarget(null)}
        >
          <Field label="Value" {...(suppressTarget.prefill ? {} : { hint: 'channel ID' })}>
            <Input value={suppressValue} onChange={(e) => setSuppressValue(e.target.value)} />
          </Field>
        </ConfirmDialog>
      )}
    </>
  );
}
