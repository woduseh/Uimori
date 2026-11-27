import { useLayoutEffect, useRef, useState } from 'react';
import { readerEndpoints, type SelectionRevisionInput } from '#contracts';
import type { RevisionContext } from '../core/selection-revision.js';
import { callEndpoint } from './api.js';
import { toUiMessage } from './api-errors.js';
import type { UiMessage } from './ui-message.js';
import { readOptionalStorage, writeOptionalStorage } from './optional-storage.js';
import { useCodexContentWarning } from './useCodexContentWarning.js';
import { storageKeys } from './storage-keys.js';

const CONTEXT_KEY = storageKeys.selectionRevisionContext;
const storedContext = (): RevisionContext =>
  readOptionalStorage('local', CONTEXT_KEY) === 'nearby' ? 'nearby' : 'scene';

type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type SelectionRevisionTarget = Without<
  SelectionRevisionInput,
  'sourceId' | 'instruction' | 'context'
>;
export type SelectionRevisionRequest = Without<SelectionRevisionTarget, 'draft' | 'start' | 'end'>;
type Captured = { request: SelectionRevisionTarget; identity: string };

export function useSelectionRevision({
  chatId,
  sourceId,
  identity,
}: {
  chatId: string;
  sourceId: string;
  identity: string | null;
}) {
  const latest = useRef(identity);
  latest.current = identity;
  const [captured, setCaptured] = useState<Captured | null>(null);
  const [proposal, setProposal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiMessage | null>(null);
  const [context, setContext] = useState(storedContext);
  const pending = useRef<AbortController | null>(null);
  const codexWarning = useCodexContentWarning();
  useLayoutEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    []
  );
  const current = (value: Captured) => latest.current !== null && latest.current === value.identity;
  function cancel() {
    pending.current?.abort();
    pending.current = null;
    codexWarning.cancelRequest();
    setBusy(false);
  }
  function close() {
    cancel();
    setCaptured(null);
    setProposal(null);
    setError(null);
  }
  function open(request: SelectionRevisionTarget) {
    if (identity === null) return;
    cancel();
    setCaptured({ request, identity });
    setProposal(null);
    setError(null);
    setContext(storedContext());
  }
  function chooseContext(value: RevisionContext) {
    writeOptionalStorage('local', CONTEXT_KEY, value);
    setContext(value);
  }
  async function requestProposal(instruction: string) {
    if (!captured || !current(captured) || pending.current || !instruction.trim()) return;
    const { request } = captured;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    setProposal(null);
    try {
      const proceed = await codexWarning.check(
        (signal) =>
          callEndpoint(
            readerEndpoints.preflightChatContent,
            {
              chatId,
              role: 'selection-revision',
              text: instruction,
              selection: request.draft.slice(request.start, request.end),
            },
            signal
          ),
        'selection-revision',
        controller.signal
      );
      if (
        !proceed ||
        pending.current !== controller ||
        controller.signal.aborted ||
        !current(captured)
      )
        return;
      const result = await callEndpoint(
        readerEndpoints.reviseSelection,
        { ...request, sourceId, instruction, ...(context === 'nearby' ? { context } : {}) },
        controller.signal
      );
      if (pending.current === controller && !controller.signal.aborted) setProposal(result.text);
    } catch (cause) {
      if (pending.current === controller && !controller.signal.aborted)
        setError(toUiMessage(cause, 'reader.couldNotGetARevisionSuggestion'));
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return {
    captured: captured?.request ?? null,
    stale: captured !== null && !current(captured),
    isCurrent: () => captured !== null && current(captured),
    proposal,
    clearProposal: () => setProposal(null),
    busy,
    context,
    chooseContext,
    error,
    setError,
    open,
    close,
    cancel,
    requestProposal,
    codexWarning,
  };
}
