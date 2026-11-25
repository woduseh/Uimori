import { t, useI18n, translateMessage, formatNumber, formatDate } from './i18n.js';
import { useState } from 'react';
import type { Attempt } from '../core/product.js';
import type { RequestLore } from '../core/request-lore.js';
import { providerCacheUsage } from '../core/provider-cache-usage.js';
import { formatUsd, pricingRateLabels, pricingNote } from './pricing-display.js';
import { RequestLoreEntries } from './RequestLoreEntries.js';
import { CopyTextButton } from './TaskHistory.js';
import './model-pricing.css';
import './lore-context.css';

function attemptRawText(attempt: Attempt) {
  return JSON.stringify(
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
  );
}
function AttemptRaw({ attempt }: { attempt: Attempt }) {
  useI18n();
  const [open, setOpen] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  return (
    <div className="attempt-raw">
      <div className="form-actions">
        <button
          type="button"
          className="secondary"
          aria-expanded={open}
          onClick={() => setOpen((old) => !old)}
        >
          {open
            ? t('visualpanels.hideRawRequestAndResponse')
            : t('visualpanels.viewRawRequestAndResponse')}
        </button>
        <CopyTextButton
          text={() => attemptRawText(attempt)}
          label={t('visuals.historyCopy')}
          copiedLabel={t('visuals.historyCopied')}
          onFailure={() => setCopyFailed(true)}
        />
      </div>
      {copyFailed && <p className="error">{t('visuals.historyCopyFailed')}</p>}
      {open && <pre>{attemptRawText(attempt)}</pre>}
    </div>
  );
}

function estimateText(estimate: Attempt['estimatedCost']) {
  if (estimate?.status === 'estimated' && estimate.usd !== null) return formatUsd(estimate.usd);
  if (estimate && estimate.subtotalUsd > 0)
    return t('visualpanels.knownSubtotalIncludesUnknownItemsInCalls', {
      v0: formatUsd(estimate.subtotalUsd),
      v1: 1,
    });
  return t('visualpanels.unknown');
}

function AttemptPricing({ attempt }: { attempt: Attempt }) {
  useI18n();
  const estimate = attempt.estimatedCost;
  return (
    <section className="attempt-pricing" aria-label={t('visualpanels.estimatedCallCost')}>
      {attempt.costUsd !== null && (
        <p>{t('visualpanels.providerReportedCost', { v0: formatUsd(attempt.costUsd) })}</p>
      )}
      <p>
        <strong>{t('visualpanels.estimatedCost', { v0: estimateText(estimate) })}</strong>
      </p>
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
              <a href={attempt.pricingSnapshot.sourceUrl} target="_blank" rel="noreferrer">
                {t('visualpanels.priceSource')}
              </a>
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
      {estimate && estimate.lines.length > 0 && (
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
      )}
      {estimate && estimate.notes.length > 0 && (
        <ul className="model-pricing-notes">
          {estimate.notes.map((note, index) => (
            <li key={`${index}:${note}`}>{pricingNote(note)}</li>
          ))}
        </ul>
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
    </p>
  );
}

export function RequestLoreView({
  lore,
  heading = true,
}: {
  lore?: RequestLore | null;
  heading?: boolean;
}) {
  useI18n();
  const confirmed = lore?.entries.filter((entry) => entry.delivery !== 'unverified') ?? [];
  const uncertain = lore?.entries.filter((entry) => entry.delivery === 'unverified') ?? [];
  return (
    <section
      className="lore-context-result attempt-lore"
      aria-label={t('visualpanels.loreIncludedInRequest')}
    >
      {heading && <h4>{t('visualpanels.includedLore', { count: confirmed.length })}</h4>}
      {!lore ? (
        <p className="muted">{t('visualpanels.thereIsNoLoreInclusionRecordFor')}</p>
      ) : (
        <>
          {confirmed.length ? (
            <RequestLoreEntries entries={confirmed} />
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
              <RequestLoreEntries entries={uncertain} />
            </details>
          )}
        </>
      )}
    </section>
  );
}

export function AttemptDetail({ attempt, label }: { attempt: Attempt; label: string }) {
  useI18n();
  const lore = (attempt.request as { requestLore?: RequestLore } | null)?.requestLore;
  return (
    <section
      className="attempt-detail-body"
      aria-label={t('visualpanels.attemptDetailFor', { role: label, model: attempt.modelId })}
    >
      <CacheUsage attempt={attempt} />
      {lore && <RequestLoreView lore={lore} />}
      <AttemptPricing attempt={attempt} />
      <AttemptRaw attempt={attempt} />
    </section>
  );
}
