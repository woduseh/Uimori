import { t, useI18n, formatNumber } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { useEffect, useState } from 'react';
import type { SceneUsageDetail, SceneUsageReceipt } from '../core/scene-usage.js';
import { api } from './api.js';
import { RequestLoreEntries } from './RequestLoreEntries.js';
import './scene-usage.css';

const amount = (value: number | null) =>
  value === null ? t('reader.unknown') : formatNumber(value);

export function SceneUsage({
  usage,
  compact = false,
}: {
  usage?: SceneUsageReceipt;
  compact?: boolean;
}) {
  useI18n();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<{ id: string; value: SceneUsageDetail } | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const attemptId = usage?.attemptId;
  useEffect(() => {
    if (!open || !attemptId || detail?.id === attemptId) return;
    const controller = new AbortController();
    setFailedId(null);
    void api<SceneUsageDetail>(
      `/attempts/${encodeURIComponent(attemptId)}/scene-detail`,
      undefined,
      'GET',
      controller.signal
    ).then(
      (value) => {
        if (!controller.signal.aborted) setDetail({ id: attemptId, value });
      },
      () => {
        if (!controller.signal.aborted) setFailedId(attemptId);
      }
    );
    return () => controller.abort();
  }, [open, attemptId, detail?.id]);
  const recordedDetail = detail && detail.id === attemptId ? detail.value : null;
  const receipt = usage?.receipt;
  const context = usage?.context;
  const actualInput = usage?.inputScope !== 'turn' ? (usage?.inputTokens ?? null) : null;
  const contextTokens = actualInput ?? context?.estimatedInputTokens ?? null;
  const percent =
    context && contextTokens !== null ? (contextTokens / context.inputTokenLimit) * 100 : null;
  const totals = (
    <>
      {t('reader.tokenTotals', {
        input: amount(usage?.inputTokens ?? null),
        output: amount(usage?.outputTokens ?? null),
      })}
      {percent !== null &&
        t('reader.contextPercent', {
          estimated: actualInput === null,
          percent: formatNumber(percent, { maximumFractionDigits: 1 }),
        })}
    </>
  );
  return (
    <details
      className="scene-usage"
      data-testid="scene-usage"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {compact ? (
          t('reader.thisGeneration')
        ) : (
          <span className="ui-meta-row">
            <span>{t('reader.thisGeneration')}</span>
            <span>{totals}</span>
          </span>
        )}
      </summary>
      <div className="scene-usage-body">
        {compact && <p>{totals}</p>}
        {receipt ? (
          <dl className="scene-receipt">
            <dt>{t('reader.model')}</dt>
            <dd>
              <span>{receipt.model.title}</span>
              {receipt.model.title.trim() !== receipt.model.modelId.trim() && (
                <small className="scene-receipt-model-id">{receipt.model.modelId}</small>
              )}
            </dd>
            <dt>{t('reader.prompt')}</dt>
            <dd>{receipt.prompt?.title ?? t('reader.noSelectionRecord')}</dd>
            <dt>{t('reader.persona')}</dt>
            <dd>
              {receipt.persona
                ? (receipt.persona.name ?? receipt.persona.title ?? receipt.persona.id)
                : t('reader.noneSelected')}
            </dd>
            <dt>{t('reader.conversationSummary')}</dt>
            <dd>
              {receipt.summary
                ? receipt.summary.status === 'included'
                  ? t('reader.confirmedInclusionOfValueSummarizedScenes', {
                      v0: formatNumber(receipt.summary.coveredSources),
                    })
                  : receipt.summary.status === 'absent'
                    ? t('reader.notUsed')
                    : t('reader.inclusionInTheRequestIsUnknown')
                : t('reader.noRecord')}
            </dd>
          </dl>
        ) : usage ? (
          <p>{t('reader.noModelPromptPersonaOrSummaryRecordForThis')}</p>
        ) : null}
        {context ? (
          <>
            <p>
              {t('reader.contextInput', {
                estimated: actualInput === null,
                input: amount(contextTokens),
                limit: amount(context.inputTokenLimit),
              })}
            </p>
            <meter
              aria-label={
                actualInput === null
                  ? t('reader.estimatedInputRelativeToContextLimit')
                  : t('reader.inputRelativeToContextLimit')
              }
              min={0}
              max={context.inputTokenLimit}
              value={Math.min(contextTokens!, context.inputTokenLimit)}
            />
          </>
        ) : (
          <p>{t('reader.contextUsageCannotBeShownBecauseThisCallHas')}</p>
        )}
        {attemptId &&
          (recordedDetail ? (
            <>
              <p>
                {recordedDetail.cache
                  ? t('reader.cacheReadValueWriteValueTokens', {
                      v0: amount(recordedDetail.cache.readTokens),
                      v1: amount(recordedDetail.cache.writeTokens),
                    })
                  : t('reader.noCacheUsageRecord')}
              </p>
              <p>
                {t('reader.sentLoreRecord', {
                  record: recordedDetail.lore
                    ? recordedDetail.lore.entries.length
                      ? t('reader.valueRecords', {
                          v0: formatNumber(recordedDetail.lore.entries.length),
                        })
                      : t('reader.noRecordOfTextInclusion')
                    : t('reader.noRecord'),
                })}
              </p>
              {recordedDetail.lore?.selection && (
                <p>
                  {t('reader.loreSelectionTotals', {
                    total: amount(recordedDetail.lore.selection.total),
                    evaluated: amount(recordedDetail.lore.selection.evaluated),
                    selected: amount(recordedDetail.lore.selection.selected),
                    failed: recordedDetail.lore.selection.failed ?? 0,
                  })}
                </p>
              )}
              {!!recordedDetail.lore?.entries.length && (
                <RequestLoreEntries entries={recordedDetail.lore.entries} />
              )}
              {recordedDetail.lore?.status === 'partial' && (
                <p>{t('visualpanels.inclusionMayBeUncertainForMaterialProcessed')}</p>
              )}
            </>
          ) : open ? (
            <LoadingState
              presentation="inline"
              loading={failedId !== attemptId}
              error={failedId === attemptId ? t('reader.reopenToRetry') : ''}
              errorLabel={t('reader.couldNotLoadCacheAndLoreRecords')}
              label={t('reader.loadingCacheAndLoreRecords')}
            />
          ) : null)}
        {usage && (
          <details className="scene-usage-help">
            <summary>{t('reader.aboutUsage')}</summary>
            <p>{t('reader.seeTaskDetailsForTotalUsageAcrossCalls')}</p>
            {context && <p>{t('reader.contextUsageUsesTheInputLimitAtCallTime')}</p>}
            {usage.inputScope === 'turn' && (
              <p>{t('reader.codexUsageAccumulatesMultipleInternalCallsContextUsageUses')}</p>
            )}
            {context?.tokenizerFallback && (
              <p>{t('reader.theSelectedTokenizerCouldNotBeLoadedAGeneral')}</p>
            )}
            {recordedDetail?.cache && <p>{t('reader.cacheTokensArePartOfTheInputAndAre')}</p>}
          </details>
        )}
        {!usage && <p>{t('reader.noCallRecordUsageIsNotEstimatedForImported')}</p>}
      </div>
    </details>
  );
}
