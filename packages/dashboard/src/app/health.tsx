import { createContext, useCallback, useContext, type ReactElement, type ReactNode } from 'react';
import { useResource, type UseResource } from '../hooks/useResource.js';
import { useSession } from './session.js';

export interface HealthInfo {
  guildId: string;
  guildName: string | null;
  gateway: { connected: boolean; pingMs: number | undefined; guildCount: number };
  safety: { killswitch: boolean; dryRun: boolean; breakerOpen: boolean } | undefined;
  jobCounts: Record<string, number>;
  oldestDueJobAtMs: number | undefined;
}

const HealthContext = createContext<UseResource<HealthInfo> | undefined>(undefined);

/**
 * `/api/health` is fetched once for the shell, because both the Overview page
 * and the state strip read it and the strip is on every page. A page that
 * changes safety state (the kill switch) calls `reload()`.
 */
export function HealthProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const session = useSession();
  const load = useCallback(() => session.read<HealthInfo>('/api/health'), [session]);
  const value = useResource('the health summary', load);
  return <HealthContext.Provider value={value}>{children}</HealthContext.Provider>;
}

export function useHealth(): UseResource<HealthInfo> {
  const health = useContext(HealthContext);
  if (health === undefined) throw new Error('useHealth must be used inside <HealthProvider>');
  return health;
}
