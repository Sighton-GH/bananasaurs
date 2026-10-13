import { useRef, useState } from 'react';
import {
  GITHUB_IMPORT_URL,
  GITHUB_PREVIEW_URL,
  type GithubImportResult,
  type GithubPreview,
} from '../../api/assistant.js';
import { type Session } from '../../app/session.js';
import { useFieldErrors } from '../../hooks/useFieldErrors.js';
import { Badge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { ErrorNotice } from '../../ui/ErrorNotice.js';
import { ErrorSummary } from '../../ui/ErrorSummary.js';
import { Checkbox, Field, Input } from '../../ui/Field.js';
import { Link } from '../../ui/Link.js';
import { useToast } from '../../ui/Toast.js';

/**
 * "Add from GitHub" (Task 17): paste a repo or organisation URL, preview
 * what would be imported, pick files or repositories, add. The preview comes
 * from the server (which holds the token); this panel only ever sees names,
 * file paths and counts — never the token.
 */
export function GithubPanel({
  session,
  onSaved,
  onClose,
}: {
  readonly session: Session;
  readonly onSaved: () => void;
  readonly onClose: () => void;
}) {
  const toast = useToast();
  const fields = useFieldErrors();
  const [url, setUrl] = useState('');
  const currentUrl = useRef('');
  const [preview, setPreview] = useState<GithubPreview | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [checkedFiles, setCheckedFiles] = useState<readonly string[] | undefined>(undefined);
  const [fileFilter, setFileFilter] = useState('');

  const runPreview = async () => {
    const requestedUrl = url;
    setPreviewBusy(true);
    setError(undefined);
    fields.clear();
    setPreview(undefined);
    setCheckedFiles(undefined);
    setFileFilter('');
    try {
      const result = await session.writeOrThrow<GithubPreview>(GITHUB_PREVIEW_URL, { url }, 'POST');
      // `undefined` means the session already toasted the reason.
      if (result === undefined) return;
      if (currentUrl.current !== requestedUrl) return;
      setPreview(result);
      if (result.files !== undefined) setCheckedFiles(result.files);
    } catch (err) {
      setError(err);
      fields.capture(err);
    } finally {
      setPreviewBusy(false);
    }
  };

  const runImport = async (body: Record<string, unknown>) => {
    setImportBusy(true);
    setError(undefined);
    fields.clear();
    try {
      const result = await session.writeOrThrow<GithubImportResult>(
        GITHUB_IMPORT_URL,
        body,
        'POST',
      );
      // `undefined` means the session already toasted the reason.
      if (result === undefined) return;
      toast({
        tone: 'ok',
        title: 'GitHub import added',
        message: `${String(result.created)} resource${result.created === 1 ? '' : 's'} queued to refresh into the cache now.`,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err);
      fields.capture(err);
    } finally {
      setImportBusy(false);
    }
  };

  const toggleIn = (list: readonly string[], name: string): readonly string[] =>
    list.includes(name) ? list.filter((item) => item !== name) : [...list, name];

  const isOrg = preview?.target.kind === 'org';
  const files = preview?.files ?? [];
  const visibleFiles =
    fileFilter.trim() === ''
      ? files
      : files.filter((path) => path.toLowerCase().includes(fileFilter.trim().toLowerCase()));
  const allFiles = preview?.files ?? [];
  const filesSelection = checkedFiles ?? allFiles;
  // ADR 0084: an organisation import takes every repository the token can
  // see. The preview list is read-only — no forks/archived toggles and no
  // per-repository checkboxes.
  const orgRepos = preview?.repos ?? [];
  const showsPrivateNotice =
    preview?.private === true || (preview?.repos ?? []).some((repo) => repo.private === true);
  const urlProblem = fields.errorFor('url');

  return (
    <div className="mt-3 rounded-panel border border-line bg-canvas p-3">
      <ErrorSummary errors={fields.summary} />
      <p className="mb-3 text-smallall text-ink-muted">
        Imported content may be read by club members through attached behaviours and sent to your AI
        providers, which may train on it. Preview first, then choose what to import.
      </p>
      <div className="grid gap-3">
        <Field
          label="GitHub URL"
          htmlFor="field-url"
          hint="A repository or organisation, for example https://github.com/acme/widget. Private repositories need a GitHub token that can read them."
          {...(urlProblem === undefined ? {} : { error: urlProblem })}
        >
          <Input
            value={url}
            onChange={(e) => {
              currentUrl.current = e.target.value;
              setUrl(e.target.value);
              setPreview(undefined);
              setCheckedFiles(undefined);
              setError(undefined);
              fields.clear();
            }}
            type="url"
            required
            placeholder="https://github.com/"
          />
        </Field>
      </div>
      <div className="mt-3 flex gap-2">
        <Button variant="primary" busy={previewBusy} onClick={() => void runPreview()}>
          Preview
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
      {error !== undefined && (
        <div className="mt-3">
          <ErrorNotice error={error} />
        </div>
      )}
      {preview !== undefined && (
        <div className="mt-3">
          {showsPrivateNotice && (
            <p role="note" className="text-small">
              Private repositories: club members will be able to ask about them, and their text is
              sent to your AI providers, which may train on it.
            </p>
          )}
          {!preview.authenticated && (
            <p className="text-small text-ink-muted">
              Without a GitHub token, only the README is read and organisations refresh once a day.
              Add a token on the{' '}
              <Link href="/assistant/setup" className="underline">
                AI setup page
              </Link>
              .
            </p>
          )}
          {isOrg ? (
            <>
              <p className="text-small">
                {`${String(orgRepos.length)} repositor${orgRepos.length === 1 ? 'y' : 'ies'}. All of them are added, and new ones are added automatically.`}
              </p>
              {preview.truncated === true && (
                <p className="text-small text-ink-muted">Showing the first 500 repositories.</p>
              )}
              {orgRepos.length === 0 ? (
                <p className="mt-2 text-small">
                  This organisation has no repositories this token can see.
                </p>
              ) : (
                <>
                  <ul className="mt-2 grid gap-1">
                    {orgRepos.map((repo) => (
                      <li key={repo.name} className="flex flex-wrap items-center gap-2 text-small">
                        <span>{repo.name}</span>
                        {repo.private === true && <Badge tone="hold">Private</Badge>}
                        {repo.description !== null && (
                          <span className="text-ink-muted">{repo.description}</span>
                        )}
                        {repo.fork && <span className="text-ink-muted">fork</span>}
                        {repo.archived && <span className="text-ink-muted">archived</span>}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 flex gap-2">
                    <Button
                      variant="primary"
                      busy={importBusy}
                      onClick={() => void runImport({ url })}
                    >
                      Import organisation
                    </Button>
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <div className="mt-2">
                <Field label="Filter files">
                  <Input
                    value={fileFilter}
                    onChange={(e) => setFileFilter(e.target.value)}
                    placeholder="docs/"
                  />
                </Field>
              </div>
              <ul className="mt-2 grid gap-1">
                {visibleFiles.map((path) => (
                  <li key={path}>
                    <Checkbox
                      label={path}
                      checked={filesSelection.includes(path)}
                      onChange={() => setCheckedFiles(toggleIn(filesSelection, path))}
                    />
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="primary"
                  busy={importBusy}
                  disabled={filesSelection.length === 0}
                  onClick={() =>
                    void runImport(
                      filesSelection.length === allFiles.length
                        ? { url }
                        : { url, include: filesSelection },
                    )
                  }
                >
                  Add
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
