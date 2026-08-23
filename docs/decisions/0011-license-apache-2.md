# ADR 0011: Apache-2.0 license

Status: accepted (2026-08-22)
Resolves: open question 2 in `docs/12`

## Decision

Bananasaurs is licensed **Apache-2.0**.

## Rationale

The goal is a self-hosted application other clubs can run, with contributions accepted and no copyleft negotiation. Apache-2.0 gives permissive reuse, an explicit patent grant, and a clear attribution requirement, and it is the least surprising choice for a project that will be read by school and university people.

## Consequences — binding rules for implementation

| Upstream | License | Rule |
|---|---|---|
| YAGPDB | MIT | Code may be adapted, with attribution and the MIT notice preserved, recorded in `docs/PROVENANCE.md` |
| Red-DiscordBot | GPL-3.0 | **Do not copy code.** Study behaviour, command structure, and test cases; write original implementations |
| Zeppelin | Elastic License 2.0 | **Do not copy code.** Source-available, not open source; use as a design reference only |
| Carl-bot, Dyno | Proprietary | Public documentation defines feature expectations. No reverse engineering, no scraping of private behaviour |
| Anything with an unclear or missing license | — | Do not copy |

Add `LICENSE` at the repository root before the first commit of application code, and a `docs/PROVENANCE.md` ledger recording upstream URL, commit, file, license, and modifications for anything adapted.

This rule is repeated in `CLAUDE.md` because an implementing agent can violate it in a single paste, and the violation is invisible in review unless someone is looking for it.
