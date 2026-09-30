# ADR 0104: dated child changes use the parent task version

Status: accepted for the planning branch.

A task's optional dated children do not have their own version column. Child create, edit, complete and delete therefore compare-and-swap on the parent's task version within the same guild-scoped transaction. Every successful change increments that version and writes an audit event in the same transaction. A stale parent version, a missing child, a done or archived parent, or a cross-guild reference makes no change and writes no success audit. Completed children cannot be edited; deleting one requires owner review in the dashboard and is not exposed to the model as a background action.

The old unversioned repository helper for adding or completing a child is removed so no caller can bypass the transition. The owner HTTP routes require the expected parent version. Existing task UI does not yet expose child editing, and no Discord post follows.
