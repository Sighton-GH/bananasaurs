# 0083. Private GitHub repositories through the owner's token

Date: 2026-09-26

Status: accepted (owner decision 2026-09-26)

## Context

ADR 0073 cached public repositories only. It refused a private repository and disabled a
repository that turned private. On 2026-09-26 the owner decided otherwise:

> "i want to add private repo support via fine grain access token with contents read
> permission. any repo i give access to i am allowing club members to ask about it and ai
> providers to potentially use it."

So the token's own reach is the consent boundary. The owner grants access per repository when
creating a fine-grained token (Contents: Read-only), and the bot caches whatever that token can
read.

Raw downloads today go through the generic reviewed-resource fetcher to
`raw.githubusercontent.com`, and that fetcher never carries the token. The organisation listing
uses `/users/{owner}/repos`, which returns public repositories only.

## Decision

1. **A private repository is cached when the configured token can read it.** The private
   refusal is removed from the repository refresh, the organisation refresh and the import
   routes.
2. **Private files come through the authenticated API client**, from
   `GET /repos/{owner}/{repo}/contents/{path}?ref={ref}` with the raw media type and
   `If-None-Match`. Public repositories keep fetching from `raw.githubusercontent.com` through
   the reviewed fetcher, so the token stays off every request that does not need it. No new
   network destination: `api.github.com` is already allowed.
3. **Organisation listing** uses `/orgs/{owner}/repos?type=all` and falls back to
   `/users/{owner}/repos?type=owner` when GitHub answers 404 (the owner is a user, not an
   organisation).
4. **Lost access hides the content.** When the token can no longer read a repository (GitHub
   answers 404 for it), the resource is disabled, as ADR 0073 did for a repository that turned
   private. A disabled resource is never searched.
5. **Disclosure is visible.** A private repository carries `meta.private: true`. The Resources
   page marks it "Private", and the import preview says that members can ask about it and that
   its text is sent to the AI providers. The GitHub token card explains the Contents: Read-only
   permission and the same consequence. PRIVACY.md says so (hard rule 5: a provider that may
   train must be disclosed).

## Consequences

- Private repository text reaches every member who can ask the assistant, and the AI
  providers, some of which may train on it. The owner accepted this explicitly.
- The Sources line links to github.com URLs that members without repository access cannot
  open.
- API file fetches count against the token's 5,000 requests an hour. Unchanged files answer
  304, and GitHub does not count an authorised 304 against the limit.
