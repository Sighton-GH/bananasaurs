# ADR 0098: explicit president role for task visibility

Status: accepted for the planning branch.

A role whose name contains "president" is only a setup hint, never an authority source. The instance owner selects a specific role ID for each guild. The choice is stored under the guild key, and each member task read rechecks that the role exists in the current guild directory and that the caller has it in a fresh Discord member lookup. If no role is selected or the role is missing, nobody gains president-wide visibility. A member who has that role still needs an account-to-Discord identity binding. The account-binding workflow remains incomplete until the member proves control of their Discord account. Planning mode never sends Discord reminders or changes roles.
