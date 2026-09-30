# ADR 0097: owner edits use an expected version

Status: accepted for the planning branch.

The owner may edit an open task's title, description, priority, deadline, destination and assignment. A full replacement body carries the version last read from the board. A stale version rejects the write instead of overwriting another edit. The server rechecks the team's category, destination, and an individual assignee's live Discord membership and stored team membership for every edit. Team scope cannot be changed through edit; moving a task between teams needs a separately reviewed workflow. Edits do not post to Discord or schedule reminders in planning mode. This slice keeps one individual assignee per task; multi-assignee tasks need a separate schema and UI decision before activation.

Thread destinations require a live Discord fetch. A thread is accepted only if its parent is a channel in the mapped category; a forum post's parent is the forum under that category. A moved, deleted or otherwise inaccessible thread fails closed. The gateway's text-channel picker alone is not evidence for a thread, since it deliberately excludes threads.
