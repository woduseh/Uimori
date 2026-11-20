import { useEffect, useState } from 'react';
import { api } from './api.js';

let known: boolean | undefined;

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
