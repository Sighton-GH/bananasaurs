import { useEffect, useState } from 'react';
import { behaviourUrl, type AssistantData } from '../../api/assistant.js';
import { type Session } from '../../app/session.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { CodeBlock } from '../../ui/CodeBlock.js';
import { Field } from '../../ui/Field.js';
import { useToast } from '../../ui/Toast.js';
import { behaviourBody } from '../assistant-shared.js';

export function BehaviourPromptCard({
  behaviour,
  session,
  reload,
  onToggle,
}: {
  readonly behaviour: AssistantData['behaviours'][number];
  readonly session: Session;
  readonly reload: () => void;
  readonly onToggle: () => void;
}) {
  const toast = useToast();
  const [prompt, setPrompt] = useState(behaviour.systemPrompt);
  // The revision and text this draft started from. A draft is only ever sent
  // together with the revision it was written against.
  const [seed, setSeed] = useState({
    version: behaviour.promptVersion,
    text: behaviour.systemPrompt,
  });
  const [promptBusy, setPromptBusy] = useState(false);
  // Set after this card's own save succeeds, until the reload shows a newer
  // revision: Save stays off so the old version is never sent twice.
  const [savedFrom, setSavedFrom] = useState<number | undefined>(undefined);
  const edited = prompt !== seed.text;
  const moved = behaviour.promptVersion !== seed.version;
  // The server bumps the revision on every behaviour write (toggle, access,
  // prompt). A bump with the same text is not a competing edit.
  const sameText = behaviour.systemPrompt === seed.text;
  // Moved on and the text is what the draft started from: keep the draft, take the revision.
  const rebase = moved && sameText;
  // Moved on, text differs, and the user has nothing to lose or already matches: follow it.
  const follow = moved && !sameText && (!edited || prompt === behaviour.systemPrompt);
  // Moved on, text differs, with real unsaved edits: hold the draft, block Save, ask.
  const conflict = moved && !sameText && !follow;
  const waiting = savedFrom !== undefined && behaviour.promptVersion === savedFrom;
  useEffect(() => {
    if (savedFrom !== undefined && behaviour.promptVersion !== savedFrom) setSavedFrom(undefined);
  }, [savedFrom, behaviour.promptVersion]);
  useEffect(() => {
    if (rebase) setSeed({ version: behaviour.promptVersion, text: behaviour.systemPrompt });
  }, [rebase, behaviour.promptVersion, behaviour.systemPrompt]);
  useEffect(() => {
    if (!follow) return;
    setSeed({ version: behaviour.promptVersion, text: behaviour.systemPrompt });
    setPrompt(behaviour.systemPrompt);
  }, [follow, behaviour.promptVersion, behaviour.systemPrompt]);
  const savePrompt = async () => {
    if (conflict || waiting || promptBusy) return;
    const cleaned = prompt.trim();
    if (cleaned.length < 1 || cleaned.length > 4_000) {
      toast({ tone: 'danger', title: 'Prompt not saved', message: 'Use 1 to 4,000 characters.' });
      return;
    }
    setPromptBusy(true);
    try {
      const result = await session.writeOrThrow(
        behaviourUrl(behaviour.id),
        behaviourBody(behaviour, { systemPrompt: cleaned }),
        'PUT',
      );
      if (result !== undefined) {
        toast({
          tone: 'ok',
          title: `${behaviour.name} prompt saved`,
          message: `Saved as revision ${String(behaviour.promptVersion + 1)}.`,
        });
        setPrompt(cleaned);
        setSavedFrom(behaviour.promptVersion);
        reload();
      }
    } catch {
      toast({
        tone: 'hold',
        title: 'Prompt changed elsewhere',
        message:
          'Nothing was saved. Your text stays on screen while the latest revision loads, unless that load fails.',
      });
      reload();
    } finally {
      setPromptBusy(false);
    }
  };

  return (
    <Card title={`${behaviour.name} behaviour`}>
      <p className="text-sm text-ink-muted">
        These are the instructions this behaviour follows. Bananasaurs adds its own safety rules,
        your server card and the club resources, and always treats messages and web pages as
        information, never as instructions.
      </p>
      <Field
        label="Instructions the assistant follows"
        hint="Members do not see these operator instructions. Saved resources and messages cannot change them."
      >
        <textarea
          value={prompt}
          maxLength={4_000}
          onChange={(event) => setPrompt(event.target.value)}
          className="mt-3 min-h-32 w-full rounded-sm border border-line bg-canvas p-2 text-sm text-ink"
        />
      </Field>
      {conflict && (
        <div role="alert" className="mt-3 rounded-sm border border-line bg-canvas p-3 text-sm">
          <p className="font-medium">These instructions changed elsewhere.</p>
          <p className="mt-1 text-ink-muted">
            The latest is revision {behaviour.promptVersion}. Your text is kept above and nothing
            was saved. Saving is off until you choose.
          </p>
          <details className="mt-2">
            <summary className="cursor-pointer">Show the latest instructions</summary>
            <div className="mt-2">
              <CodeBlock label="Latest instructions" code={behaviour.systemPrompt} />
            </div>
          </details>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              onClick={() => {
                setSeed({ version: behaviour.promptVersion, text: behaviour.systemPrompt });
                setPrompt(behaviour.systemPrompt);
              }}
            >
              Use the latest instructions
            </Button>
            <Button
              onClick={() =>
                setSeed({ version: behaviour.promptVersion, text: behaviour.systemPrompt })
              }
            >
              Keep my text on the latest revision
            </Button>
          </div>
        </div>
      )}
      <p className="mt-1 text-xs text-ink-muted">
        Revision {behaviour.promptVersion} · {prompt.length.toLocaleString('en-CA')}/4,000
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button className="max-w-full shrink-0" onClick={onToggle}>
          {behaviour.enabled ? 'Turn off - members will get no answer' : 'Turn on assistant'}
        </Button>
        <Button
          busy={promptBusy}
          disabled={prompt === behaviour.systemPrompt || conflict || waiting}
          onClick={() => void savePrompt()}
        >
          Save instructions
        </Button>
      </div>
    </Card>
  );
}
