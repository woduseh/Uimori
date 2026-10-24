import { useEffect, useRef, useState } from 'react';
import type { Library, ModelWorkspace } from '../core/product.js';
import { api } from './api.js';
import { ChatModelPicker } from './ChatModelPicker.js';
import { NoticeBanner } from './NoticeBanner.js';
import { TransientNotice } from './TransientNotice.js';
import { message, t, translateMessage, useI18n } from './i18n.js';
import { usePromptWorkspace } from './usePromptWorkspace.js';

/** A helper-role change uses its own current model revision and never edits prompt/profile pins. */
export function HelperModelPicker({
  open,
  library,
  onClose,
  onManage,
  onSaved,
}: {
  open: boolean;
  library: Library;
  onClose: () => void;
  onManage: () => void;
  onSaved: (workspace: ModelWorkspace) => void;
}) {
  useI18n();
  const shared = usePromptWorkspace();
  const [workspace, setWorkspace] = useState<ModelWorkspace | null>(null);
  const [readError, setReadError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [reading, setReading] = useState(false);
  const [needsRead, setNeedsRead] = useState(true);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [accepted, setAccepted] = useState<ModelWorkspace | null>(null);
  const [notice, setNotice] = useState('');
  const epoch = useRef(0);
  const locked = useRef(false);
  const updateLabel = useRef(onSaved);
  updateLabel.current = onSaved;
  const latestRevision = useRef(0);
  latestRevision.current = Math.max(latestRevision.current, shared.workspace?.revision ?? 0);
  const current =
    shared.workspace && shared.workspace.revision > (workspace?.revision ?? -1)
      ? {
          revision: shared.workspace.revision,
          helperModel: shared.workspace.helperModel,
          routes: shared.workspace.modelRoutes,
          translationPolicy: shared.workspace.translationPolicy,
        }
      : workspace;
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly rereads the current global model revision.
  useEffect(() => {
    if (!open) return;
    const owner = ++epoch.current;
    const controller = new AbortController();
    setNeedsRead(true);
    setReadError('');
    setWriteError('');
    setReading(true);
    void api<ModelWorkspace>('/model-workspace', undefined, 'GET', controller.signal)
      .then((value) => {
        if (epoch.current === owner) {
          setWorkspace((old) => (old && old.revision > value.revision ? old : value));
          setNeedsRead(false);
          if (value.revision >= latestRevision.current) {
            latestRevision.current = value.revision;
            updateLabel.current(value);
          }
        }
      })
      .catch((cause: Error) => {
        if (epoch.current === owner && !controller.signal.aborted) setReadError(cause.message);
      })
      .finally(() => {
        if (epoch.current === owner) setReading(false);
      });
    return () => {
      epoch.current++;
      controller.abort();
    };
  }, [open, attempt]);
  async function select(modelId: string | undefined) {
    if (!current || needsRead || reading || locked.current) return;
    if (current.helperModel?.id === modelId) {
      onClose();
      return;
    }
    const owner = epoch.current;
    locked.current = true;
    setPending(true);
    setWriteError('');
    setNotice('');
    try {
      const value = await api<ModelWorkspace>(
        '/model-workspace',
        {
          expectedRevision: current.revision,
          routes: current.routes,
          translationPolicy: current.translationPolicy,
          helperModel: modelId ? { id: modelId } : null,
        },
        'PUT'
      );
      // Acknowledgement owns success even if the following shared refresh fails.
      setAccepted((old) => (old && old.revision > value.revision ? old : value));
      if (value.revision >= latestRevision.current) {
        latestRevision.current = value.revision;
        updateLabel.current(value);
      }
      setNotice(message('helpers.modelSaved'));
      if (epoch.current === owner) {
        setWorkspace((old) => (old && old.revision > value.revision ? old : value));
        onClose();
      }
    } catch (cause) {
      if (epoch.current === owner) {
        setWriteError(cause instanceof Error ? cause.message : String(cause));
        // A rejected or uncertain write needs a fresh read before another explicit choice.
        setNeedsRead(true);
      }
    } finally {
      locked.current = false;
      setPending(false);
    }
  }
  const refreshFailed =
    accepted && shared.error && (shared.workspace?.revision ?? 0) < accepted.revision;
  return (
    <>
      <ChatModelPicker
        open={open}
        scopeKey="global-helper"
        purpose="helper"
        library={library}
        selectedModelId={current?.helperModel?.id}
        disabled={!current || needsRead}
        loading={reading}
        pending={pending}
        error={writeError || readError}
        errorLabel={writeError ? t('helpers.modelCheckAgain') : undefined}
        onRetry={() => {
          setAttempt((value) => value + 1);
          void shared.refresh();
        }}
        onSelect={(modelId) => void select(modelId)}
        onClose={onClose}
        onManage={onManage}
      />
      {refreshFailed && (
        <NoticeBanner
          tone="error"
          actions={
            <button type="button" className="secondary" onClick={() => void shared.refresh()}>
              {t('shared.reload')}
            </button>
          }
        >
          {t('helpers.modelRefreshFailed', { error: translateMessage(shared.error) })}
        </NoticeBanner>
      )}
      <TransientNotice message={notice} />
    </>
  );
}
