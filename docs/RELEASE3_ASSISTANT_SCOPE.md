# Release 3 assistant scope

Reconciled 2026-09-20 against `docs/08_ROADMAP.md`, the Release 2/MCP pull-forward and the current repository.

## Already in Release 2 or MCP

- Owner-enabled Discord archive ingestion, attachment policy and retention.
- SQLite full-text search and the owner-only MCP read surface.
- Audit, permission and job infrastructure that Release 3 reuses.

Release 3 does not duplicate these. It adds the member-facing, permission-filtered assistant layer and gives every assistant control a dashboard home.

## Invocation behaviours

Each guild can configure reviewed behaviours selected by one invocation surface. Initial surfaces are mentions of `@bananasaurs` and `@it-services`. A behaviour owns its system prompt, resource set and skill allowlist. Owners edit system prompts in the dashboard with validation, visible revisions and conflict-safe writes. If one message invokes several configured tags, the request fails closed rather than merging personas.

The default club behaviour answers sourced questions in Canadian English. The IT services behaviour prioritises exact diagnostics, access steps and escalation, and cannot invent credentials or claim an access change occurred.

## Skills

The initial permission-aware catalogue is:

- search club knowledge with permission-filtered citations;
- link reviewed club resources;
- create and cancel reminders;
- deliver due reminders through a durable, idempotent job;
- draft decision records for review; and
- review plans against club sources;
- guide onboarding with sourced next steps;
- draft meeting agendas, summaries, announcements and handoffs; and
- draft event checklists with owners, dependencies and deadlines.

The model receives only the intersection of the behaviour allowlist and the invoking member's permissions. Read, draft, schedule and send effects stay distinct. `requiresConfirmation` marks the skills the model may never trigger on its own discretion. Skill attempts and outcomes belong in the dashboard activity view.

## Context and resources

The compiler uses a reviewed server card, enabled guild resources and accessible retrieved evidence. Evidence is delimited and labelled untrusted. Inaccessible evidence is removed before prompt compilation; its existence is not disclosed. A disclosure plan records the source identifiers selected for the response.

The resource registry supports reviewed websites, documents, Discord channels, repositories and notes. URLs require HTTPS and reject credentials, private addresses and local hosts before fetch; the production fetcher must also pin public DNS results through the request. The SFU Racerbot website is the first reviewed club resource.

## Reminders and schedules

A reminder records creator, guild, destination, text, due time, state and a stable dedupe key. Delivery claims due reminders, sends once through the Discord effect boundary, and records success or failure. The dashboard shows pending deliveries, destination and state and supports creation, cancellation and review.

## Dashboard ownership

- **Assistant**: invocation behaviours, tag mapping, system prompts and test scenarios.
- **Skills**: catalogue, per-behaviour allowlists, required permissions, confirmation class and recent activity.
- **Schedules**: reminders, destinations, next run, status, failures and cancellation.
- **Resources**: sources, freshness, scope and fetch health.
- **Context**: server card, reviewed memory and disclosure traces.
- **Providers**: free-only profile eligibility, privacy scan result, usage and degraded state.
- **Evaluation**: golden questions, inaccessible-channel traps, prompt injection and citation leakage.

No AI control is terminal-only.

## Live wiring on this branch (reconciled 2026-09-25)

Exactly what is live, so the release gate is measured against reality:

- **Persistence/API**: behaviours, resources, reminders, skill grants, activity, tickets and decisions persist per guild and are read/written through the dashboard API (`/api/assistant`, capability-gated and audited). Conversations, turns and the Discord message map (`assistant_conversations*`), per-run traces (`assistant_traces`), the resource cache (`resource_documents`, `resource_chunks` plus the FTS5 index), provider keys, the ordered model chain and the GitHub token persist alongside them. Saved reasoning and live thinking need `config.read`, like prompt text.
- **Discord routing**: `createAssistantCommandSubscriber` routes `@bananasaurs`/`@it-services` mentions to the assistant service. The mention router resolves the behaviour, enforces caller roles and fails closed on ambiguity. It enqueues an `assistant_invoke` job; the job handler performs resource fetches and the provider call, so a slow invocation cannot stall reaction roles, automod or `/mod`. The behaviour is re-resolved from storage when the job runs.
- **Commands**: `/mod` and its subcommands are the only registered slash commands. Assistant skills are reached by mentioning the bot.
- **Provider chain**: the single provider row is replaced by several labelled keys per provider (Gemini, OpenRouter, NVIDIA NIM — sealed values, cost class, enabled flag, per-provider terms record under hard rule 5) and one ordered model chain of up to 6 key-plus-model entries, managed on the owner-only AI setup page (`/assistant/setup`, `/providers` alias). At run time the harness tries the chain in order, moving on when a model is busy, rate-limited, timed out, or its provider is ineligible or unconfigured; once a request has started a tool loop on one entry it stays on that entry, and a mid-loop failure restarts from round 1 on the next entry. A process-wide free-allowance ledger keyed by key id keeps a spent `:free` daily allowance spent across guilds until its reset; a daily-free quota error is answered at once with the daily-cap reply (reset time when known, else next UTC midnight) instead of the 10s/30s/90s retry path. `AI_PROVIDER=off` answers with a configured-refusal, never a 500. Every provider runs behind the SafeProvider spend and outbound-scan boundary. Gemini, OpenRouter, and NVIDIA NIM deliberately ship with no seeded eligibility row: an owner must review current provider terms and record the decision before production use. Until then they appear as `unverified` and fail closed.
- **Tool loop**: round 1 offers every read-only tool the behaviour allows (`search_sources`, `list_sources`, `read_chunk`, `outline`, `open_resource`, `search_archive`, `web_search`, `server_info`, `current_time`, `my_reminders`, `refresh_source`), up to 6 calls in parallel. Rounds 2–4 offer only `read_chunk`, `outline` and `open_resource`, and only with IDs an earlier result in the same request returned — anything else is refused as unknown id, so injected text cannot steer a new search. Budgets: 4 rounds, 6 calls per round, 12 calls total, about 24,000 characters of tool results, max output tokens from the `assistant.maxOutputTokens` setting (default 4,096) (Gemini thinking budget 512 for tool rounds, 1,024 for the answer). On a stop without an answer, one final call runs with no tool declarations. Tool calls are native and structured only, each through its Zod schema; results are short bounded text with IDs.
- **Conversations**: a message joins a conversation by tag or reply only — reply to a bot answer continues (whoever replies), reply to a conversation turn plus tag continues, reply to another person's message plus tag starts a new conversation with that message quoted as untrusted evidence (same channel, fetched through the Discord port), same-author tag within 30 minutes continues, otherwise a new conversation starts. `new topic` / `new question` after the tag always starts fresh; the dashboard can end a conversation. Mention-based answers are recorded, so a Discord Reply to one continues that conversation. The model sees the last 12 turns (about 6,000 characters) as `user` / `assistant` messages, prefixed with display names in multi-speaker threads; stored answers carry what was learned, tool results are not replayed. Answers post as Discord replies. The Conversations page lists newest first with channel/member/behaviour filters and title search, transcripts with History-trace and Discord links, End and Delete buttons. Auto-delete after 2/6/12 months (default 6) measured from last activity, via a daily durable prune job that also removes turns, the message map and traces with a count-only audit row.
- **Resource cache and its tools**: fetched documents persist in `resource_documents`, chunked into `resource_chunks` (Markdown splits at headings with the heading path kept; HTML converted to text first; plain text and code in 60-line windows with 10 lines of overlap; 1,500 characters or less per chunk) and indexed in a hand-written FTS5 table ranked with `bm25()`. A durable per-guild refresh runs hourly plus per-resource Update now and Update all, using conditional requests and re-chunking only on content-hash change; the request path reads the cache, and a new resource is fetched when added. GitHub import from Resources accepts org, repo or file/folder URLs: a repo preview shows name, description, branch and the files it will read (README, `docs/**/*.md`, CONTRIBUTING, CHANGELOG, top-level `*.md`) with checkboxes and a path filter; an org lists public repos with fork/archived toggles and per-repo checkboxes; adding creates one parent plus one child resource per repo on `raw.githubusercontent.com`, with hourly org re-listing that adds new public repos and disables deleted or newly private ones (40 files per repo, 200 KB per file, 2 MB per repo, via the git trees API). The owner-only GitHub token on AI setup is sealed and never logged: with it 5,000 requests an hour; without it 60 an hour, organisations re-listed once a day, README files only. The prompt carries only a catalogue (one line per source, preferred first, capped at 60 lines) plus the top 4 FTS snippets for the question; the tools disclose progressively (`list_sources` up to 30 lines, `search_sources` up to 6 hits of 300 characters capped at 2,000 total, `read_chunk` / `open_resource` up to 4,000 characters, `outline` up to 1,500, `refresh_source` round 1 only and at most once per 10 minutes per resource), every result redacted and wrapped as untrusted evidence.
- **Reminders**: Mention the bot to request reminders; the reminder tool validates time and text, requires a real destination channel, and records skill activity. Delivery runs through the durable job with atomic claims, backoff retries and a terminal window measured from the due time. Cancellation is a dashboard action.
- **Decisions and IT escalation**: Mention the bot to request decision or plan drafts, marked as analysis and never club policy; an IT `ESCALATE:` response opens a deduped ticket and notifies the reviewer channel with mentions restricted to reviewer roles.
- **Known live limits**: Mention-based search fails closed until Discord channel visibility is verified for the request; golden evaluations run as a test suite, not a live gate; a note resource cannot hold free text (URL validation applies to every resource kind); a second provider key on the same provider account is not a real backup against the per-account free daily allowance.

## Release gate

Release 3 is complete only when all original roadmap bullets are implemented, every new capability has a dashboard path, the golden suite finds no permission leak, provider failure leaves Releases 1 and 2 working, and actual desktop/mobile pixels plus end-to-end Discord behaviour are reviewed. Provider adapters alone are a foundation, not Release 3.

## Fresh deployment and provider boundary

A writable fresh deployment creates the product-owned direct-command behaviour and attaches the built-in skill catalogue. These skills, prompts, reviewed resources, memory and permission controls are visible before any AI provider is enabled.

`AI_PROVIDER` defaults to `off`. In that state no member content is sent to an external provider. Enabling a behaviour does not cross that boundary: provider traffic also requires a configured model and key plus a current eligible provider record. Missing or unverified configuration fails closed.
