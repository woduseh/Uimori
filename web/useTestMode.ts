import { useEffect, useState } from 'react';
import { api } from './api.js';

// Resolved once per page: later mounts (settings sections) render their controls
// synchronously instead of showing them a fetch later.
let known: boolean | undefined;

/** Mock controls are available only on explicitly configured local test servers. */
export function useTestMode() {
  const [testMode, setTestMode] = useState(known ?? false);
  useEffect(() => {
    if (known !== undefined) return;
    let current = true;
    void api<{ testMode?: boolean }>('/health')
      .then((health) => {
        known = health.testMode === true;
        if (current) setTestMode(known);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);
  return testMode;
}
