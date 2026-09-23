# 0061. Assistant setup is complete in the dashboard

Date: 2026-09-23
Status: accepted (owner decisions recorded 2026-09-23)

## Context

The 2026-09-23 audit of `oc/assistant-pages` found that a first-time owner could not
get the assistant answering from the dashboard. Three settings needed the host:

- **The provider terms record.** `provider_eligibility` rows were seeded only by migration
  (ruling M4-D16).
- **The cost class.** `AI_PROFILE_COST_CLASS` defaults to `unknown`. The spend cap is $0, so
  `SafeProvider` refuses every call unless `.env` says `free`.
- **The key-encryption secret.** `ASSISTANT_PROVIDER_SECRET_KEY` had to be written into `.env`
  by hand.

`docs/RELEASE3_ASSISTANT_SCOPE.md` says "No AI control is terminal-only". The owner chose to
close all three gaps.

## Decision

1. **The owner records provider terms in the dashboard.** A form that only the instance
   owner can use writes the `provider_eligibility` row. It needs: trains on input
   (`no`/`yes`/`unknown`), the quoted terms clause, the terms URL (https), and production
   use allowed. The review date is set to now.
   - Hard rule 5 is unchanged: only `no` with a non-empty cited clause allows traffic, and
     `unknown` counts as `yes`.
   - Every write is audited with the full claim, and the new `evidence_clause` column keeps
     the quoted clause.
   - This supersedes M4-D16 for these rows: a dashboard record is as authoritative as a
     seeded one. `PRIVACY.md` points operators at the AI setup page for the current record.
2. **The owner states the model's cost class in the dashboard.** `free`, `paid` or
   `not sure` is stored on the provider configuration and overrides `AI_PROFILE_COST_CLASS`.
   - The monthly cap stays $0, so only `free` passes. The dashboard never allows spend.
   - The form warns that marking a paid model free can cost money, and changes are
     audited.
3. **The daemon generates the key-encryption secret when it is missing.**
   - If `ASSISTANT_PROVIDER_SECRET_KEY` is unset, the daemon reads or creates
     `<BANANASAURS_DATA_DIR>/assistant-provider.key`: 32 random bytes, created with
     `O_EXCL`, mode 0600.
   - A file readable by group or others is refused, and AI stays off with a named reason.
     Under `BANANASAURS_READONLY` the file is read but never created.
   - The env var still wins. The file is not in database backups, so restoring onto a new
     host means entering the provider key again, and the dashboard says so when a stored
     key cannot be decrypted.

## Consequences

- An owner can go from an empty database to an answering assistant without a shell.
- **The trust boundary moves from "whoever can write a migration" to "the instance owner's
  dashboard session".** That is the same principal who can already enable the provider and
  enter its key. Operators who are not the owner cannot record terms.
- The generated key file is a new secret on disk. It sits beside the database under the
  same filesystem permissions, which protects against backup leakage and against the API
  ever returning a key. It does not protect against an attacker who has the host.
