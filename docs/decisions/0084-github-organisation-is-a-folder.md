# 0084. A GitHub organisation is a folder of every repository

Date: 2026-09-26

Status: accepted (owner request 2026-09-26)

## Context

The owner adds the club's repositories by importing the GitHub organisation. On 2026-09-26 they
asked that this "work without issue": group the repositories under the organisation like a
folder, always include every repository, keep watching for new ones, and include private
repositories the token can read (ADR 0083).

Reading the code found these gaps:

1. The Resources page is a flat list. The organisation shows only "N repositories".
2. Forks and archived repositories are left out unless ticked at import. The import panel also
   has per-repository checkboxes, but the hourly organisation refresh adds every eligible
   repository anyway, so the checkboxes mislead.
3. A repository found by the hourly refresh has its files fetched only at the *next* hourly
   sweep, because the sweep iterates a snapshot of the resource list.
4. **Disable does not work for GitHub resources.** The dashboard sends the whole resource to
   `PUT /api/assistant/resources/:id`, whose schema accepts only
   `website | document | discord-channel | repository | note`, so the request is refused (400).
   And if a child were disabled, the organisation refresh would re-enable it within the hour.
5. `createGitHubClient` computes `authenticated` once, when the daemon builds it. A token saved
   later still reads as "no token" (README only, daily organisation re-list) until a restart.

## Decision

1. **Every repository.** Organisation import and refresh include every repository the token can
   see: forks, archived and private (ADR 0083) alike. The forks/archived toggles and the
   per-repository checkboxes are removed. Old `includeForks`/`includeArchived` meta values are
   ignored.
2. **Owner's choice sticks.** A new route, `PUT /api/assistant/resources/:id/enabled` with body
   `{ enabled }`, changes only the enabled flag, for every kind. Disabling a GitHub resource
   there records `meta.disabledByOwner: true`; enabling clears it. The organisation refresh never
   re-enables a child the owner turned off. It still turns off repositories that left the
   organisation, and turns them back on when they return, unless the owner turned them off.
3. **New repositories are ready within the same refresh.** After an organisation refresh, the
   same job refreshes each child that did not exist before it ran.
4. **The token takes effect immediately.** `GitHubClient.authenticated` reads the token on every
   access.
5. **The Resources page groups.** A `github-org` resource renders as a collapsible group holding
   its child repositories, with counts (repositories, private, turned off). Children are not
   repeated at the top level. GitHub resources have no Edit button, because their title, URL and
   files come from GitHub.

## Consequences

- Forks can bring upstream documentation into search. The per-repository Disable is the way to
  drop one.
- An organisation refresh that finds many new repositories takes longer: each new repository is
  fetched in the same job.
