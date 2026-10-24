import { t, useI18n, translateMessage, formatNumber, formatDate } from './i18n.js';
import { LazyDiagnostics } from './LazyDiagnostics.js';
import { useState } from 'react';
import type { Attempt } from '../core/product.js';
import type { Run } from '../core/types.js';
import type { RequestLore } from '../core/request-lore.js';
import { providerCacheUsage } from '../core/provider-cache-usage.js';
import { formatUsd, pricingRateLabels, pricingNote } from './pricing-display.js';
import './model-pricing.css';
import './lore-context.css';

const roleLabels: Record<string, string> = {
  main: '원문',
  translation: '번역',
  status: '이전 보조 작업',
  image: '이미지 배치',
  script: '카드 스크립트',
  context: '컨텍스트 압축',
  helper: '도우미',
  title: '채팅 제목',
  illustration: '삽화',
};
type AttemptSummary = Omit<Attempt, 'request' | 'response' | 'rawUsage'>;
const tokens = (value: number | null) =>
  value === null ? t('visualpanels.unknown') : t('visualpanels.vPluralOneOther', { v0: value });
function AttemptRaw({ attempt }: { attempt: Attempt }) {
  useI18n();
  const [open, setOpen] = useState(false);
  return (
    <details className="attempt-raw" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t('visualpanels.viewRawRequestAndResponse')}</summary>
      {open && (
        <pre>
          {JSON.stringify(
            {
              id: attempt.id,
              role: attempt.role,
              request: attempt.request,
              response: attempt.response,
              usage: {
                inputTokens: attempt.inputTokens,
                outputTokens: attempt.outputTokens,
                costUsd: attempt.costUsd,
                raw: attempt.rawUsage,
              },
              error: attempt.error,
            },
            null,
            2
          )}
        </pre>
      )}
    </details>
  );
}
const total = (attempts: AttemptSummary[], field: 'inputTokens' | 'outputTokens' | 'costUsd') =>
  attempts.length === 0 || attempts.some((attempt) => attempt[field] === null)
    ? null
    : attempts.reduce((sum, attempt) => sum + (attempt[field] ?? 0), 0);

function estimatedTotal(attempts: AttemptSummary[]): string {
  if (!attempts.length) return t('visualpanels.unknown');
  const complete = attempts.every(
    (attempt) => attempt.estimatedCost?.status === 'estimated' && attempt.estimatedCost.usd !== null
  );
  if (complete)
    return formatUsd(attempts.reduce((sum, attempt) => sum + attempt.estimatedCost!.usd!, 0));
  const known = attempts.filter((attempt) =>
    attempt.estimatedCost?.lines.some((line) => line.usd !== null)
  );
  if (!known.length) return t('visualpanels.unknown');
  const subtotal = known.reduce((sum, attempt) => sum + attempt.estimatedCost!.subtotalUsd, 0);
  const incomplete = attempts.filter(
    (attempt) => attempt.estimatedCost?.status !== 'estimated' || attempt.estimatedCost.usd === null
  ).length;
  return t('visualpanels.knownSubtotalIncludesUnknownItemsInCalls', {
    v0: formatUsd(subtotal),
    v1: incomplete,
  });
}

function AttemptPricing({ attempt }: { attempt: Attempt }) {
  useI18n();
  const estimate = attempt.estimatedCost;
  return (
    <section className="attempt-pricing" aria-label={t('visualpanels.estimatedCallCost')}>
      <p>{t('visualpanels.providerReportedCost', { v0: formatUsd(attempt.costUsd) })}</p>
      <p>
        <strong>{t('visualpanels.estimatedCost', { v0: estimatedTotal([attempt]) })}</strong>
      </p>
      <p className="muted">{t('visualpanels.calculatedFromProviderReportedTokensAndThe')}</p>
      {attempt.pricingSnapshot ? (
        <>
          <p>
            {t('visualpanels.fixedServiceTierPriceChecked', {
              v0: attempt.pricingSnapshot.serviceTier,
              v1: formatDate(new Date(attempt.pricingSnapshot.checkedAt), { timeZone: 'UTC' }),
            })}
          </p>
          <p className="ui-meta-row">
            <span>
              {attempt.pricingSnapshot.source === 'manual'
                ? t('visualpanels.manuallyEnteredPrice')
                : attempt.pricingSnapshot.source === 'catalog'
                  ? t('visualpanels.providerCatalogPrice')
                  : t('visualpanels.officialPrice')}
            </span>
            {attempt.pricingSnapshot.sourceUrl && (
              <>
                <a href={attempt.pricingSnapshot.sourceUrl} target="_blank" rel="noreferrer">
                  {t('visualpanels.priceSource')}
                </a>
              </>
            )}
          </p>
          {attempt.pricingSnapshot.notes.length > 0 && (
            <ul className="model-pricing-notes">
              {attempt.pricingSnapshot.notes.map((note, index) => (
                <li key={`${index}:${note}`}>{pricingNote(note)}</li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="muted">{t('visualpanels.noPriceWasFixedForThisCall')}</p>
      )}
      {attempt.pricingStartedAt && (
        <small>
          {t('visualpanels.callReferenceTime', {
            v0: formatDate(new Date(attempt.pricingStartedAt), {
              dateStyle: 'medium',
              timeStyle: 'short',
            }),
          })}
        </small>
      )}
      {estimate && (
        <>
          <div className="table-scroll">
            <table aria-label={t('visualpanels.callCostEstimateBreakdown')}>
              <thead>
                <tr>
                  <th>{t('visualpanels.item')}</th>
                  <th>{t('visualpanels.providerTokens')}</th>
                  <th>{t('visualpanels.usdMillionTokens')}</th>
                  <th>{t('visualpanels.estimatedCost2')}</th>
                </tr>
              </thead>
              <tbody>
                {estimate.lines.map((line) => (
                  <tr key={line.kind}>
                    <th>{translateMessage(pricingRateLabels[line.kind])}</th>
                    <td>
                      {line.tokens === null ? t('visualpanels.unknown') : formatNumber(line.tokens)}
                    </td>
                    <td>{formatUsd(line.rate)}</td>
                    <td>{formatUsd(line.usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {estimate.notes.length > 0 && (
            <ul className="model-pricing-notes">
              {estimate.notes.map((note, index) => (
                <li key={`${index}:${note}`}>{pricingNote(note)}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function CacheUsage({ attempt }: { attempt: Attempt }) {
  useI18n();
  const request = attempt.request as { protocol?: unknown } | null;
  const usage = providerCacheUsage(request?.protocol, attempt.rawUsage);
  if (!usage) return null;
  return (
    <p className="muted">
      {t('visualpanels.cacheTokens', {
        read:
          usage.readTokens === null ? t('visualpanels.unknown') : formatNumber(usage.readTokens),
        write:
          usage.writeTokens === null ? t('visualpanels.unknown') : formatNumber(usage.writeTokens),
      })}
      {usage.write5mTokens !== undefined && (
        <span>
          {' '}
          {t('visualpanels.cacheWrites', {
            short:
              usage.write5mTokens === null
                ? t('visualpanels.unknown')
                : formatNumber(usage.write5mTokens),
            long:
              usage.write1hTokens == null
                ? t('visualpanels.unknown')
                : formatNumber(usage.write1hTokens),
          })}
        </span>
      )}
      <small>{t('visualpanels.cacheReuseIsConfirmedByProviderReported')}</small>
    </p>
  );
}

const loreVia = {
  pinned: '고정 자료',
  selected: '자동 선택',
  retained: '이전 요청 포함',
  'tool-result': '도구 조회',
};
const loreDelivery = {
  excerpt: '읽은 구간',
  summary: '요약만',
  unverified: '포함 여부 미확인',
};
export function RequestLoreView({ lore }: { lore?: RequestLore | null }) {
  useI18n();
  const confirmed = lore?.entries.filter((entry) => entry.delivery !== 'unverified') ?? [];
  const uncertain = lore?.entries.filter((entry) => entry.delivery === 'unverified') ?? [];
  const entries = (items: RequestLore['entries']) => (
    <ul className="lore-context-entries">
      {items.map((entry, index) => (
        <li key={`${entry.id}:${entry.via}:${index}`}>
          <strong>{entry.title || entry.id}</strong>
          <span className="ui-meta-row">
            <span>{translateMessage(loreVia[entry.via])}</span>
            {entry.delivery !== 'full' && (
              <span>{translateMessage(loreDelivery[entry.delivery])}</span>
            )}
          </span>
          {entry.source && (
            <small>
              {t('visualpanels.source', { v0: entry.source.sourceName || entry.source.contentId })}
            </small>
          )}
          <small>{entry.id}</small>
        </li>
      ))}
    </ul>
  );
  return (
    <section
      className="lore-context-result attempt-lore"
      aria-label={t('visualpanels.loreIncludedInRequest')}
    >
      <h4>{t('visualpanels.includedLore', { count: confirmed.length })}</h4>
      {!lore ? (
        <p className="muted">{t('visualpanels.thereIsNoLoreInclusionRecordFor')}</p>
      ) : (
        <>
          {confirmed.length ? (
            <details open={confirmed.length <= 6}>
              <summary>
                {t('visualpanels.loreListVPluralOneOther', { v0: confirmed.length })}
              </summary>
              {entries(confirmed)}
            </details>
          ) : (
            <p className="muted">
              {lore.status === 'complete'
                ? t('visualpanels.noAdditionalLoreWasAttachedToThis')
                : t('visualpanels.noLoreInclusionHasBeenConfirmed')}
            </p>
          )}
          {lore.status === 'partial' && (
            <p className="muted">{t('visualpanels.inclusionMayBeUncertainForMaterialProcessed')}</p>
          )}
          {uncertain.length > 0 && (
            <details>
              <summary>
                {t('visualpanels.inclusionUnconfirmedVPluralOneOther', { v0: uncertain.length })}
              </summary>
              {entries(uncertain)}
            </details>
          )}
          <small className="muted">{t('visualpanels.basedOnMaterialsAttachedByTheApp')}</small>
        </>
      )}
    </section>
  );
}

export function AttemptInspector({
  chatId,
  revision,
  runs,
}: {
  chatId: string;
  revision: number;
  runs: Pick<Run, 'status'>[];
}) {
  useI18n();
  return (
    <div className="usage-inspector" data-testid="usage-inspector">
      <LazyDiagnostics<AttemptSummary[]>
        path={`/chats/${chatId}/attempts`}
        revision={revision}
        title={
          <>
            {t('visualpanels.callsAndCostsAcrossAllRoles')}{' '}
            <small>{t('visualpanels.includesCandidatesAuxiliaryTasksAndRetries')}</small>
          </>
        }
      >
        {(attempts) => <AttemptTable attempts={attempts} runs={runs} revision={revision} />}
      </LazyDiagnostics>
    </div>
  );
}

function AttemptTable({
  attempts,
  runs,
  revision,
}: {
  attempts: AttemptSummary[];
  runs: Pick<Run, 'status'>[];
  revision: number;
}) {
  useI18n();
  const totals = {
    input: total(attempts, 'inputTokens'),
    output: total(attempts, 'outputTokens'),
    cost: total(attempts, 'costUsd'),
  };
  return (
    <div>
      <p>
        {t('visualpanels.sendAttemptsInputOutputTokensProviderReported', {
          v0: attempts.length,
          v1: totals.input === null ? t('visualpanels.unknown') : formatNumber(totals.input),
          v2: totals.output === null ? t('visualpanels.unknown') : formatNumber(totals.output),
          v3: totals.cost === null ? t('visualpanels.unknown') : `$${totals.cost}`,
        })}
      </p>
      <p>
        <strong>{t('visualpanels.estimatedCost', { v0: estimatedTotal(attempts) })}</strong>
      </p>
      <p className="muted">{t('visualpanels.calculatedFromTokensReportedByTheProvider')}</p>
      <p className="muted">{t('visualpanels.callsWithMissingCostOrTokenRecords')}</p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('visualpanels.role')}</th>
              <th>{t('visualpanels.sendAttempts')}</th>
              <th>{t('visualpanels.inputTokens')}</th>
              <th>{t('visualpanels.outputTokens')}</th>
              <th>{t('visualpanels.providerReportedCost2')}</th>
              <th>{t('visualpanels.estimatedCost2')}</th>
            </tr>
          </thead>
          <tbody>
            {Object.keys(roleLabels)
              .filter(
                (role) =>
                  role !== 'status' || attempts.some((attempt) => String(attempt.role) === role)
              )
              .map((role) => {
                const selected = attempts.filter((attempt) => attempt.role === role);
                const cost = total(selected, 'costUsd');
                return (
                  <tr key={role}>
                    <th>{translateMessage(roleLabels[role])}</th>
                    <td>{formatNumber(selected.length)}</td>
                    <td>
                      {total(selected, 'inputTokens') === null
                        ? t('visualpanels.unknown')
                        : formatNumber(total(selected, 'inputTokens')!)}
                    </td>
                    <td>
                      {total(selected, 'outputTokens') === null
                        ? t('visualpanels.unknown')
                        : formatNumber(total(selected, 'outputTokens')!)}
                    </td>
                    <td>{cost === null ? t('visualpanels.unknown') : `$${cost}`}</td>
                    <td>{estimatedTotal(selected)}</td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      <p className="muted">
        {t('visualpanels.retainedGenerationsCompletedRefusedPartial', {
          v0: runs.length,
          v1: runs.filter((run) => run.status === 'completed').length,
          v2: runs.filter((run) => run.status === 'refused').length,
          v3: runs.filter((run) => run.status === 'partial').length,
        })}
      </p>
      {attempts.map((summary) => (
        <LazyDiagnostics<Attempt>
          key={summary.id}
          path={`/attempts/${summary.id}`}
          revision={revision}
          title={
            <>
              <span className="ui-meta-row">
                <span>{translateMessage(roleLabels[summary.role])}</span>
                <span>{summary.modelId}</span>
                <span>{summary.status}</span>
              </span>
              <small className="attempt-token-summary">
                {t('visualpanels.inputOutput', {
                  v0: tokens(summary.inputTokens),
                  v1: tokens(summary.outputTokens),
                })}
              </small>
            </>
          }
        >
          {(attempt) => (
            <>
              <dl
                className="model-pricing-rates attempt-usage"
                aria-label={t('visualpanels.callTokenUsage')}
              >
                <div>
                  <dt>{t('visualpanels.inputTokens')}</dt>
                  <dd>{tokens(attempt.inputTokens)}</dd>
                </div>
                <div>
                  <dt>{t('visualpanels.outputTokens')}</dt>
                  <dd>{tokens(attempt.outputTokens)}</dd>
                </div>
              </dl>
              <p>
                {t('visualpanels.priceRevision', {
                  v0: attempt.runId
                    ? `Run ${attempt.runId}`
                    : `Job ${attempt.storyJobId ?? attempt.jobId}`,
                  v1: attempt.priceRevision ?? t('visualpanels.unknown'),
                })}
              </p>
              <CacheUsage attempt={attempt} />
              <RequestLoreView
                lore={(attempt.request as { requestLore?: RequestLore } | null)?.requestLore}
              />
              <AttemptPricing attempt={attempt} />
              <AttemptRaw attempt={attempt} />
            </>
          )}
        </LazyDiagnostics>
      ))}
    </div>
  );
}
