# ADR 0102: dashboard task reads are owner-only

Status: accepted for the planning branch. The owners confirmed permanent owner-only dashboard scope on 2026-09-29.

The owner-entered task account binding checks that a Discord member exists. It does not prove that the dashboard account holder controls that member's Discord account. Neither a matching name nor the presence of a live role closes this gap. The existing non-owner task read routes could disclose a team's tasks to an account mistakenly or deliberately bound to someone else's Discord identity.

All dashboard task list and detail reads remain owner-only by design. The detail route returns the same not-found result for all non-owner task IDs. The binding and membership records remain planning metadata; they do not grant dashboard task access. Discord's own authenticated task commands remain a separate path. The interface states that members use Discord, not the dashboard. No challenge, account linking or member dashboard read reopening is planned; revisit the dormant binding routes for removal.
