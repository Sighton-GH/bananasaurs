# 0073. Resource cache, FTS tools and GitHub import

Date: 2026-09-24
Status: Accepted (owner approved spec 2026-09-24)

## Context

Every request fetches every enabled resource live and pastes it into the
prompt, with only a 5-minute in-memory cache lost on restart. The assistant
needs a persistent cache it can search, plus GitHub repositories the owner can
add. Implements spec Part F sections F1–F4.

## Decision

- The cache is `resource_documents` (guild, resource, document ID, URL, path,
  title, ETag, Last-Modified, content hash, fetched at, size, status, error),
  `resource_chunks` (guild, chunk ID, document, resource, heading path, line
  range, text) and a hand-written FTS5 table `resource_chunks_fts` (ADR 0049
  pattern) ranked with `bm25()`.
- Chunking: Markdown splits at headings, keeping the heading path
  (`README.md › Setup › Docker`); HTML is converted to text and split the same
  way; plain text and code split into 60-line windows with 10 lines of
  overlap. Target 1,500 characters or less per chunk.
- Refresh: a durable `resource_refresh` job per guild, enqueued hourly
  (dedupe key guild plus hour) and by an Update now button per resource and
  Update all. It uses conditional requests (ETag / If-Modified-Since) and
  re-chunks only when the content hash changes. The request path never fetches
  live any more; it reads the cache, and a new resource is fetched when added.
- GitHub import: an Add from GitHub flow accepts an org, repo, or file/folder
  URL. A repository preview shows name, description and default branch, then
  the files it will read (README, `docs/**/*.md`, CONTRIBUTING, CHANGELOG,
  top-level `*.md`) with checkboxes and an optional path filter. An
  organisation lists every public repository with toggles for forks (off) and
  archived (off) and a checkbox per repo. Adding creates one parent resource
  plus one child resource per repo, each pointing at
  `raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}`. The hourly
  refresh re-lists the organisation; new public repos are added automatically
  and repos that turn private or are deleted are disabled.
- Limits: 40 files per repo, 200 KB per file, 2 MB per repo. File lists come
  from the git trees API (`?recursive=1`).
- Token (spec decision O4): an owner-only GitHub token field in AI setup,
  sealed like the Brave key and never logged. With it, 5,000 requests an hour
  and free conditional requests. Without it, 60 an hour, organisations are
  re-listed once a day, and only README files are fetched. The page says so
  plainly.
- Network: `api.github.com` and `raw.githubusercontent.com` are the only new
  destinations, through the existing HTTPS-only fetcher that refuses private
  addresses.
- The prompt carries only a catalogue: one line per source, preferred
  resources first, capped at 60 lines. Pre-retrieval takes the top 4 FTS
  snippets for the question. Search tools use progressive disclosure:
  `list_sources` (up to 30 lines), `search_sources` (up to 6 hits of up to 300
  characters, 2,000 total), `read_chunk` and `open_resource` (up to 4,000
  characters), `outline` (up to 1,500 characters), and `refresh_source`
  (round 1 only, at most once per 10 minutes per resource). Every result is
  redacted like evidence today and wrapped in the untrusted envelope.

## Consequences

Answers read from a fresh cache instead of slow live fetches, and GitHub docs
behave like any other resource. The cost is storage and an hourly refresh
job, plus a token the owner should add for any organisation of real size.
