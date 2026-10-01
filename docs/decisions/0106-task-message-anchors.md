# ADR 0106: task-specific message anchors for progress replies

Status: accepted for the planning branch. Partly superseded by ADR 0111.

The owners want the bot to ask for clarification when a member's update could refer to several tasks. A reply to a task-specific bot message can identify the task without model inference; an unanchored reply in a shared channel or thread cannot. Store one confirmed Discord anchor message ID for each task, with guild and destination channel, and reject attempts to move an anchor on retry. A Discord reply is an attributable report only when its referenced message ID matches that anchor in the same channel and guild, the member is live and authorised for the task, and the destination/category is current. Where no unique anchor matches, return candidate tasks to the assistant's clarification path instead of guessing. The candidate lookup itself never authorises a write.

The repository now stores and resolves anchors. It does not post them: send-time checks, a durable idempotency key, retries and reconciliation need to be part of the later activation path. No message is sent in planning mode. The schema migration is numbered 0060 to leave 0053-0059 to the reminder-worker branch; its journal entry must be ordered after those migrations when integrated. A repository write does not prove bot authorship of an arbitrary supplied message ID: only the validated sender path may call it.

The reply subscriber now records only a message whose Discord reference matches the persisted anchor and whose author, team membership, category and destination pass fresh checks. Unanchored replies stay ambiguous and do not write; the assistant clarification integration remains outstanding. Staged task creation still does not post anchors, so this path has no active anchor until a separately validated send path records one.

Once an anchor exists, a normal task edit cannot move its destination. Re-anchoring needs its own reviewed, idempotent send and reconciliation workflow; silently changing only the task row would strand replies at the original message.
