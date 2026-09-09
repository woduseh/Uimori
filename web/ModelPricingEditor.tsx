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

export function PricingSummary({
  snapshot,
  context = 'current',
}: {
  snapshot: PricingSnapshot | undefined;
  context?: 'current' | 'attempt';
}) {
  if (!snapshot)
    return (
      <p className="muted">
        이 모델·요청 등급의 요금은 미확인이에요. 요금을 직접 입력하면 호출 후 추정 비용에 사용할 수
        있어요.
      </p>
    );
  const keys = [
    ...primaryRates,
    ...(snapshot.rates.cacheWrite1h !== undefined ? ['cacheWrite1h' as const] : []),
  ];
  return (
    <div className="model-pricing-summary">
      <p>
        {context === 'attempt' ? '호출에 고정된 등급' : '현재 적용 등급'}:{' '}
        <strong>{snapshot.serviceTier}</strong> ·{' '}
        {snapshot.source === 'manual'
          ? '직접 입력 요금'
          : snapshot.source === 'catalog'
            ? '공급자 목록 요금'
            : '공식 요금'}
      </p>
      <small>
        {snapshot.source === 'manual' && context === 'current'
          ? '직접 입력한 참고 단가'
          : `${snapshot.source === 'manual' ? '요금 고정일' : '확인일'}: ${snapshot.checkedAt.slice(0, 10)}`}
        {snapshot.sourceUrl && (
          <>
            {' '}
            ·{' '}
            <a href={snapshot.sourceUrl} target="_blank" rel="noreferrer">
              요금 출처
            </a>
          </>
        )}
      </small>
      <dl
        className="model-pricing-rates"
        aria-label={context === 'attempt' ? '호출에 고정된 기준 요금' : '현재 적용 토큰 요금'}
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
                    Standard 대비 {saving.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%
                    낮음
                  </small>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {snapshot.longContext && (
        <p className="muted">
          입력 {snapshot.longContext.aboveInputTokens.toLocaleString('ko-KR')} 토큰을 초과하면 장문
          요금을 적용해요.
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
  const field = (key: keyof RateDraft) => (
    <label key={key}>
      {pricingRateLabels[key]}
      <input
        type="number"
        min={0}
        step="any"
        inputMode="decimal"
        aria-label={`${label} ${pricingRateLabels[key]} 요금`}
        placeholder="미확인"
        value={rates[key]}
        onChange={(event) => onChange({ ...rates, [key]: event.target.value })}
      />
    </label>
  );
  return (
    <fieldset className="model-pricing-inputs">
      <legend>{label} · USD / 100만 토큰</legend>
      <div className="model-pricing-input-grid">{primaryRates.map(field)}</div>
      <details className="model-pricing-optional" open={rates.cacheWrite1h !== '' || undefined}>
        <summary>1시간 캐시 쓰기 요금</summary>
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
        },
        connection
      );
  } catch {
    error = '요금은 0 이상의 유한한 숫자로 입력해 주세요. 확인되지 않은 요금은 비워 두세요.';
  }
  return (
    <details className="model-pricing full" data-testid="model-pricing-editor">
      <summary>요금과 추정 비용</summary>
      <div className="model-pricing-body">
        <p>
          호출 후 공급자가 보고한 토큰에 이 요금을 적용해 추정 비용을 계산해요. 단위는 USD / 100만
          토큰이에요.
        </p>
        <p className="muted">참고용 추정 금액이며 실제 청구액과 다를 수 있어요.</p>
        <label>
          요금 기준
          <select
            aria-label="요금 기준"
            value={draft.mode}
            onChange={(event) =>
              onChange({ ...draft, mode: event.target.value as 'official' | 'manual' })
            }
          >
            <option value="official">공식 요금 사용</option>
            <option value="manual">요금 직접 입력</option>
          </select>
        </label>
        {draft.mode === 'manual' && (
          <>
            <RateInputs
              rates={draft.rates}
              label="Standard"
              onChange={(rates) => onChange({ ...draft, rates })}
            />
            <ToggleRow
              label="Flex 요금 직접 입력"
              description="Flex 요금은 별도로 확인해 입력해요. Standard 요금의 절반으로 가정하지 않아요."
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
            <small>빈칸은 미확인이에요. 무료인 항목만 0을 입력하세요.</small>
            <button type="button" className="secondary" onClick={() => onChange(pricingDraft())}>
              공식 요금으로 복원
            </button>
          </>
        )}
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : (
          <PricingSummary snapshot={snapshot} />
        )}
      </div>
    </details>
  );
}
