import type { ClubResource } from '@bananasaurs/core';
import * as Dialog from '@radix-ui/react-dialog';
import { ApiError } from '../../api.js';
import { describeError } from '../../api/describe-error.js';
import { Button } from '../../ui/Button.js';
import { ErrorNotice } from '../../ui/ErrorNotice.js';
import { ErrorSummary } from '../../ui/ErrorSummary.js';
import { Checkbox, Field, Input } from '../../ui/Field.js';
import { FormSection } from '../../ui/FormSection.js';
import { Select } from '../../ui/Select.js';
import { KINDS } from './helpers.js';

const problemFor = (error: unknown, path: string): string | undefined => {
  if (!(error instanceof ApiError)) return undefined;
  const field = error.body.fields?.find((item) => item.path === path);
  if (field === undefined) return undefined;
  const labels: Record<string, string> = {
    title: 'Title',
    url: 'URL',
    kind: 'Kind',
    enabled: 'Enabled',
  };
  const label = labels[path] ?? path;
  const messages: Record<string, string> = {
    too_small: `Enter a ${label.toLowerCase()}.`,
    too_big:
      path === 'title' ? 'Title must be 200 characters or fewer.' : `${label} must be shorter.`,
    invalid_type: `Enter a ${label.toLowerCase()}.`,
    invalid_string:
      path === 'url'
        ? 'Enter a URL starting with https://'
        : `Check the ${label.toLowerCase()} format.`,
    invalid_enum_value: 'Choose a source kind.',
    custom: path === 'url' ? 'Enter a safe public HTTPS URL.' : `Check the ${label.toLowerCase()}.`,
  };
  return messages[field.problem] ?? field.problem;
};

export function ResourceForm(props: {
  readonly returnFocusTarget: HTMLElement | null;
  readonly onFocusFallback: () => void;
  readonly editing: ClubResource | 'new';
  readonly title: string;
  readonly url: string;
  readonly kind: ClubResource['kind'];
  readonly enabled: boolean;
  readonly error: unknown;
  readonly busy: boolean;
  readonly onTitle: (value: string) => void;
  readonly onUrl: (value: string) => void;
  readonly onKind: (value: ClubResource['kind']) => void;
  readonly onEnabled: (value: boolean) => void;
  readonly onSubmit: () => void;
  readonly onClose: () => void;
}) {
  const errors =
    props.error instanceof ApiError
      ? describeError(props.error).fields.map((field) => ({
          fieldId: `field-${field.path.replaceAll('.', '-')}`,
          message: problemFor(props.error, field.path) ?? field.problem,
        }))
      : [];
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/30" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[720px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-panel border border-line bg-panel p-4 text-ink shadow-float"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (props.returnFocusTarget?.isConnected) props.returnFocusTarget.focus();
            else props.onFocusFallback();
          }}
        >
          <Dialog.Title className="text-section font-semibold">
            {props.editing === 'new' ? 'Add resource' : 'Edit resource'}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-small text-ink-muted">
            Review this source before attaching it to a behaviour.
          </Dialog.Description>
          <form
            className="mt-3 grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              props.onSubmit();
            }}
          >
            <ErrorSummary errors={errors} />
            <FormSection title="Source">
              <Field
                label="Title"
                htmlFor="field-title"
                {...(problemFor(props.error, 'title') === undefined
                  ? {}
                  : { error: problemFor(props.error, 'title')! })}
              >
                <Input
                  value={props.title}
                  onChange={(event) => props.onTitle(event.target.value)}
                  required
                />
              </Field>
              <Field
                label="Kind"
                htmlFor="field-kind"
                {...(problemFor(props.error, 'kind') === undefined
                  ? {}
                  : { error: problemFor(props.error, 'kind')! })}
              >
                <Select
                  value={props.kind}
                  onValueChange={(value) => props.onKind(value as ClubResource['kind'])}
                  options={KINDS.map((value) => ({ value, label: value.replaceAll('-', ' ') }))}
                />
              </Field>
              <Field
                label="URL"
                htmlFor="field-url"
                hint="HTTPS addresses only; private and local addresses are refused."
                {...(problemFor(props.error, 'url') === undefined
                  ? {}
                  : { error: problemFor(props.error, 'url')! })}
              >
                <Input
                  value={props.url}
                  onChange={(event) => props.onUrl(event.target.value)}
                  type="url"
                  required
                  placeholder="https://"
                />
              </Field>
              <Checkbox
                label="Enabled"
                checked={props.enabled}
                onChange={(event) => props.onEnabled(event.target.checked)}
              />
            </FormSection>
            {props.error !== undefined && <ErrorNotice error={props.error} />}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" busy={props.busy} type="submit">
                {props.editing === 'new' ? 'Add resource' : 'Save resource'}
              </Button>
              <Button onClick={props.onClose}>Cancel</Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
