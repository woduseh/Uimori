import { Switch } from './BooleanControls.js';
import { ToggleRow } from './ToggleRow.js';
import { ModelPricingEditor } from './ModelPricingEditor.js';
import { Plus } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { Connection, VertexRequestTier } from '../core/product.js';
import {
  PROTOCOL_OPTION_VALUES,
  protocolCacheTtls,
  protocolOptionKeys,
  protocolServiceTiers,
  supportedModels,
} from '../core/model-capabilities.js';
import { modelHints, type ModelHints } from '../core/model-hints.js';
import type { EvaluationToolOptions } from '../core/evaluation-tool-config.js';
import {
  forcedServiceTierError,
  modelDraftError,
  type ModelDraft,
} from './provider-model-draft.js';
export {
  initialModel,
  modelDraft,
  modelDraftError,
  modelPayload,
  selectModelConnection,
  type ModelDraft,
} from './provider-model-draft.js';

const tierLabels: Record<string, string> = {
  flex: 'Flex',
  standard: 'Standard',
  auto: 'Auto',
  default: 'Default',
  priority: 'Priority',
  standard_only: 'Standard',
};
const tierLabel = (value: string) => tierLabels[value] ?? value;
const strengthLabels: Record<string, string> = {
  none: '끄기',
  minimal: '최소',
  low: '낮음',
  medium: '보통',
  high: '높음',
  xhigh: '매우 높음',
  max: '최대',
  MINIMAL: '최소',
  LOW: '낮음',
  MEDIUM: '보통',
  HIGH: '높음',
};
const strengthLabel = (value: string) =>
  strengthLabels[value] ? `${strengthLabels[value]} · ${value}` : value;
const modeLabel = (value: string) =>
  value === 'adaptive' ? '적응형 · adaptive' : value === 'disabled' ? '끄기 · disabled' : value;
export const sourceLabels: Record<ModelHints['source'], string> = {
  catalog: '공급자 목록 확인',
  reviewed: '앱 확인',
  none: '미확인',
};
const UNDOCUMENTED =
  '문서로 확인한 값이 아니에요. 공급자가 거절하면 실패 이유에 그 이름을 표시해요.';

/**
 * One select for any enumerated option. `choices` are the documented values, `vocabulary` is what
 * the encoder can send. Undocumented vocabulary values stay selectable under a separate group; a
 * value outside the vocabulary cannot be sent and blocks saving.
 */
function ModelOptionSelect({
  label,
  value,
  choices,
  vocabulary,
  onChange,
  format = (item: string) => item,
  defaultLabel = '모델 기본값',
  invalidMessage,
  validationError,
  note,
  full,
}: {
  label: string;
  value: string;
  choices: readonly string[] | undefined;
  vocabulary?: readonly string[];
  onChange: (value: string) => void;
  format?: (value: string) => string;
  defaultLabel?: string;
  invalidMessage?: string;
  validationError?: string;
  /** Always-visible explanation of what the selection becomes on the wire. */
  note?: string;
  full?: boolean;
}) {
  const ref = useRef<HTMLSelectElement>(null);
  const all = vocabulary ?? choices;
  const unsendable = value !== '' && !!vocabulary && !vocabulary.includes(value);
  const undocumented = value !== '' && !unsendable && !!choices && !choices.includes(value);
  const error =
    validationError ||
    (unsendable
      ? (invalidMessage ??
        `${label}의 현재 값은 이 연결에서 보낼 수 없어요. ${defaultLabel}이나 목록의 값으로 변경하세요.`)
      : '');
  useEffect(() => {
    ref.current?.setCustomValidity(error);
  }, [error]);
  if (!all?.length && !value) return null;
  const documented = choices ? (all ?? []).filter((item) => choices.includes(item)) : (all ?? []);
  const rest = choices ? (all ?? []).filter((item) => !choices.includes(item)) : [];
  const option = (item: string) => (
    <option key={item} value={item}>
      {format(item)}
    </option>
  );
  return (
    <label className={full ? 'full' : undefined}>
      {label}
      <select
        ref={ref}
        aria-label={label}
        aria-invalid={!!error || undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{defaultLabel}</option>
        {unsendable && (
          <option value={value} disabled>
            {format(value)} · 보낼 수 없음
          </option>
        )}
        {choices && rest.length > 0 ? (
          <>
            <optgroup label="문서로 확인한 값">{documented.map(option)}</optgroup>
            <optgroup label="미확인 값 · 공급자가 판정">{rest.map(option)}</optgroup>
          </>
        ) : (
          documented.map(option)
        )}
      </select>
      {error ? (
        <small className="error">{error}</small>
      ) : undocumented ? (
        <small className="provider-undocumented">{UNDOCUMENTED}</small>
      ) : null}
      {note && <small className="provider-wire">{note}</small>}
    </label>
  );
}
function OptionalNumber({
  label,
  value,
  sendable,
  documented,
  onChange,
  min,
  max,
}: {
  label: string;
  value: string;
  sendable: boolean;
  documented: boolean | undefined;
  onChange: (value: string) => void;
  min: number;
  max: number;
}) {
  const ref = useRef<HTMLInputElement>(null),
    invalid = value !== '' && !sendable;
  const error = invalid
    ? `${label}은 이 연결에서 보낼 수 없어요. 값을 비워 모델 기본값을 사용하세요.`
    : '';
  useEffect(() => {
    ref.current?.setCustomValidity(error);
  }, [error]);
  if (!sendable && value === '') return null;
  return (
    <label>
      {label}
      <input
        ref={ref}
        aria-label={label}
        aria-invalid={invalid || undefined}
        type="number"
        step="any"
        min={min}
        max={max}
        placeholder="모델 기본값"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? (
        <small className="error">{error}</small>
      ) : documented === false && value !== '' ? (
        <small className="provider-undocumented">{UNDOCUMENTED}</small>
      ) : null}
    </label>
  );
}
function StopSequence({
  value,
  index,
  sendable,
  onChange,
  onRemove,
}: {
  value: string;
  index: number;
  sendable: boolean;
  onChange: (value: string) => void;
  onRemove: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null),
    error = sendable ? '' : '이 연결은 정지 문자열을 보낼 수 없어요. 이 항목을 삭제하세요.';
  useEffect(() => {
    ref.current?.setCustomValidity(error);
  }, [error]);
  return (
    <div className="full">
      <label>
        정지 문자열 {index + 1}
        <textarea
          ref={ref}
          aria-label={`정지 문자열 ${index + 1}`}
          aria-invalid={!sendable || undefined}
          maxLength={1000}
          required
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      {error && <small className="error">{error}</small>}
      <button type="button" className="secondary" onClick={onRemove}>
        정지 문자열 {index + 1} 삭제
      </button>
    </div>
  );
}
/** The one strength control every protocol has, stored in that protocol's native field. */
function ThinkingSelect({
  hints,
  value,
  onChange,
}: {
  hints: ModelHints;
  value: ModelDraft;
  onChange: (next: Partial<ModelDraft>) => void;
}) {
  const thinking = hints.thinking;
  // The native value is what gets sent; a gateway receives its own field and maps it onward.
  const note = thinking?.gateway
    ? `전송 필드 ${thinking.wire} · 게이트웨이나 호환 서버가 모델 공급자의 값으로 변환해요. 모델 공급자의 필드를 직접 지정하려면 그 공급자 연결을 사용하세요.`
    : `전송 필드 ${thinking?.wire} · 선택한 값을 그대로 보내요.`;
  // A value kept from another connection's protocol stays visible so the user can clear it.
  const stale = (['thinkingLevel', 'reasoningEffort', 'outputEffort'] as const).filter(
    (field) => field !== thinking?.field && value[field] !== ''
  );
  return (
    <>
      {thinking && (
        <ModelOptionSelect
          label="사고 강도"
          value={value[thinking.field]}
          choices={thinking.known}
          vocabulary={thinking.all}
          onChange={(next) => onChange({ [thinking.field]: next })}
          format={strengthLabel}
          note={note}
          full
        />
      )}
      {stale.map((field) => (
        <ModelOptionSelect
          key={field}
          label={`이전 연결의 사고 강도 · ${field}`}
          value={value[field]}
          choices={undefined}
          vocabulary={[]}
          onChange={(next) => onChange({ [field]: next })}
          format={strengthLabel}
        />
      ))}
    </>
  );
}

export function ProviderModelFields({
  value,
  onChange,
  connection,
  section,
  forcedVertexTier,
}: {
  section: 'basic' | 'advanced';
  value: ModelDraft;
  onChange: (value: ModelDraft) => void;
  connection: Connection | undefined;
  forcedVertexTier?: VertexRequestTier;
}) {
  const protocol = connection?.protocol;
  const vertex = protocol === 'vertex-gemini-v1',
    fixture = protocol === 'fixture-sse-v1',
    codex = protocol === 'codex-app-server-v1';
  const keys = protocol ? protocolOptionKeys(protocol) : [];
  const sends = (key: string) => keys.includes(key);
  const hints = connection ? modelHints(connection, value.modelId) : undefined;
  const capability = hints?.capability;
  const cacheTtlAvailable = value.cacheMode === 'explicit' || value.cacheMode === 'automatic';
  const optionsError =
    connection && value.modelId ? modelDraftError(value, connection, forcedVertexTier) : '';
  const modelChoices = connection
    ? [
        ...new Map(
          [...supportedModels(connection.protocol), ...connection.catalog].map((item) => [
            item.id,
            item,
          ])
        ).values(),
      ]
    : [];
  const update = (next: Partial<ModelDraft>) => onChange({ ...value, ...next });
  const evaluation = value.evaluationTools;
  const setEvaluation = (next: ModelDraft['evaluationTools']) => update({ evaluationTools: next });
  return (
    <>
      <div
        className="provider-model-section full"
        data-model-section="basic"
        hidden={section !== 'basic'}
      >
        <label className="full">
          모델 ID
          <input
            aria-label="모델 ID"
            list="available-models"
            required
            value={value.modelId}
            onChange={(event) => update({ modelId: event.target.value })}
          />
          <datalist id="available-models">
            {modelChoices.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </datalist>
          <small>
            목록에서 고르거나 모델 ID를 직접 입력해요. 표에 없는 모델도 그대로 보내고 지원 여부는
            공급자가 답해요.
          </small>
        </label>
        <ToggleRow
          label="새 모델 선택에 표시"
          description="새로 모델을 고를 때 목록에 표시해요. 끄면 이 모델의 새 실행이 차단돼요. 전역 역할 선택과 과거 실행의 설정은 유지돼요."
          checked={value.enabled}
          onChange={(enabled) => update({ enabled })}
        />
        {value.modelId && hints && (
          <p className="muted full" data-testid="model-hint-source">
            {hints.source === 'none'
              ? codex
                ? 'Codex 실행기의 모델이에요. 사고 강도는 Codex가 받는 값으로 보내요.'
                : fixture
                  ? '로컬 합성 검사용 모델이에요.'
                  : '옵션 출처 미확인 · 이 연결이 보낼 수 있는 옵션을 모두 고를 수 있고 지원 여부는 공급자가 판정해요.'
              : `옵션 출처 ${sourceLabels[hints.source]}${capability ? ` · ${capability.name}` : ''} · 확인한 값을 먼저 보여주고 나머지는 미확인으로 표시해요.`}
          </p>
        )}
        <label>
          {codex ? '출력 목표 토큰' : '최대 출력 토큰'}
          <input
            aria-label={codex ? '출력 목표 토큰' : '최대 출력 토큰'}
            type="number"
            min={1}
            max={500000}
            required
            value={value.maxOutputTokens}
            onChange={(event) => update({ maxOutputTokens: event.target.value })}
          />
          {hints?.maxOutputTokens !== undefined && (
            <small>
              {sourceLabels[hints.source]} 상한 {hints.maxOutputTokens.toLocaleString()} 토큰
            </small>
          )}
        </label>
        {hints && <ThinkingSelect hints={hints} value={value} onChange={update} />}
      </div>
      <div
        className="provider-model-section full"
        data-model-section="advanced"
        hidden={section !== 'advanced'}
      >
        <label className="full">
          입력 컨텍스트 한도
          <input
            aria-label="입력 컨텍스트 한도"
            type="number"
            min={8192}
            max={1000000}
            step={1}
            placeholder="272000"
            value={value.inputTokenLimit}
            onChange={(event) => update({ inputTokenLimit: event.target.value })}
          />
          <small>
            비우면 기본값 272,000토큰을 사용해요. o200k 기반 토큰 추정치예요. 한도에 가까워지면 앞선
            대화를 요약하고 최근 대화를 유지해요. 출력 토큰 한도와 별개예요.
            {hints?.inputTokenLimit !== undefined &&
              ` 공급자 목록 기준 ${hints.inputTokenLimit.toLocaleString()}토큰이에요.`}
          </small>
        </label>
        {/* Options the protocol cannot send stay visible while a value is set, so it can be cleared. */}
        {(hints?.thinkingModes || value.thinkingMode) && (
          <ModelOptionSelect
            label="사고 모드"
            value={value.thinkingMode}
            choices={hints?.thinkingModes?.known}
            vocabulary={hints?.thinkingModes?.all ?? []}
            onChange={(thinkingMode) => update({ thinkingMode })}
            format={modeLabel}
          />
        )}
        {(sends('verbosity') || value.verbosity) && (
          <ModelOptionSelect
            label="Verbosity"
            value={value.verbosity}
            choices={capability?.verbosities}
            vocabulary={sends('verbosity') ? PROTOCOL_OPTION_VALUES.verbosity : []}
            onChange={(verbosity) => update({ verbosity })}
          />
        )}
        {(sends('reasoningMode') || value.reasoningMode) && (
          <ModelOptionSelect
            label="Reasoning Mode"
            value={value.reasoningMode}
            choices={capability?.reasoningModes}
            vocabulary={sends('reasoningMode') ? PROTOCOL_OPTION_VALUES.reasoningMode : []}
            onChange={(reasoningMode) => update({ reasoningMode })}
          />
        )}
        {(sends('reasoningContext') || value.reasoningContext) && (
          <ModelOptionSelect
            label="Reasoning Context"
            value={value.reasoningContext}
            choices={capability?.reasoningContexts}
            vocabulary={sends('reasoningContext') ? PROTOCOL_OPTION_VALUES.reasoningContext : []}
            onChange={(reasoningContext) => update({ reasoningContext })}
          />
        )}
        {protocol && (sends('serviceTier') || value.serviceTier) && (
          <ModelOptionSelect
            label="Service Tier"
            value={value.serviceTier}
            choices={capability?.serviceTiers ?? protocolServiceTiers(protocol)}
            vocabulary={
              !sends('serviceTier') ? [] : vertex ? protocolServiceTiers(protocol) : undefined
            }
            onChange={(serviceTier) => update({ serviceTier })}
            format={tierLabel}
            validationError={forcedServiceTierError(value, connection, forcedVertexTier)}
          />
        )}
        {vertex && forcedVertexTier && (
          <p className="muted full">
            서버에서 Service Tier를 {tierLabel(forcedVertexTier)}로 제한해요. 모델 기본값도{' '}
            {tierLabel(forcedVertexTier)}로 실행돼요.
          </p>
        )}
        {protocol && (sends('cacheMode') || value.cacheMode || value.cacheTtl) && (
          <fieldset className="editor-fields full">
            <legend>프롬프트 캐시</legend>
            <ModelOptionSelect
              label="캐시 방식"
              value={value.cacheMode}
              choices={capability?.cacheModes}
              vocabulary={sends('cacheMode') ? PROTOCOL_OPTION_VALUES.cacheMode : []}
              onChange={(cacheMode) => update({ cacheMode })}
              defaultLabel="프롬프트 기준 / 공급자 기본값"
              format={(mode) =>
                mode === 'disabled'
                  ? '캐시 끄기'
                  : mode === 'explicit'
                    ? '프롬프트 캐시 기준점만'
                    : mode === 'automatic'
                      ? '자동 캐싱 + 기준점'
                      : mode
              }
            />
            <ModelOptionSelect
              label="캐시 유지 시간"
              value={value.cacheTtl}
              choices={
                cacheTtlAvailable
                  ? (capability?.cacheTtls ?? protocolCacheTtls(protocol))
                  : undefined
              }
              vocabulary={
                cacheTtlAvailable && sends('cacheMode') ? protocolCacheTtls(protocol) : []
              }
              onChange={(cacheTtl) => update({ cacheTtl })}
              defaultLabel="공급자 기본값"
              format={(ttl) =>
                ttl === '5m' ? '5분' : ttl === '30m' ? '30분' : ttl === '1h' ? '60분' : ttl
              }
              invalidMessage={
                !cacheTtlAvailable
                  ? '유지 시간을 지정하려면 캐시 기준점 또는 자동 캐싱 방식을 선택하세요. 현재 방식은 유지 시간을 공급자 기본값으로 되돌려야 해요.'
                  : undefined
              }
            />
            {value.cacheMode === 'disabled' && (
              <small className="full">프롬프트의 캐시 기준점도 적용하지 않아요.</small>
            )}
            {value.cacheTtl === '1h' && (
              <small className="full">Claude의 60분 캐시는 5분보다 캐시 쓰기 비용이 더 커요.</small>
            )}
            {value.cacheMode === 'automatic' && (
              <small className="full">
                자동 캐싱은 캐시 기준점 한 개를 사용해요. 프롬프트에서 직접 지정하는 기준점은 최대
                3개예요.
              </small>
            )}
            <small className="full">
              기준점은 프롬프트 편집기의 ‘캐시 기준점’에서 지정해요. 가능할 때 적용(prefer)하거나,
              적용할 수 없으면 요청을 중단(require)하도록 선택할 수 있어요. 캐시 적중은 응답의
              사용량으로 확인해요.
            </small>
          </fieldset>
        )}
        {vertex && (
          <small className="full">
            Gemini는 공급자의 자동 캐시를 사용해요. 캐시 끄기와 유지 시간을 직접 지정하지 않아요.
          </small>
        )}
        {protocol && !vertex && !sends('cacheMode') && (
          <small className="full">이 연결에서는 서비스 자체의 캐싱을 직접 제어하지 않아요.</small>
        )}
        <OptionalNumber
          label="Temperature"
          value={value.temperature}
          sendable={sends('temperature')}
          documented={capability?.temperature}
          min={0}
          max={2}
          onChange={(temperature) => update({ temperature })}
        />
        <OptionalNumber
          label="Top P"
          value={value.topP}
          sendable={sends('topP')}
          documented={capability?.topP}
          min={0}
          max={1}
          onChange={(topP) => update({ topP })}
        />
        {(sends('stopSequences') || value.stopSequences.length > 0) && (
          <fieldset className="editor-fields full">
            <legend>정지 문자열</legend>
            {value.stopSequences.map((stop, index) => (
              <StopSequence
                key={index}
                index={index}
                value={stop}
                sendable={sends('stopSequences')}
                onChange={(next) =>
                  update({
                    stopSequences: value.stopSequences.map((item, i) =>
                      i === index ? next : item
                    ),
                  })
                }
                onRemove={() =>
                  update({ stopSequences: value.stopSequences.filter((_, i) => i !== index) })
                }
              />
            ))}
            {sends('stopSequences') && (
              <button
                type="button"
                className="secondary provider-stop-add full"
                disabled={value.stopSequences.length >= 4}
                onClick={() => update({ stopSequences: [...value.stopSequences, ''] })}
              >
                <Plus size={18} aria-hidden="true" /> 정지 문자열 추가
              </button>
            )}
            <small className="full">
              최대 4개예요. 각 항목의 문자열이 생성되면 응답을 멈춰요. 줄바꿈도 문자열에 포함돼요.
              {capability?.stopSequences === false && ` ${UNDOCUMENTED}`}
            </small>
          </fieldset>
        )}
        {!fixture && (
          <label>
            응답 제한 시간 (초)
            <input
              aria-label="응답 제한 시간 (초)"
              type="number"
              step="any"
              min={0.001}
              max={1800}
              placeholder="앱 기본값"
              value={value.timeoutSeconds}
              onChange={(event) => update({ timeoutSeconds: event.target.value })}
            />
          </label>
        )}
        {connection && !fixture && (
          <>
            {codex ? (
              <p className="full">Codex 번역은 고정된 구조화 출력 계약을 사용해요.</p>
            ) : (
              sends('structuredOutput') && (
                <label>
                  번역 구조화 출력
                  <select
                    aria-label="번역 구조화 출력"
                    value={value.structuredOutput}
                    onChange={(event) =>
                      update({
                        structuredOutput: event.target.value as ModelDraft['structuredOutput'],
                      })
                    }
                  >
                    <option value="default">연결 기본값</option>
                    <option value="on">JSON Schema 사용</option>
                    <option value="off">지침과 결과 검증만 사용</option>
                  </select>
                </label>
              )
            )}
            <small className="full">
              OpenAI Responses·Anthropic은 번역에 JSON Schema를 기본 사용해요. Vercel·별도 호환
              공급자는 기본 미사용이며 결과 검증은 항상 적용해요.
            </small>
          </>
        )}
        {protocol && !sends('structuredOutput') && value.structuredOutput !== 'default' && (
          <p className="error full">
            이 연결은 번역 출력 형식을 직접 지정할 수 없어요.{' '}
            <button
              type="button"
              className="secondary"
              onClick={() => update({ structuredOutput: 'default' })}
            >
              번역 출력 형식 기본값 사용
            </button>
          </p>
        )}
        <small className="full">
          모델 기본값을 선택하면 해당 옵션을 보내지 않아요. 미확인 값은 그대로 보내고 공급자가
          거절하면 그 이름을 알려줘요.
        </small>
        {codex && (
          <small className="full">
            출력 목표 토큰은 Uimori의 출력 목표이며 Codex 내부 hard budget을 보장하지 않아요.
          </small>
        )}
        <fieldset className="editor-fields full">
          <legend>선택형 평가 도구</legend>
          <ToggleRow
            label="이 모델 프리셋에 평가 도구 4개 사용"
            checked={value.evaluationToolsEnabled}
            onChange={(evaluationToolsEnabled) => update({ evaluationToolsEnabled })}
          />
          {value.evaluationToolsEnabled && (
            <>
              <label className="full">
                평가 문맥 제공
                <select
                  aria-label="평가 문맥 제공"
                  value={evaluation.contextMode}
                  onChange={(event) =>
                    setEvaluation({
                      ...evaluation,
                      contextMode: event.target.value as EvaluationToolOptions['contextMode'],
                    })
                  }
                >
                  <option value="model-selected">모델이 네 도구 중 선택</option>
                  <option value="preloaded" disabled={capability?.forcedTools === false}>
                    문맥·검토자 결과를 먼저 제공
                    {capability?.forcedTools === false ? ' · 이 모델 미지원' : ''}
                  </option>
                </select>
                {capability?.forcedTools === false && (
                  <small>이 모델은 평가 도구를 직접 선택하는 방식으로 사용해요.</small>
                )}
              </label>
              {evaluation.contextMode === 'preloaded' && (
                <label className="full">
                  첫 case 라운드 추론
                  <select
                    aria-label="첫 case 라운드 추론"
                    value={evaluation.approvalReasoningMode}
                    onChange={(event) =>
                      setEvaluation({
                        ...evaluation,
                        approvalReasoningMode: event.target
                          .value as EvaluationToolOptions['approvalReasoningMode'],
                      })
                    }
                  >
                    <option value="configured">프리셋 설정 유지</option>
                    <option value="economized">8,000 토큰·low로 절약</option>
                  </select>
                </label>
              )}
              <label>
                최대 평가 도구 라운드
                <input
                  aria-label="최대 평가 도구 라운드"
                  type="number"
                  min={0}
                  max={32}
                  required
                  value={evaluation.maximumToolRounds}
                  onChange={(event) =>
                    setEvaluation({ ...evaluation, maximumToolRounds: event.target.value })
                  }
                />
              </label>
              <label className="check">
                <Switch
                  checked={evaluation.terminalLateCorrections}
                  onChange={(event) =>
                    setEvaluation({ ...evaluation, terminalLateCorrections: event.target.checked })
                  }
                />
                제출 원고의 정확한 문자열 교정 허용
              </label>
              <label className="check">
                <Switch
                  checked={evaluation.outputRecovery}
                  onChange={(event) =>
                    setEvaluation({ ...evaluation, outputRecovery: event.target.checked })
                  }
                />
                명확한 거절 제출은 한 번 재요청
              </label>
            </>
          )}
          <small className="full">
            선택한 프리셋에서만 eval_get_context, eval_get_reviewer, eval_create_case,
            eval_submit_artifact를 사용해요. preloaded는 앞의 두 결과를 호출 이력으로 제공하고
            case·submit만 노출해요. 절약 모드는 첫 case 라운드에서만 출력 상한과 설정된 reasoning
            effort를 낮춰요. 별도 안내문은 원문에 합치지 않아요.
          </small>
        </fieldset>
        <ModelPricingEditor
          value={value}
          connection={connection}
          forcedVertexTier={forcedVertexTier}
          onChange={(pricing) => update({ pricing })}
        />
      </div>
      {optionsError && (
        <p className="error full" role="alert">
          {optionsError}
        </p>
      )}
    </>
  );
}
