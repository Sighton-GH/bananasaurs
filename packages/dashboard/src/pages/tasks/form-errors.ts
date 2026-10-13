type Entry = { fieldId: string; message: string };
const ORDER = [
  'title',
  'description',
  'teamId',
  'assignmentKind',
  'assigneeIds',
  'destinationId',
  'dueAt',
  'timezone',
  'priority',
  'extraReminderAt',
  'links',
];
const LABELS: Readonly<Record<string, string>> = {
  title: 'Task title',
  description: 'Description',
  teamId: 'Team',
  assignmentKind: 'Audience',
  assigneeIds: 'People',
  destinationId: 'Destination',
  dueAt: 'Due date and time',
  timezone: 'Timezone',
  priority: 'Priority',
};
export function taskErrorSummary(
  entries: readonly Entry[],
  people: readonly { displayName: string }[],
): Entry[] {
  return entries
    .map((entry) => {
      const path = entry.fieldId.slice(6).split('-');
      const root = path[0] ?? '';
      const index = Number(path[1]);
      const label =
        root === 'links'
          ? `Link ${index + 1} ${path[2] === 'url' ? 'URL' : 'label'}`
          : root === 'assigneeIds' && path.length > 1
            ? `Person ${people[index]?.displayName ?? `row ${index + 1}`}`
            : root === 'extraReminderAt'
              ? `Extra reminder ${index + 1}`
              : (LABELS[root] ?? root);
      return { ...entry, message: `${label}: ${entry.message}` };
    })
    .sort((a, b) => {
      const key = (e: Entry): number => {
        const i = ORDER.indexOf(e.fieldId.slice(6).split('-')[0] ?? '');
        return i < 0 ? ORDER.length : i;
      };
      return key(a) - key(b) || a.fieldId.localeCompare(b.fieldId, undefined, { numeric: true });
    });
}
