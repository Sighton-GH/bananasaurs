import { useEffect, useRef, useState } from 'react';
import { BOT_TAG_URL, LOG_CHANNEL_URL, type AssistantData } from '../../api/assistant.js';
import { fieldError } from '../../api/describe-error.js';
import { type Session } from '../../app/session.js';
import { Card } from '../../ui/Card.js';
import { ErrorNotice } from '../../ui/ErrorNotice.js';
import { Field } from '../../ui/Field.js';
import { Select } from '../../ui/Select.js';
import { useToast } from '../../ui/Toast.js';

/**
 * The two guild-wide drafts on the Settings tab: which behaviour answers a
 * tag of the bot itself (ADR 0063), and the AI log channel (ADR 0065). They
 * stay two separate requests (PUT BOT_TAG_URL {behaviourId}, PUT
 * LOG_CHANNEL_URL {channelId}) sent in that order, one per changed field;
 * there is no bulk endpoint and none is invented. A failure in one never
 * hides or undoes the other: what saved is reloaded as the new baseline and
 * what did not stays a draft with its own message.
 */
export interface SettingsDraftState {
  readonly tagDraft: string | undefined;
  readonly logDraft: string | undefined;
  readonly appliedTag: string | undefined;
  readonly appliedLog: string | undefined;
  readonly tagProblem: unknown;
  readonly logProblem: boolean;
  readonly busy: boolean;
  /** True while an unsaved Settings choice exists (guards leaving the page). */
  readonly dirty: boolean;
  readonly set: {
    readonly tagDraft: (v: string | undefined) => void;
    readonly logDraft: (v: string | undefined) => void;
    readonly appliedTag: (v: string | undefined) => void;
    readonly appliedLog: (v: string | undefined) => void;
    readonly tagProblem: (v: unknown) => void;
    readonly logProblem: (v: boolean) => void;
    readonly busy: (v: boolean) => void;
  };
}

/**
 * The Settings drafts live ABOVE the data boundary, so a reload that ends in
 * an error (the body unmounts) does not erase them; they return when the page
 * loads again. They are cleared when the session identity (account + guild)
 * changes, because they belong to the old guild's settings and must never be
 * written into another one. The unsaved-page guard is armed from here.
 */
export function useSettingsDraftState(identity: string): SettingsDraftState {
  const [tagDraft, setTagDraft] = useState<string | undefined>(undefined);
  const [logDraft, setLogDraft] = useState<string | undefined>(undefined);
  const [appliedTag, setAppliedTag] = useState<string | undefined>(undefined);
  const [appliedLog, setAppliedLog] = useState<string | undefined>(undefined);
  const [tagProblem, setTagProblem] = useState<unknown>(undefined);
  const [logProblem, setLogProblem] = useState(false);
  const [busy, setBusy] = useState(false);
  const seen = useRef(identity);
  useEffect(() => {
    if (seen.current === identity) return;
    seen.current = identity;
    setTagDraft(undefined);
    setLogDraft(undefined);
    setAppliedTag(undefined);
    setAppliedLog(undefined);
    setTagProblem(undefined);
    setLogProblem(false);
    setBusy(false);
  }, [identity]);
  return {
    tagDraft,
    logDraft,
    appliedTag,
    appliedLog,
    tagProblem,
    logProblem,
    busy,
    dirty: tagDraft !== undefined || logDraft !== undefined,
    set: {
      tagDraft: setTagDraft,
      logDraft: setLogDraft,
      appliedTag: setAppliedTag,
      appliedLog: setAppliedLog,
      tagProblem: setTagProblem,
      logProblem: setLogProblem,
      busy: setBusy,
    },
  };
}

/**
 * Derived view and actions over the draft state. A draft exists only while it
 * differs from the effective saved value: what the server holds, or what this
 * page has just saved and is still waiting to see reloaded. A saved field is
 * therefore clean the moment its PUT succeeds, never re-sent while the
 * refresh is pending; only a failed field stays a draft.
 */
export function useSettingsDrafts(
  state: SettingsDraftState,
  data: AssistantData,
  session: Session,
  reload: () => void,
) {
  const toast = useToast();
  const serverTag = data.behaviours.find((b) => b.answersBotTag === true)?.id ?? '';
  const serverLog = data.settings?.logChannelId ?? '';
  const savedTag = state.appliedTag ?? serverTag;
  const savedLog = state.appliedLog ?? serverLog;
  const tag = state.tagDraft ?? savedTag;
  const log = state.logDraft ?? savedLog;
  const tagDirty = state.tagDraft !== undefined && state.tagDraft !== savedTag;
  const logDirty = state.logDraft !== undefined && state.logDraft !== savedLog;
  const dirtyCount = Number(tagDirty) + Number(logDirty);
  const { set } = state;
  // A reload that lands after this page's own save carries the server's
  // current values: the local note of what was saved gives way to them, so a
  // value another admin changed first is honoured. Unsaved drafts are kept.
  const awaiting = useRef<AssistantData | undefined>(undefined);
  useEffect(() => {
    if (awaiting.current === undefined || awaiting.current === data) return;
    awaiting.current = undefined;
    set.appliedTag(undefined);
    set.appliedLog(undefined);
  }, [data, set]);
  // Once the reload shows what was saved, the local note of it is redundant.
  useEffect(() => {
    if (state.appliedTag !== undefined && state.appliedTag === serverTag) set.appliedTag(undefined);
    if (state.appliedLog !== undefined && state.appliedLog === serverLog) set.appliedLog(undefined);
  }, [state.appliedTag, state.appliedLog, serverTag, serverLog, set]);

  const save = async () => {
    if (state.busy) return;
    set.busy(true);
    let saved = false;
    if (tagDirty) {
      set.tagProblem(undefined);
      try {
        const result = await session.writeOrThrow(
          BOT_TAG_URL,
          { behaviourId: tag === '' ? null : tag },
          'PUT',
        );
        if (result === undefined) {
          set.tagProblem('not-saved');
        } else {
          saved = true;
          set.appliedTag(tag);
          set.tagDraft(undefined);
          const name = data.behaviours.find((b) => b.id === tag)?.name;
          toast({
            tone: 'ok',
            title:
              name === undefined
                ? 'Tagging @Bananasaurs is off'
                : `Tag @Bananasaurs now answers with ${name}`,
          });
        }
      } catch (err: unknown) {
        // writeOrThrow throws only 400 and 409; render the server's answer.
        set.tagProblem(err);
      }
    }
    if (logDirty) {
      set.logProblem(false);
      try {
        const result = await session.write(
          LOG_CHANNEL_URL,
          { channelId: log === '' ? null : log },
          'PUT',
        );
        if (result === undefined) {
          set.logProblem(true);
        } else {
          saved = true;
          set.appliedLog(log);
          set.logDraft(undefined);
          const name = (data.channels ?? []).find((c) => c.id === log)?.name;
          toast({
            tone: 'ok',
            title:
              name === undefined
                ? 'Assistant logging is off'
                : `Assistant requests now log to #${name}`,
          });
        }
      } catch {
        set.logProblem(true);
      }
    }
    if (saved) {
      awaiting.current = data;
      reload();
    }
    set.busy(false);
  };

  const discard = () => {
    set.tagDraft(undefined);
    set.logDraft(undefined);
    set.tagProblem(undefined);
    set.logProblem(false);
  };

  return {
    dirtyCount,
    busy: state.busy,
    save: () => void save(),
    discard,
    cards: {
      data,
      savedTag,
      tag,
      log,
      tagProblem: state.tagProblem,
      logProblem: state.logProblem,
      onTag: (value: string) => {
        set.tagDraft(value === savedTag ? undefined : value);
        set.tagProblem(undefined);
      },
      onLog: (value: string) => {
        set.logDraft(value === savedLog ? undefined : value);
        set.logProblem(false);
      },
    },
  };
}

export type SettingsCardsProps = ReturnType<typeof useSettingsDrafts>['cards'];

/**
 * ADR 0063: which behaviour answers when a member tags the bot user itself
 * (not a mapped role). One at a time; the server enforces it and refuses a
 * disabled behaviour, so only enabled ones are offered.
 */
export function BotTagCard({ data, savedTag, tag, tagProblem, onTag }: SettingsCardsProps) {
  const offered = data.behaviours.filter((b) => b.enabled);
  const behaviourProblem =
    tagProblem === 'not-saved' ? undefined : fieldError(tagProblem, 'behaviourId');
  return (
    <Card title="Tagging @Bananasaurs">
      <p className="text-sm text-ink-muted">
        Members can tag the bot itself to ask a question. Tags of a mapped role, such as
        @it-services, still go to that role&apos;s behaviour.
      </p>
      <div className="mt-3">
        <Field
          label="When someone tags @Bananasaurs, answer with"
          {...(behaviourProblem === undefined ? {} : { error: behaviourProblem })}
        >
          <Select
            value={tag === '' ? '__none' : tag}
            onValueChange={(value) => onTag(value === '__none' ? '' : value)}
            options={[
              { value: '__none', label: 'Nobody' },
              ...offered.map((b) => ({ value: b.id, label: b.name })),
            ]}
          />
        </Field>
      </div>
      {savedTag === '' && (
        <p className="mt-2 text-xs text-hold">
          Tagging the bot does nothing until you pick a behaviour.
        </p>
      )}
      {tagProblem === 'not-saved' && (
        <p role="alert" className="mt-3 text-sm text-tone-danger-ink">
          Not saved. Your choice is kept here; try again.
        </p>
      )}
      {tagProblem !== undefined && tagProblem !== 'not-saved' && (
        <div className="mt-3">
          <ErrorNotice error={tagProblem} />
        </div>
      )}
    </Card>
  );
}

/**
 * ADR 0065: the channel every assistant request is logged to, with the full
 * question and answer. Picked from the live channel directory, never typed.
 */
export function LogChannelCard({ data, log, logProblem, onLog }: SettingsCardsProps) {
  const channels = data.channels ?? [];
  return (
    <Card title="AI log channel">
      <p className="text-sm text-ink-muted">
        Each request is posted with who asked, the question, the answer, the tools and sources used,
        the model, and whether it worked.
      </p>
      <p className="mt-1 text-xs text-hold">
        Members&apos; questions are copied there in full. Choose a staff-only channel.
      </p>
      <div className="mt-3">
        <Field label="Post every assistant request to">
          <Select
            value={log === '' ? '__none' : log}
            onValueChange={(value) => onLog(value === '__none' ? '' : value)}
            options={[
              { value: '__none', label: 'No log channel' },
              ...channels.map((c) => ({ value: c.id, label: `#${c.name}` })),
            ]}
          />
        </Field>
      </div>
      {logProblem && (
        <p role="alert" className="mt-3 text-sm text-tone-danger-ink">
          Not saved. Your choice is kept here; try again.
        </p>
      )}
    </Card>
  );
}
