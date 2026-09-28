import { useEffect, useRef, useState } from 'react';
import type {
  CodexContentPreflightResult,
  CodexContentWarningRole,
} from '../core/codex-content-warning.js';
import { api } from './api.js';

export type CodexContentWarningGate = ReturnType<typeof useCodexContentWarning>;

export function useCodexContentWarning() {
  const [warning, setWarning] = useState<CodexContentWarningRole | null>(null);
  const resolver = useRef<((proceed: boolean) => void) | null>(null);
  const checking = useRef(false);

  const settle = (proceed: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setWarning(null);
    resolve?.(proceed);
  };

  useEffect(
    () => () => {
      resolver.current?.(false);
      resolver.current = null;
    },
    []
  );

  async function check(
    path: string,
    body: unknown,
    role: CodexContentWarningRole
  ): Promise<boolean> {
    if (resolver.current || checking.current) return false;
    checking.current = true;
    let result: CodexContentPreflightResult;
    try {
      result = await api<CodexContentPreflightResult>(path, body);
    } catch {
      // This is an advisory preflight. Let the real request surface its own connection/error state.
      return true;
    } finally {
      checking.current = false;
    }
    if (!result.warning) return true;
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setWarning(role);
    });
  }

  return {
    warning,
    check,
    continueRequest: () => settle(true),
    cancelRequest: () => settle(false),
  };
}
