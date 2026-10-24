import { t, useI18n, formatNumber, formatDate, translateMessage } from './i18n.js';
import type { Connection, ModelPreset, VertexRequestTier } from '../core/product.js';
import type { PricingSnapshot } from '../core/pricing-types.js';
import { resolveModelPricing, validateModelPricing } from '../core/model-pricing.js';
import { ToggleRow } from './ToggleRow.js';
import { formatUsd, pricingRateLabels, pricingNote } from './pricing-display.js';
import {
  pricingDraft,
  pricingPayload,
  type ModelDraft,
  type RateDraft,
} from './provider-model-draft.js';
import './model-pricing.css';

const primaryRates = ['input', 'cacheRead', 'cacheWrite', 'output'] as const;

function PricingSummary({
  snapshot,
  context = 'current',
}: {
  snapshot: PricingSnapshot | undefined;
  context?: 'current' | 'attempt';
}) {
  useI18n();
  if (!snapshot) return <p className="muted">{t('providers.m474')}</p>;
  const keys = [
    ...primaryRates,
    ...(snapshot.rates.cacheWrite1h !== undefined ? ['cacheWrite1h' as const] : []),
  ];
  return (
    <div className="model-pricing-summary">
      <p className="ui-meta-row">
        <span>
          {context === 'attempt' ? t('providers.m475') : t('providers.m476')}:{' '}
          <strong>{snapshot.serviceTier}</strong>
        </span>
        <span>
          {snapshot.source === 'manual'
            ? t('providers.m477')
            : snapshot.source === 'catalog'
              ? t('providers.m478')
              : t('providers.m479')}
        </span>
      </p>
      <small className="ui-meta-row">
        <span>
          {snapshot.source === 'manual' && context === 'current'
            ? t('providers.m591', {
                value0: formatDate(snapshot.checkedAt, {
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                  timeZone: 'UTC',
                }),
              })
            : t('providers.m592', {
                value0: snapshot.source === 'manual' ? t('providers.m480') : t('providers.m481'),
                value1: formatDate(snapshot.checkedAt, {
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                  timeZone: 'UTC',
                }),
              })}
        </span>
        {snapshot.sourceUrl && (
          <>
            <a href={snapshot.sourceUrl} target="_blank" rel="noreferrer">
              {t('providers.m482')}
            </a>
          </>
        )}
      </small>
      <strong className="model-pricing-unit">{t('settings.priceUnit')}</strong>
      <dl
        className="model-pricing-rates"
        aria-label={context === 'attempt' ? t('providers.m483') : t('providers.m484')}
      >
        {keys.map((key) => {
          const current = snapshot.rates[key];
          const standard = snapshot.standardRates?.[key];
          const saving =
            typeof current === 'number' &&
            typeof standard === 'number' &&
            standard > 0 &&
            current < standard
              ? (1 - current / standard) * 100
              : undefined;
          return (
            <div key={key}>
              <dt>{pricingRateLabels[key]}</dt>
              <dd>
                {formatUsd(current)}
                {saving !== undefined && (
                  <small>
                    {t('providers.m593', {
                      value0: formatNumber(saving, { maximumFractionDigits: 1 }),
                    })}
                  </small>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {snapshot.longContext && (
        <p className="muted">
          {t('providers.m594', {
            value0: formatNumber(snapshot.longContext.aboveInputTokens),
          })}
        </p>
      )}
      {snapshot.notes.length > 0 && (
        <ul className="model-pricing-notes">
          {snapshot.notes.map((note, index) => (
            <li key={`${index}:${note}`}>{pricingNote(note)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RateInputs({
  rates,
  label,
  onChange,
}: {
  rates: RateDraft;
  label: string;
  onChange: (rates: RateDraft) => void;
}) {
  useI18n();
  const field = (key: keyof RateDraft) => (
    <label key={key}>
      {pricingRateLabels[key]}
      <input
        type="number"
        min={0}
        step="any"
        inputMode="decimal"
        aria-label={t('providers.m595', { value0: label, value1: pricingRateLabels[key] })}
        placeholder={t('providers.m489')}
        value={rates[key]}
        onChange={(event) => onChange({ ...rates, [key]: event.target.value })}
      />
    </label>
  );
  return (
    <fieldset className="model-pricing-inputs">
      <legend>{t('providers.m596', { value0: label })}</legend>
      <div className="model-pricing-input-grid">{primaryRates.map(field)}</div>
      <details className="model-pricing-optional" open={rates.cacheWrite1h !== '' || undefined}>
        <summary>{t('providers.m491')}</summary>
        {field('cacheWrite1h')}
      </details>
    </fieldset>
  );
}

export function ModelPricingEditor({
  value,
  connection,
  onChange,
  forcedVertexTier,
}: {
  value: ModelDraft;
  connection: Connection | undefined;
  onChange: (pricing: ModelDraft['pricing']) => void;
  forcedVertexTier?: VertexRequestTier;
}) {
  useI18n();
  if (connection?.protocol === 'codex-app-server-v1')
    return <p className="muted full">{t('providers.m492')}</p>;
  const draft = value.pricing;
  let snapshot: PricingSnapshot | undefined;
  let error = '';
  try {
    const pricing = validateModelPricing(pricingPayload(draft));
    if (connection && value.modelId)
      snapshot = resolveModelPricing(
        {
          modelId: value.modelId,
          serviceTier: (connection.protocol === 'vertex-gemini-v1' && forcedVertexTier
            ? forcedVertexTier
            : value.serviceTier || undefined) as ModelPreset['serviceTier'],
          cacheTtl: (value.cacheTtl || undefined) as ModelPreset['cacheTtl'],
          pricing,
          executionMode: value.executionMode,
        },
        connection
      );
  } catch {
    error = t('providers.m493');
  }
  const longInput = (
    key: 'longContext' | 'flexLongContext' | 'batchLongContext',
    label: string
  ) => (
    <details
      className="model-pricing-optional"
      open={draft[key].aboveInputTokens !== '' || undefined}
    >
      <summary>{t('providers.m597', { value0: label })}</summary>
      <label>
        {t('providers.m495')}
        <input
          type="number"
          min={1}
          step={1}
          aria-label={t('providers.m598', { value0: label })}
          value={draft[key].aboveInputTokens}
          placeholder={t('providers.m497')}
          onChange={(event) =>
            onChange({ ...draft, [key]: { ...draft[key], aboveInputTokens: event.target.value } })
          }
        />
      </label>
      {draft[key].aboveInputTokens !== '' && (
        <RateInputs
          label={t('providers.m599', { value0: label })}
          rates={draft[key].rates}
          onChange={(rates) => onChange({ ...draft, [key]: { ...draft[key], rates } })}
        />
      )}
    </details>
  );
  return (
    <details className="model-pricing full" data-testid="model-pricing-editor">
      <summary>{t('providers.m499')}</summary>
      <div className="model-pricing-body">
        <p>{t('providers.m500')}</p>
        <p className="muted">{t('providers.m501')}</p>
        <label>
          {t('providers.m502')}
          <select
            aria-label={t('providers.m502')}
            value={draft.mode}
            onChange={(event) =>
              onChange({ ...draft, mode: event.target.value as 'official' | 'manual' })
            }
          >
            <option value="official">{t('providers.m503')}</option>
            <option value="manual">{t('providers.m504')}</option>
          </select>
        </label>
        {draft.mode === 'manual' && (
          <>
            <RateInputs
              rates={draft.rates}
              label="Standard"
              onChange={(rates) => onChange({ ...draft, rates })}
            />
            {longInput('longContext', 'Standard')}
            <ToggleRow
              label={t('providers.m505')}
              description={t('providers.m506')}
              checked={draft.flexEnabled}
              onChange={(flexEnabled) => onChange({ ...draft, flexEnabled })}
            />
            {draft.flexEnabled && (
              <RateInputs
                rates={draft.flexRates}
                label="Flex"
                onChange={(flexRates) => onChange({ ...draft, flexRates })}
              />
            )}
            {draft.flexEnabled && longInput('flexLongContext', 'Flex')}
            {connection?.protocol === 'anthropic-messages-v1' && (
              <>
                <ToggleRow
                  label={t('providers.m507')}
                  checked={draft.batchEnabled}
                  onChange={(batchEnabled) => onChange({ ...draft, batchEnabled })}
                />
                {draft.batchEnabled && (
                  <>
                    <RateInputs
                      label="Batch"
                      rates={draft.batchRates}
                      onChange={(batchRates) => onChange({ ...draft, batchRates })}
                    />
                    {longInput('batchLongContext', 'Batch')}
                  </>
                )}
              </>
            )}
            <label>
              {t('providers.m509')}
              <input
                type="url"
                value={draft.sourceUrl}
                placeholder="https://"
                onChange={(event) => onChange({ ...draft, sourceUrl: event.target.value })}
              />
            </label>
            <label>
              {t('providers.m510')}
              <input
                type="date"
                value={draft.checkedAt.slice(0, 10)}
                onChange={(event) => onChange({ ...draft, checkedAt: event.target.value })}
              />
            </label>
            <small>{t('providers.m511')}</small>
            <button type="button" className="secondary" onClick={() => onChange(pricingDraft())}>
              {t('providers.m512')}
            </button>
          </>
        )}
        {error ? (
          <p className="error" role="alert">
            {translateMessage(error)}
          </p>
        ) : (
          <PricingSummary snapshot={snapshot} />
        )}
      </div>
    </details>
  );
}
