import { useEffect, useState } from 'react';
import { api } from './api.js';

/** Mock controls are available only on explicitly configured local test servers. */
export function useTestMode() {
  const [testMode, setTestMode] = useState(false);
  useEffect(() => {
    let current = true;
    void api<{ testMode?: boolean }>('/health')
      .then((health) => {
        if (current) setTestMode(health.testMode === true);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);
  return testMode;
}
