import { useLayoutEffect, useRef, useState } from 'react';
import type { RevisionContext, SelectionRevisionResult } from '../core/selection-revision.js';
import { api } from './api.js';
import { message as legacyDescriptor } from './i18n.js';
import { readOptionalStorage, writeOptionalStorage } from './optional-storage.js';
import { useCodexContentWarning } from './useCodexContentWarning.js';
import { storageKeys } from './storage-keys.js';

const CONTEXT_KEY = storageKeys.selectionRevisionContext;
const storedContext = (): RevisionContext =>
  readOptionalStorage('local', CONTEXT_KEY) === 'nearby' ? 'nearby' : 'scene';

export type SelectionRevisionTarget = {
  target?: 'translation';
  draft: string;
  start: number;
  end: number;
  expectedSourceHash: string;
  expectedRevision: number;
  expectedTextHash?: string;
};
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
  const [error, setError] = useState('');
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
    setError('');
  }
  function open(request: SelectionRevisionTarget) {
    if (identity === null) return;
    cancel();
    setCaptured({ request, identity });
    setProposal(null);
    setError('');
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
    setError('');
    setProposal(null);
    try {
      const proceed = await codexWarning.check(
        `/chats/${encodeURIComponent(chatId)}/codex-content-preflight`,
        {
          role: 'selection-revision',
          text: instruction,
          selection: request.draft.slice(request.start, request.end),
        },
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
      const result = await api<SelectionRevisionResult>(
        `/sources/${encodeURIComponent(sourceId)}/selection-revision`,
        { ...request, instruction, ...(context === 'nearby' ? { context } : {}) },
        'POST',
        controller.signal
      );
      if (pending.current === controller && !controller.signal.aborted) setProposal(result.text);
    } catch (cause) {
      if (pending.current === controller && !controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : legacyDescriptor('reader.couldNotGetARevisionSuggestion')
        );
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
