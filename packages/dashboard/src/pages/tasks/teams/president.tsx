import { useState } from 'react';
import { useSession } from '../../../app/session.js';
import { Field } from '../../../ui/Field.js';
import { Select } from '../../../ui/Select.js';
import { type RoleCandidate } from './types.js';

const NONE = '__none';

export function PresidentSection({
  candidates,
  presidentRoleId,
  onChanged,
}: {
  candidates: RoleCandidate[];
  presidentRoleId: string | null;
  onChanged: () => void;
}) {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const change = async (roleId: string) => {
    setBusy(true);
    try {
      if (roleId === '') {
        await session.write('/api/tasks/president-role', undefined, 'DELETE');
      } else {
        await session.write('/api/tasks/president-role', { roleId }, 'PUT');
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mb-4 grid max-w-xl gap-1 rounded-panel border border-line bg-panel p-4">
      <Field
        label="President role"
        hint="The saved role ID controls approval access, not the role name."
      >
        <Select
          id="task-president-role"
          disabled={busy}
          value={presidentRoleId ?? NONE}
          onValueChange={(value) => void change(value === NONE ? '' : value)}
          options={[
            { value: NONE, label: 'Not selected' },
            ...candidates.map((role) => ({
              value: role.roleId,
              label: `${role.name} (${role.roleId})`,
            })),
            ...(presidentRoleId && !candidates.some((role) => role.roleId === presidentRoleId)
              ? [{ value: presidentRoleId, label: 'Configured role (not in suggested list)' }]
              : []),
          ]}
        />
      </Field>
    </section>
  );
}
