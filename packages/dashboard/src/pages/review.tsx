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
import { describeError } from '../api/describe-error.js';
import { Badge } from '../ui/Badge.js';
import { MemberRef } from '../ui/MemberRef.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
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

/** Evidence: the matched snippet, with a note that it is not the whole message (ADR 0121 keeps no copy). */
function EvidenceCell({ matchedSnippet }: { readonly matchedSnippet: string }) {
  return (
    <>
      <p className="max-w-md text-sm break-words whitespace-pre-wrap">{matchedSnippet}</p>
      <p className="mt-1 text-xs text-ink-muted">
        (snippet only — Bananasaurs does not keep a copy of the whole message)
      </p>
    </>
  );
}

/**
 * `/review`: every match nobody has flagged yet, the flag tally per rule
 * (ADR 0121: flags are for tuning), and the F3.2 warning about what native
 * AutoMod catches before Bananasaurs sees it. Loads `GET /api/automod/review` and
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
        `/api/automod/rules/${encodeURIComponent(ruleId)}/suppress`,
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
        const d = describeError(err);
        toast({
          tone: 'danger',
          title: d.title,
          message: [d.message, d.hint].filter(Boolean).join(' '),
          detail: [
            d.code,
            d.status !== undefined ? `HTTP ${d.status}` : undefined,
            d.requestId !== undefined ? `request ${d.requestId}` : undefined,
          ]
            .filter(Boolean)
            .join(' · '),
        });
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
          `/api/automod/review/${encodeURIComponent(eventId)}/verdict`,
          { verdict },
        );
        if (result === undefined) return;
        if (result.outcome === 'recorded-with-label-conflict') {
          toast({
            tone: 'hold',
            title:
              "Verdict recorded — the saved test example's label was reset because another rule's verdict on the same message disagrees",
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
        <div>
          <p className="mb-1 text-xs text-ink-muted">
            Choose “Should be allowed” when the rule caught an acceptable message.
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Button busy={busy} onClick={() => void castVerdict(eventId, 'false_positive')}>
              Should be allowed
            </Button>
            <Button busy={busy} onClick={() => void castVerdict(eventId, 'true_positive')}>
              Should be blocked
            </Button>
            <Button busy={busy} onClick={() => void castVerdict(eventId, 'unclear')}>
              Unclear
            </Button>
          </div>
        </div>
      );
    },
    [busyIds, castVerdict],
  );

  return (
    <>
      <PageHeader
        title="Review"
        purpose="Flag each match as correct or a false positive. Flags help you tune your rules; use Narrow this rule to stop a false positive from matching again."
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
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <p className="text-sm">
                  <span className="text-2xl font-semibold">{queue.matches.length}</span>{' '}
                  <span className="text-ink-muted">
                    {queue.matches.length === 1 ? 'match' : 'matches'} waiting for a verdict
                  </span>
                </p>
                {ruleFilter !== undefined && (
                  <span className="flex items-center gap-2 text-sm">
                    <Badge tone="hold">filtered to {ruleFilter}</Badge>
                    <Link href="/review" className="text-ink-muted underline">
                      Show every rule
                    </Link>
                  </span>
                )}
              </div>
              <Card title="Reviewed matches per rule">
                <p className="mb-3 text-sm text-ink-muted">
                  How each rule&apos;s matches have been flagged. A rule with many false positives
                  needs narrowing before automod is switched On.
                </p>
                <DataTable
                  caption="Reviewed matches per rule"
                  rows={tally}
                  rowKey={([ruleId]) => ruleId}
                  columns={[
                    {
                      key: 'rule',
                      header: 'Rule',
                      cell: ([ruleId]) => (
                        <Link href={`/automod/${encodeURIComponent(ruleId)}`}>{ruleId}</Link>
                      ),
                    },
                    {
                      key: 'falsePositive',
                      header: 'Should be allowed',
                      numeric: true,
                      cell: ([, counts]) => counts.falsePositive,
                    },
                    {
                      key: 'truePositive',
                      header: 'Should be blocked',
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
              </Card>
              {showNativeWarning && (
                <p role="note" className="mt-4 rounded-sm border border-hold px-3 py-2 text-sm">
                  Native AutoMod has blocked {queue.nativeBlocked} messages before any rule here
                  could see them. For keyword, mention, rapid-message and duplicate rules the
                  false-positive rate is measured on what native let through, not on real traffic.
                </p>
              )}

              <div className="mt-4">
                <Card title="Unreviewed matches">
                  {queue.matches.length === 0 ? (
                    <p className="text-sm text-ink-muted">
                      Nothing to review. Matches appear here while automod is on Watch or On.
                    </p>
                  ) : (
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
                          cell: (m) => (
                            <Link href={`/automod/${encodeURIComponent(m.ruleId)}`}>
                              {m.ruleId}
                            </Link>
                          ),
                        },
                        {
                          key: 'member',
                          header: 'Member',
                          cell: (m) => <MemberRef id={m.memberId} member={m.member} />,
                        },
                        { key: 'category', header: 'Category', cell: (m) => m.matchedCategory },
                        {
                          key: 'evidence',
                          header: 'Evidence',
                          cell: (m) => <EvidenceCell matchedSnippet={m.matchedSnippet} />,
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
                              return (
                                <Link href={`/automod/${encodeURIComponent(m.ruleId)}`}>
                                  Narrow the pattern
                                </Link>
                              );
                            }
                            return (
                              <Button onClick={() => openSuppress(m, action)}>
                                {action.label}
                              </Button>
                            );
                          },
                        },
                      ]}
                    />
                  )}
                </Card>
              </div>

              {queue.nativeHits.length > 0 && (
                <div className="mt-4">
                  <Card title="Native AutoMod hits">
                    <p className="mb-3 text-sm text-ink-muted">
                      Discord blocked these before any rule here saw them; a verdict records whether
                      native was right.
                    </p>
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
                          cell: (h) => <MemberRef id={h.memberId} member={h.member} />,
                        },
                        { key: 'category', header: 'Category', cell: (h) => h.matchedCategory },
                        {
                          key: 'evidence',
                          header: 'Evidence',
                          cell: (h) => <EvidenceCell matchedSnippet={h.matchedSnippet} />,
                        },
                        {
                          key: 'verdict',
                          header: 'Verdict',
                          cell: (h) => verdictButtons(h.eventId),
                        },
                      ]}
                    />
                  </Card>
                </div>
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
