import { type LinkRow } from '../../../ui/LinkListEditor.js';

export type Task = {
  taskId: string;
  teamId: string;
  title: string;
  description: string;
  status: 'not_started' | 'in_progress' | 'awaiting_approval' | 'done';
  priority: 'normal' | 'urgent';
  assignmentKind: 'team' | 'individual';
  assigneeId: string | null;
  assigneeIds: string[];
  dueAt: number;
  timezone: string;
  destinationId: string;
  version: number;
  archivedAt: number | null;
  /** Present on the real response (clubTasks row); optional for older fixtures. */
  createdAt?: number;
  updatedAt?: number;
};
export type Team = { teamId: string; name: string; kind: string };
export type Child = {
  childId: string;
  title: string;
  dueAt: number;
  status: string;
  completedAt: number | null;
};
export type Report = { reportId: string; authorId: string; body: string; createdAt: number };
export type Reminder = { slotId: string; kind: string; dueAt: number; state: string };
export type Detail = {
  task: Task;
  team: Team | null;
  children: Child[];
  reports: Report[];
  reminders: Reminder[];
  links: LinkRow[];
};
export type Assignee = { memberId: string; displayName: string };
export type Destination = { channelId: string; name: string; kind: string; parentName?: string };

export const STATUS_LABEL: Record<string, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  awaiting_approval: 'Awaiting approval',
  done: 'Done',
};
