# 0082. The resource cache keeps document structure

Date: 2026-09-26

Status: accepted (owner request 2026-09-26)

## Context

Two live answers on 2026-09-26 showed the resource cache (ADR 0073) was broken:

- A "Sources:" line under an answer printed an entire README.
- `search_sources` answered "No matching passages" for follow-the-gap on Car 2, although
  `docs/operations.md` in that repository documents it.

Driving the pipeline with the real files found these causes:

1. `extractEvidenceText` collapsed **all** whitespace, newlines included, for every media type,
   although its comment said markdown passed through unchanged. A README became one line. The
   chunker's heading pattern then read the whole file as one heading, so every chunk's
   `headingPath` was the document (8,044 characters for `docs/operations.md`).
2. The same function cut text at 8,000 characters. It was written for live evidence, but since
   Task 16 the refresh job is its only caller, so the cache stored the first 8,000 characters of
   every file. The follow-the-gap command sits at character 12,791.
3. `search_sources` stops at the first result line over its 2,000-character budget. A flattened
   heading is always over budget, so one such hit hid every hit.
4. Without a GitHub token only README files are cached. The only notice was a tooltip in the
   import panel.
5. The default file selection (root markdown and `docs/**/*.md`) missed most club content:
   22 of racerbot-docs' 26 markdown files are under `labs/`, `notes/` and `resources/`, and
   Car 2's package READMEs are under `src/`.
6. A github.com URL added as a plain website resource caches GitHub's page chrome ("Skip to
   content Navigation Menu Sign in …"), not the repository's files.
7. The FTS query ORs every word, so "i", "the" and "to" match almost every chunk.

## Decision

1. **Text keeps its lines.** The fetcher passes the body through with only NUL characters
   removed. `extractEvidenceText` is deleted. The chunker already converts HTML with
   `htmlToText`, which keeps headings, list items and paragraphs, and now also drops `<head>`
   and `<svg>`. Converting once, in the chunker, avoids a second pass that would strip a
   decoded `<approved>` a second time. The chunker also ignores `#` lines inside fenced code
   blocks, because shell comments are not headings.
2. **No character cap on cached text.** The fetcher's 1 MB body cap, GitHub's 200 KB per-file
   cap and the chunker bound it. Every tool result is still capped where it is shown.
3. **Headings are bounded twice.** The chunker clips each heading segment to 120 characters.
   Display sites (`search_sources`, `read_chunk`, `outline`, the Sources line) clip the whole
   heading path with the same helper. `search_sources` skips a line that does not fit instead
   of stopping.
4. **Default GitHub selection is every markdown file**, `**/*.md` and `**/*.markdown`, excluding
   any path segment that starts with `.` and any `node_modules` or `vendor` segment. The order
   is root README, then `docs/**`, then other READMEs (shallowest first), then other markdown
   (shallowest first), with root CHANGELOG last. The file cap rises from 40 to 100. The 200 KB
   per-file and 2 MB total caps stay. A resource's own `include` patterns still replace the
   default.
5. **github.com is not a website resource.** Saving a `website`, `document` or `repository`
   resource whose host is `github.com` or `www.github.com` is refused with
   `github-url-needs-import`. Existing ones fail their refresh with the same code (no network
   call) and their cached chunks are dropped. `raw.githubusercontent.com` URLs stay allowed.
6. **README-only is shown, not hidden.** The freshness route reports whether a GitHub token is
   configured. The Resources page shows a warning, and a "README only" badge on each GitHub
   resource, while it is not.
7. **Search drops filler words.** A short English stopword list is removed from the FTS query.
   A query made only of stopwords keeps its words.
8. **One data migration** clears `etag`, `last_modified` and `content_hash` on every
   `resource_documents` row. Otherwise a 304 answer would keep the old flattened chunks for
   ever. The next refresh re-fetches and re-chunks everything.

## Consequences

- Cached documents are larger (whole files, not 8,000 characters), bounded by the caps above.
- A repository can cache up to 100 files. With a token that is well inside GitHub's limits,
  and raw file fetches are conditional after the first refresh.
- Owners must re-add github.com website resources through "Add from GitHub". The error says so.
- The deploy needs stop → `npm run db:migrate` (0048) → build → start, then "Update all".
- Private repositories stay out of scope (ADR 0073). The owner decided that on 2026-09-26.
