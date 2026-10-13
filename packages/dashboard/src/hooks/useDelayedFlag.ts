import { useEffect, useState } from 'react';

/** False until `ms` have passed while `active` stays true; resets when `active` goes false. */
export function useDelayedFlag(active: boolean, ms: number): boolean {
  const [flag, setFlag] = useState(false);
  useEffect(() => {
    if (!active) {
      setFlag(false);
      return;
    }
    const t = setTimeout(() => setFlag(true), ms);
    return () => clearTimeout(t);
  }, [active, ms]);
  return flag;
}
