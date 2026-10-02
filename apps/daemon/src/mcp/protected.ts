import { panelRepo, taskNudgeRepo, type GuildScope } from '@bananasaurs/storage';

/**
 * The protected-message guard for the MCP message writes (ADR 0116 §4):
 * role-panel messages (`panels.message_id`) and task posts (anchors and nudges)
 * (`task_message_anchors.message_id`) are never edited or deleted through
 * the MCP, whatever authored them.
 *
 * Message-id only and guild-scoped, so the check cannot be bypassed by
 * naming a different channel and another guild's protected message never
 * counts. The panel side is a dedicated finder (`isPanelMessage`); the
 * task side reuses the existing `isTaskPost`, which covers anchors and
 * the task module's sent nudge slots — both are the task module's own
 * posts, and neither is the MCP's to touch.
 *
 * A pure storage read: no Discord call, so the edit/delete wiring runs
 * this before the live authorship check.
 */

export type ProtectedMessageReason = 'role-panel' | 'task-post';

export const protectedMessageReason = (
  scope: GuildScope,
  messageId: string,
): ProtectedMessageReason | undefined => {
  if (panelRepo.isPanelMessage(scope, messageId)) return 'role-panel';
  if (taskNudgeRepo.isTaskPost(scope, messageId)) return 'task-post';
  return undefined;
};
