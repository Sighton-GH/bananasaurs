# ADR 0105: task reply capture needs an unambiguous anchor

Status: accepted for the planning branch.

A reply in a task's existing Discord thread is not automatically a progress report for that task. A thread can contain several tasks and a reply can refer to another member's unrelated message. A matching destination ID, even with exactly one task currently in the database, is not a stable identity: a second task could be added later. Therefore the background subscriber must not store replies on that inference. The task system needs a persisted task-specific message anchor, or an explicit member selection, before a reply can be attributed. No reply subscriber is registered while the task system sends no such anchor.

The report repository offers an idempotent write keyed by a first-party Discord message ID, scoped to a guild and task, which a later validated subscriber may use. It refuses done/archived tasks and writes an audit event on first receipt only. The repository does not authenticate a Discord author or prove thread context; the future adapter must do both. Report bodies are private club content and are never put in an audit row.
