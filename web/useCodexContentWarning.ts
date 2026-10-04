import { useEffect, useRef, useState } from 'react';
import type {
  CodexContentPreflightResult,
  CodexContentWarningRole,
} from '../core/codex-content-warning.js';
import { api } from './api.js';

export type CodexContentWarningGate = ReturnType<typeof useCodexContentWarning>;
type Pending = { controller: AbortController; resolve: (proceed: boolean) => void };

export function useCodexContentWarning() {
  const [warning, setWarning] = useState<CodexContentWarningRole | null>(null);
  const pending = useRef<Pending | null>(null);

  const settle = (proceed: boolean) => {
    const request = pending.current;
    if (!request) return;
    pending.current = null;
    request.controller.abort();
    setWarning(null);
    request.resolve(proceed);
  };

  useEffect(
    () => () => {
      const request = pending.current;
      pending.current = null;
      request?.controller.abort();
      request?.resolve(false);
    },
    []
  );

  function check(
    path: string,
    body: unknown,
    role: CodexContentWarningRole,
    signal?: AbortSignal
  ): Promise<boolean> {
    if (pending.current || signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const controller = new AbortController();
      const onAbort = () => {
        if (pending.current === request) settle(false);
      };
      const request: Pending = {
        controller,
        resolve: (proceed) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(proceed);
        },
      };
      pending.current = request;
      signal?.addEventListener('abort', onAbort, { once: true });
      void api<CodexContentPreflightResult>(path, body, 'POST', controller.signal).then(
        (result) => {
          if (pending.current !== request) return;
          if (result.warning) setWarning(role);
          else settle(true);
        },
        () => {
          // A cancelled or older request cannot settle a newer warning. Other failures
          // stay advisory: the real request surfaces its own connection/error state.
          if (pending.current === request) settle(!controller.signal.aborted);
        }
      );
    });
  }

  return {
    warning,
    check,
    continueRequest: () => settle(true),
    cancelRequest: () => settle(false),
  };
}
