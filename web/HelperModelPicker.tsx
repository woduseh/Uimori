import { useRef, useState } from 'react';
import type { Library, ModelWorkspace } from '../core/product.js';
import { promptEndpoints } from '#contracts';
import { callEndpoint } from './api.js';
import { ChatModelPicker } from './ChatModelPicker.js';
import { NoticeBanner } from './NoticeBanner.js';
import { TransientNotice } from './TransientNotice.js';
import { message, t, useI18n } from './i18n.js';
import { uiMessage, legacyUiMessage } from './ui-message.js';
import { usePromptWorkspace } from './usePromptWorkspace.js';
import { useRetryableEffect } from './useRetryableEffect.js';
import { errorDescriptor } from './api-errors.js';

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
  const retryRead = useRetryableEffect(() => {
    if (!open) return;
    const owner = ++epoch.current;
    const controller = new AbortController();
    setNeedsRead(true);
    setReadError('');
    setWriteError('');
    setReading(true);
    void callEndpoint(promptEndpoints.readModelWorkspace, {}, controller.signal)
      .then((read) => {
        const value = read as ModelWorkspace;
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
  }, [open]);
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
      const value = (await callEndpoint(promptEndpoints.updateModelWorkspace, {
        expectedRevision: current.revision,
        routes: current.routes,
        translationPolicy: current.translationPolicy,
        helperModel: modelId ? { id: modelId } : null,
      })) as ModelWorkspace;
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
        setWriteError(errorDescriptor(cause));
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
        error={legacyUiMessage(writeError || readError)}
        errorLabel={writeError ? uiMessage('helpers.modelCheckAgain') : undefined}
        onRetry={() => {
          retryRead();
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
          {shared.error && uiMessage('helpers.modelRefreshFailed', { error: shared.error })}
        </NoticeBanner>
      )}
      <TransientNotice content={legacyUiMessage(notice)} />
    </>
  );
}
