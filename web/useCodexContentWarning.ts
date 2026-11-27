import { useEffect, useRef, useState } from 'react';
import type {
  CodexContentPreflightResult,
  CodexContentWarningRole,
} from '../core/codex-content-warning.js';

export type CodexContentWarningGate = ReturnType<typeof useCodexContentWarning>;
export type Preflight = (signal?: AbortSignal) => Promise<CodexContentPreflightResult>;
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
    send: Preflight,
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
      void send(controller.signal).then(
        (result) => {
          if (pending.current !== request) return;
          if (result.warning) setWarning(role);
          else settle(true);
        },
        () => {
          if (pending.current === request) settle(!controller.signal.aborted);
        }
      );
    });
  }

  async function needsConfirmation(send: Preflight): Promise<boolean> {
    try {
      return (await send()).warning;
    } catch {
      return true;
    }
  }

  return {
    warning,
    check,
    needsConfirmation,
    continueRequest: () => settle(true),
    cancelRequest: () => settle(false),
  };
}
