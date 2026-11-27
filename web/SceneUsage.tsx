import { t, useI18n, formatNumber } from './i18n.js';
import { uiMessage, legacyUiMessage } from './ui-message.js';
import { LoadingState } from './LoadingState.js';
import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import {
  MAIN_CONTEXT_PARTS,
  type MainContextPart,
  type SceneUsageDetail,
  type SceneUsageReceipt,
} from '../core/scene-usage.js';
import type { ReaderRun } from '../core/types.js';
import { CONTEXT_COMPACTION_TRIGGER_RATIO } from '../core/context-compaction.js';
import {
  ContextBar,
  ContextLegend,
  ContextTable,
  type ContextSegment,
  type ContextTone,
} from './ContextBreakdown.js';
import { ContextSummaryStatus } from './ContextSummaryStatus.js';
import { RequestLoreEntries } from './RequestLoreEntries.js';
import { DropdownIcon } from './ui-icons.js';
import { useApiRecord } from './useApiRecord.js';
import './scene-usage.css';

const amount = (value: number | null) =>
  value === null ? t('reader.unknown') : formatNumber(value);

function sceneContext(usage: SceneUsageReceipt) {
  const context = usage.context;
  if (!context) return null;
  const actual = usage.inputScope !== 'turn' ? usage.inputTokens : null;
  const input = actual ?? context.estimatedInputTokens;
  return { input, limit: context.inputTokenLimit, estimated: actual === null };
}

const contextParts: Record<MainContextPart, { label: () => string; tone: ContextTone }> = {
  prompt: { label: () => t('reader.prompt'), tone: 'instructions' },
  botDescription: { label: () => t('reader.contextBotDescription'), tone: 'description' },
  persona: { label: () => t('reader.persona'), tone: 'persona' },
  lore: { label: () => t('reader.lore'), tone: 'reference' },
  authorNote: { label: () => t('reader.contextAuthorNote'), tone: 'note' },
  storyGuide: { label: () => t('reader.contextStoryGuide'), tone: 'guide' },
  summary: { label: () => t('reader.conversationSummary'), tone: 'summary' },
  history: { label: () => t('reader.contextHistory'), tone: 'history' },
  request: { label: () => t('reader.contextRequest'), tone: 'request' },
  appInstructions: { label: () => t('reader.contextAppInstructions'), tone: 'app' },
  tools: { label: () => t('helperUsage.toolSchemas'), tone: 'tools' },
  toolResults: { label: () => t('helperUsage.toolResults'), tone: 'results' },
  other: { label: () => t('contextBreakdown.other'), tone: 'other' },
};

export function sceneContextSegments(usage: SceneUsageReceipt): ContextSegment[] {
  const parts = usage.context?.parts;
  if (!parts) return [];
  return MAIN_CONTEXT_PARTS.flatMap((key) => {
    const tokens = parts[key];
    return typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0
      ? [{ key, label: contextParts[key].label(), tokens, tone: contextParts[key].tone }]
      : [];
  });
}

function SceneContextBar({ usage }: { usage: SceneUsageReceipt }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const context = sceneContext(usage);
  if (!context) return null;
  const share = context.input / context.limit;
  const segments = sceneContextSegments(usage);
  const threshold = Math.floor(context.limit * CONTEXT_COMPACTION_TRIGGER_RATIO);
  const estimate = usage.context!.estimatedInputTokens;
  return (
    <div className="scene-context">
      <p>
        {t('reader.inspectorContext', {
          estimated: context.estimated,
          percent: formatNumber(share * 100, { maximumFractionDigits: 1 }),
          input: formatNumber(context.input),
          limit: formatNumber(context.limit),
        })}
      </p>
      {segments.length ? (
        <>
          <ContextBar
            segments={segments}
            total={context.input}
            limit={context.limit}
            threshold={threshold}
          />
          <div className="context-breakdown-summary">
            <ContextLegend segments={segments} />
            <button
              type="button"
              className="scene-receipt-expand"
              aria-expanded={open}
              aria-controls={`${id}-parts`}
              onClick={() => setOpen(!open)}
            >
              <DropdownIcon size={14} aria-hidden="true" />
              {t(open ? 'contextBreakdown.hide' : 'contextBreakdown.show')}
            </button>
          </div>
          {open && (
            <div id={`${id}-parts`}>
              <ContextTable
                label={t('reader.contextTable')}
                rows={segments}
                total={estimate}
                limit={context.limit}
                threshold={threshold}
                notes={
                  context.estimated
                    ? []
                    : [
                        {
                          key: 'reported',
                          label: t('reader.contextReported'),
                          value: formatNumber(context.input),
                        },
                      ]
                }
              />
            </div>
          )}
        </>
      ) : (
        <div
          className="scene-context-bar"
          data-level={
            share >= 1 ? 'over' : share >= CONTEXT_COMPACTION_TRIGGER_RATIO ? 'near' : undefined
          }
          title={t('reader.contextCompactionMark')}
          aria-hidden="true"
          style={
            {
              '--usage-share': Math.min(share, 1),
              '--usage-threshold': CONTEXT_COMPACTION_TRIGGER_RATIO,
            } as CSSProperties
          }
        >
          <span />
        </div>
      )}
      {usage.context?.tokenizerFallback && (
        <p role="status">{t('reader.theSelectedTokenizerCouldNotBeLoadedAGeneral')}</p>
      )}
    </div>
  );
}

function SceneCache({
  cache,
  inputTokens,
}: {
  cache: NonNullable<SceneUsageDetail['cache']>;
  inputTokens: number | null;
}) {
  const read = cache.readTokens;
  const write = cache.writeTokens;
  return (
    <span className="scene-receipt-pair">
      {read !== null && (
        <span>
          {inputTokens
            ? t('reader.inspectorCacheReadShare', {
                read: formatNumber(read),
                share: formatNumber(read / inputTokens, {
                  style: 'percent',
                  maximumFractionDigits: 0,
                }),
              })
            : t('reader.inspectorCacheRead', { read: formatNumber(read) })}
        </span>
      )}
      {write !== null && (
        <span>{t('reader.inspectorCacheWrite', { write: formatNumber(write) })}</span>
      )}
    </span>
  );
}

function summaryText(summary: NonNullable<NonNullable<SceneUsageReceipt['receipt']>['summary']>) {
  if (summary.status === 'included')
    return t('reader.confirmedInclusionOfValueSummarizedScenes', { v0: summary.coveredSources });
  return summary.status === 'absent'
    ? t('reader.notUsed')
    : t('reader.inclusionInTheRequestIsUnknown');
}

function useSceneUsageDetail(attemptId: string | undefined) {
  const record = useApiRecord<SceneUsageDetail>(
    `/attempts/${encodeURIComponent(attemptId ?? '')}/scene-detail`,
    0,
    !!attemptId
  );
  return attemptId ? record : null;
}

export function SceneReceipt({
  usage,
  contextSummary,
  model = false,
  loreDetails,
  onLoreToggle,
}: {
  usage?: SceneUsageReceipt;
  contextSummary?: ReaderRun['contextSummary'];
  model?: boolean;
  loreDetails?: ReactNode;
  onLoreToggle?: (open: boolean) => void;
}) {
  useI18n();
  const id = useId();
  const [loreOpen, setLoreOpen] = useState(false);
  const detail = useSceneUsageDetail(usage?.attemptId);
  const receipt = usage?.receipt;
  const lore = detail?.value?.lore;
  const cache = detail?.value?.cache;
  const summary =
    contextSummary?.status === 'ready' ? (
      <ContextSummaryStatus summary={contextSummary} />
    ) : receipt?.summary ? (
      summaryText(receipt.summary)
    ) : null;
  const rows: { key: string; label: string; value: ReactNode }[] = [
    ...(model && receipt
      ? [
          {
            key: 'model',
            label: t('reader.model'),
            value: (
              <>
                <span>{receipt.model.title}</span>
                {receipt.model.title.trim() !== receipt.model.modelId.trim() && (
                  <small className="scene-receipt-model-id">{receipt.model.modelId}</small>
                )}
              </>
            ),
          },
        ]
      : []),
    ...(receipt?.prompt
      ? [{ key: 'prompt', label: t('reader.prompt'), value: receipt.prompt.title }]
      : []),
    ...(receipt
      ? [
          {
            key: 'persona',
            label: t('reader.persona'),
            value: receipt.persona
              ? (receipt.persona.name ?? receipt.persona.title ?? receipt.persona.id)
              : t('reader.noneSelected'),
          },
        ]
      : []),
    ...(summary
      ? [{ key: 'summary', label: t('reader.conversationSummary'), value: summary }]
      : []),
    ...(cache && (cache.readTokens !== null || cache.writeTokens !== null)
      ? [
          {
            key: 'cache',
            label: t('reader.cache'),
            value: <SceneCache cache={cache} inputTokens={usage?.inputTokens ?? null} />,
          },
        ]
      : []),
    ...(lore
      ? [
          {
            key: 'lore',
            label: t('reader.lore'),
            value: (
              <>
                <span className="scene-receipt-lore-line">
                  <span>
                    {lore.entries.length
                      ? t('reader.loreIncluded', { count: lore.entries.length })
                      : t('reader.loreNone')}
                  </span>
                  {lore.selection && (
                    <small>
                      {t('reader.loreSelectionTotals', {
                        total: amount(lore.selection.total),
                        evaluated: amount(lore.selection.evaluated),
                        selected: amount(lore.selection.selected),
                        failed: lore.selection.failed ?? 0,
                      })}
                    </small>
                  )}
                  {(lore.entries.length > 0 || loreDetails !== undefined) && (
                    <button
                      type="button"
                      className="scene-receipt-expand"
                      aria-expanded={loreOpen}
                      aria-controls={`${id}-lore`}
                      onClick={() => {
                        setLoreOpen(!loreOpen);
                        onLoreToggle?.(!loreOpen);
                      }}
                    >
                      <DropdownIcon size={14} aria-hidden="true" />
                      {loreOpen ? t('reader.loreHideEntries') : t('reader.loreShowEntries')}
                    </button>
                  )}
                </span>
              </>
            ),
          },
        ]
      : []),
  ];
  return (
    <div className="scene-receipt-body" data-testid="scene-receipt">
      {usage && <SceneContextBar usage={usage} />}
      {rows.length > 0 && (
        <dl className="scene-receipt">
          {rows.map((row) => (
            <div key={row.key} data-row={row.key}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {detail && !detail.value && (
        <div className="scene-receipt-pending">
          <LoadingState
            presentation="inline"
            loading={!detail.error}
            error={legacyUiMessage(detail.error)}
            errorLabel={uiMessage('reader.couldNotLoadCacheAndLoreRecords')}
            label={uiMessage('reader.loadingCacheAndLoreRecords')}
            onRetry={detail.retry}
          />
        </div>
      )}
      {lore && loreOpen && (
        <div id={`${id}-lore`} className="scene-receipt-lore-detail">
          {lore.entries.length > 0 && <RequestLoreEntries entries={lore.entries} />}
          {lore.status === 'partial' && (
            <p>{t('visualpanels.inclusionMayBeUncertainForMaterialProcessed')}</p>
          )}
          {loreDetails}
        </div>
      )}
    </div>
  );
}
