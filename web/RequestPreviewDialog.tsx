import { t, useI18n, translateMessage, formatNumber, message as uiMessage } from './i18n.js';
import { useEffect, useRef, useState } from 'react';
import type { RequestPreview } from '../core/request-preview.js';
import type { RequestImagePreview } from '../core/request-images.js';
import { api, libraryChangedKey } from './api.js';
import { Dialog } from './Dialog.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import './request-preview.css';

const amount = (value: number | null) =>
  value === null ? t('reader.unknown') : formatNumber(value);
const entries = (value: number | null) =>
  value === null ? t('reader.unknown') : t('reader.valueEntries', { v0: amount(value) });
const noImages: readonly RequestImagePreview[] = [];

export function RequestPreviewDialog({
  open,
  chatId,
  request,
  requestImages = noImages,
  loreContextReset,
  refreshKey,
  unavailable,
  onClose,
}: {
  open: boolean;
  chatId: string;
  request: string;
  requestImages?: readonly RequestImagePreview[];
  loreContextReset: boolean;
  refreshKey: string;
  unavailable: boolean;
  onClose: () => void;
}) {
  useI18n();
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{ key: string; value: RequestPreview } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const sequence = useRef(0);
  const imageKey = JSON.stringify(requestImages);
  const key = JSON.stringify([
    chatId,
    request,
    imageKey,
    loreContextReset,
    refreshKey,
    refresh,
    open,
    unavailable,
  ]);
  const preview = result?.key === key ? result.value : null;
  const error = failure?.key === key ? failure.message : '';
  const hasInput = !!request.trim() || requestImages.length > 0;
  const ready = open && hasInput && !unavailable;

  useEffect(() => {
    if (!open) return;
    const changed = () => setRefresh((value) => value + 1);
    const storage = (event: StorageEvent) => {
      if (event.key === libraryChangedKey) changed();
    };
    addEventListener('prompt-workspace-changed', changed);
    addEventListener('uimori-helper-updated', changed);
    addEventListener('uimori-resource-saved', changed);
    addEventListener('focus', changed);
    addEventListener('storage', storage);
    return () => {
      removeEventListener('prompt-workspace-changed', changed);
      removeEventListener('uimori-helper-updated', changed);
      removeEventListener('uimori-resource-saved', changed);
      removeEventListener('focus', changed);
      removeEventListener('storage', storage);
    };
  }, [open]);

  useEffect(() => {
    const version = ++sequence.current;
    if (!ready) {
      setResult(null);
      setFailure(null);
      return;
    }
    const controller = new AbortController();
    void api<RequestPreview>(
      `/chats/${encodeURIComponent(chatId)}/request-preview`,
      {
        request,
        ...(imageKey !== '[]' ? { requestImages: JSON.parse(imageKey) } : {}),
        ...(loreContextReset ? { loreContextReset: true } : {}),
      },
      'POST',
      controller.signal
    )
      .then((value) => {
        if (!controller.signal.aborted && sequence.current === version) setResult({ key, value });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted && sequence.current === version)
          setFailure({
            key,
            message:
              cause instanceof Error ? cause.message : uiMessage('reader.couldNotLoadThePreview'),
          });
      });
    return () => {
      controller.abort();
      sequence.current++;
    };
  }, [ready, key, chatId, request, imageKey, loreContextReset]);

  const tokens = preview?.tokens;
  const percent =
    tokens?.estimatedInputTokens !== null &&
    tokens?.estimatedInputTokens !== undefined &&
    tokens.inputTokenLimit
      ? (tokens.estimatedInputTokens / tokens.inputTokenLimit) * 100
      : null;

  return (
    <Dialog
      open={open}
      title={t('reader.nextRequestPreview')}
      headerTitle={t('reader.nextRequestPreview')}
      className="request-preview-dialog"
      scopeKey={chatId}
      onClose={onClose}
    >
      {!hasInput ? (
        <p>{t('reader.enterASceneRequestToReviewSettingsAndContext')}</p>
      ) : unavailable ? (
        <NoticeBanner>{t('reader.finishTheCurrentTaskBeforeCheckingThePreviewAgain')}</NoticeBanner>
      ) : (
        <>
          {(error || preview?.error || preview?.snapshot.stale) && (
            <div className="request-preview-heading">
              <button
                type="button"
                className="secondary"
                onClick={() => setRefresh((value) => value + 1)}
              >
                {t('reader.checkAgain')}
              </button>
            </div>
          )}
          {error ? (
            <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>
          ) : !preview ? (
            <LoadingState presentation="placeholder" label={t('reader.checkingTheNextRequest')} />
          ) : preview.snapshot.stale ? (
            <NoticeBanner>
              {t('reader.contextOrSettingsChangedDuringTheCheckCheckAgain')}
            </NoticeBanner>
          ) : (
            <div data-testid="request-preview">
              {preview.error && (
                <NoticeBanner>
                  {preview.error === 'MAIN_MODEL_REQUIRED'
                    ? t('reader.selectATextModelToCalculateInputSize')
                    : t('reader.couldNotCalculateInputSizeUnderTheCurrentConditions')}
                </NoticeBanner>
              )}
              <dl className="request-preview-facts">
                <div>
                  <dt>{t('reader.textModel')}</dt>
                  <dd>{preview.selected.model?.title ?? t('reader.notSelected')}</dd>
                </div>
                <div>
                  <dt>{t('reader.prompt')}</dt>
                  <dd>{preview.selected.prompt?.title ?? t('reader.defaultPrompt')}</dd>
                </div>
                <div>
                  <dt>{t('reader.persona')}</dt>
                  <dd>{preview.selected.persona?.title ?? t('reader.none')}</dd>
                </div>
                <div>
                  <dt>{t('reader.lorePreparation')}</dt>
                  <dd>
                    {t('reader.lorePreparationCounts', {
                      pinned: entries(preview.lore.pinnedEntries),
                      retained: entries(preview.lore.retainedEntries),
                    })}
                    {preview.lore.selectionPending && (
                      <small>{t('reader.additionalLoreSelectionPending')}</small>
                    )}
                    {preview.lore.resetRequested && (
                      <small>{t('reader.retrievedLoreExcludedFromThisRequest')}</small>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t('reader.contextSummary')}</dt>
                  <dd>
                    {preview.summary.inUse
                      ? t('reader.usingValueSceneSummaries', {
                          v0: amount(preview.summary.compactedSources),
                        })
                      : preview.summary.inUse === null
                        ? t('reader.inclusionUnknown')
                        : t('reader.summaryNotUsed')}
                    {preview.caveats.includes('SUMMARY_NOT_REUSABLE') && (
                      <small>{t('reader.thePreviousSummaryCannotBeUsedForThisRequest')}</small>
                    )}
                    {preview.caveats.includes('SUMMARY_INCLUSION_UNVERIFIED') && (
                      <small>{t('reader.aSummaryExistsButItsInclusionInTheCurrent')}</small>
                    )}
                  </dd>
                </div>
              </dl>
              <div className="request-preview-budget">
                <p>
                  {tokens?.estimatedInputTokens == null
                    ? t('reader.inputSizeUnknown')
                    : t('reader.estimatedInputValueValueTokens', {
                        v0: amount(tokens.estimatedInputTokens),
                        v1: amount(tokens.inputTokenLimit),
                      })}
                  {percent !== null && ` (${formatNumber(percent, { maximumFractionDigits: 1 })}%)`}
                </p>
                {percent !== null && tokens?.inputTokenLimit && (
                  <meter
                    aria-label={t('reader.estimatedContextRelativeToTheNextRequestsInputLimit')}
                    min={0}
                    max={tokens.inputTokenLimit}
                    value={Math.min(tokens.estimatedInputTokens!, tokens.inputTokenLimit)}
                  />
                )}
                {!!tokens?.imageCount && (
                  <small className="muted">
                    {t('reader.imageTokenEstimate', {
                      count: tokens.imageCount,
                      tokens: amount(tokens.estimatedImageTokens ?? null),
                    })}
                  </small>
                )}
                {preview.summary.compactionPending && (
                  <p role="status">{t('reader.contextCleanupIsNeededSoTheActualInputSize')}</p>
                )}
                {tokens?.tokenizerInfo?.fallback && (
                  <p role="status">{t('reader.theSelectedTokenizerCouldNotBeLoadedAGeneral2')}</p>
                )}
                {preview.caveats.includes('NATIVE_CALLBACKS_DEFERRED') && (
                  <small className="muted">
                    {t('reader.estimatedBeforeRisuScriptsModifyTheRequest')}
                  </small>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
