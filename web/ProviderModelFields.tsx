import { Switch } from './BooleanControls.js';
import { ToggleRow } from './ToggleRow.js';
import { Plus } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { Connection, VertexRequestTier } from '../core/product.js';
import {
  isOfficialModelConnection,
  modelCapability,
  supportedModels,
} from '../core/model-capabilities.js';
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
function ModelOptionSelect({
  label,
  value,
  choices,
  onChange,
  format = (item: string) => item,
  defaultLabel = '모델 기본값',
  invalidMessage,
  validationError,
}: {
  label: string;
  value: string;
  choices: readonly string[] | undefined;
  onChange: (value: string) => void;
  format?: (value: string) => string;
  defaultLabel?: string;
  invalidMessage?: string;
  validationError?: string;
}) {
  const ref = useRef<HTMLSelectElement>(null),
    unsupported = value !== '' && !choices?.includes(value),
    invalid = unsupported || !!validationError;
  const error =
    validationError ||
    (unsupported
      ? (invalidMessage ??
        `${label}의 현재 값은 이 모델에서 지원하지 않아요. ${defaultLabel}이나 지원하는 값으로 변경하세요.`)
      : '');
  useEffect(() => {
    ref.current?.setCustomValidity(error);
  }, [error]);
  if (!choices?.length && !value) return null;
  return (
    <label>
      {label}
      <select
        ref={ref}
        aria-label={label}
        aria-invalid={invalid || undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{defaultLabel}</option>
        {unsupported && (
          <option value={value} disabled>
            {format(value)} · 미지원
          </option>
        )}
        {choices?.map((item) => (
          <option key={item} value={item}>
            {format(item)}
          </option>
        ))}
      </select>
      {error && <small className="error">{error}</small>}
    </label>
  );
}
function OptionalNumber({
  label,
  value,
  supported,
  onChange,
  min,
  max,
}: {
  label: string;
  value: string;
  supported: boolean;
  onChange: (value: string) => void;
  min: number;
  max: number;
}) {
  const ref = useRef<HTMLInputElement>(null),
    invalid = value !== '' && !supported;
  const error = invalid
    ? `${label}은 이 모델에서 지원하지 않아요. 값을 비워 모델 기본값을 사용하세요.`
    : '';
  useEffect(() => {
    ref.current?.setCustomValidity(error);
  }, [error]);
  if (!supported && value === '') return null;
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
      {error && <small className="error">{error}</small>}
    </label>
  );
}
function StopSequence({
  value,
  index,
  supported,
  onChange,
  onRemove,
}: {
  value: string;
  index: number;
  supported: boolean;
  onChange: (value: string) => void;
  onRemove: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null),
    error = supported ? '' : '이 모델은 정지 문자열을 지원하지 않아요. 이 항목을 삭제하세요.';
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
          aria-invalid={!supported || undefined}
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

export function ProviderModelFields({
  value,
  onChange,
  connection,
  section,
  forcedVertexTier,
}: {
  section: 'basic' | 'generation' | 'advanced';
  value: ModelDraft;
  onChange: (value: ModelDraft) => void;
  connection: Connection | undefined;
  forcedVertexTier?: VertexRequestTier;
}) {
  const vertex = connection?.protocol === 'vertex-gemini-v1',
    fixture = connection?.protocol === 'fixture-sse-v1',
    codex = connection?.protocol === 'codex-app-server-v1';
  const capability = connection ? modelCapability(connection.protocol, value.modelId) : undefined;
  const official = connection && isOfficialModelConnection(connection);
  const compatible =
    connection?.protocol === 'openai-chat-v1' ||
    connection?.protocol === 'vercel-chat-v1' ||
    (connection?.protocol === 'openai-responses-v1' && !official);
  const thinkingLevels =
    capability?.thinkingLevels ?? (fixture ? ['LOW', 'MEDIUM', 'HIGH'] : undefined);
  const reasoningEfforts =
    capability?.reasoningEfforts ??
    (codex
      ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
      : compatible
        ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
        : undefined);
  const temperature = capability?.temperature ?? (fixture || compatible);
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
  const override = (key: 'tools' | 'structuredOutput' | 'note', next: boolean | null | string) =>
    update({
      userOverrides: {
        tools: null,
        structuredOutput: null,
        note: '',
        ...value.userOverrides,
        [key]: next,
      },
    });
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
            목록에서 고르거나 모델 ID를 직접 입력해요. 모델을 바꾸면 기존 설정을 유지하고 맞지 않는
            옵션을 알려줘요.
          </small>
        </label>
        <ToggleRow
          label="새 모델 선택에 표시"
          description="새로 모델을 고를 때 목록에 표시해요. 끄면 이 모델의 새 실행이 차단돼요. 전역 역할 선택과 과거 실행의 설정은 유지돼요."
          checked={value.enabled}
          onChange={(enabled) => update({ enabled })}
        />
        {value.modelId && (
          <p className="muted full">
            {capability
              ? `${capability.name} · ${official ? '파라미터 지원 명세 확인' : '참고 명세 있음 · 이 연결의 모델 지원은 미확인'}`
              : compatible
                ? '호환 API의 기본 옵션을 제공해요. 선택한 공급자와 모델의 지원 여부는 미확인이에요.'
                : codex
                  ? 'Codex 실행기의 모델과 추론 옵션을 확인해 주세요.'
                  : fixture
                    ? '로컬 합성 검사용 모델이에요.'
                    : '이 모델의 파라미터 지원 명세는 미확인이에요. ID 등록만으로 실행 지원이 확인되지는 않아요.'}
          </p>
        )}
      </div>
      <div
        className="provider-model-section full"
        data-model-section="generation"
        hidden={section !== 'generation'}
      >
        <label>
          {codex ? '출력 목표 토큰' : '최대 출력 토큰'}
          <input
            aria-label={codex ? '출력 목표 토큰' : '최대 출력 토큰'}
            type="number"
            min={1}
            max={capability?.maxOutputTokens ?? 200000}
            required
            value={value.maxOutputTokens}
            onChange={(event) => update({ maxOutputTokens: event.target.value })}
          />
        </label>
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
          </small>
        </label>
        <ModelOptionSelect
          label="Thinking Level"
          value={value.thinkingLevel}
          choices={thinkingLevels}
          onChange={(thinkingLevel) => update({ thinkingLevel })}
        />
        <ModelOptionSelect
          label="Reasoning Effort"
          value={value.reasoningEffort}
          choices={reasoningEfforts}
          onChange={(reasoningEffort) => update({ reasoningEffort })}
        />
        <ModelOptionSelect
          label="Verbosity"
          value={value.verbosity}
          choices={capability?.verbosities}
          onChange={(verbosity) => update({ verbosity })}
        />
        <ModelOptionSelect
          label="Output Effort"
          value={value.outputEffort}
          choices={capability?.outputEfforts}
          onChange={(outputEffort) => update({ outputEffort })}
        />
        <ModelOptionSelect
          label="Thinking"
          value={value.thinkingMode}
          choices={capability?.thinkingModes}
          onChange={(thinkingMode) => update({ thinkingMode })}
        />
        {capability?.thinkingModes?.length === 1 && capability.thinkingModes[0] === 'adaptive' && (
          <p className="muted full">Adaptive Thinking은 항상 켜져 있어요.</p>
        )}
        <ModelOptionSelect
          label="Service Tier"
          value={value.serviceTier}
          choices={capability?.serviceTiers}
          onChange={(serviceTier) => update({ serviceTier })}
          format={tierLabel}
          validationError={forcedServiceTierError(value, connection, forcedVertexTier)}
        />
        {vertex && forcedVertexTier && (
          <p className="muted full">
            서버에서 Service Tier를 {tierLabel(forcedVertexTier)}로 제한해요. 모델 기본값도{' '}
            {tierLabel(forcedVertexTier)}로 실행돼요.
          </p>
        )}
        {(capability?.cacheModes || value.cacheMode || value.cacheTtl) && (
          <fieldset className="editor-fields full">
            <legend>프롬프트 캐시</legend>
            <ModelOptionSelect
              label="캐시 방식"
              value={value.cacheMode}
              choices={capability?.cacheModes}
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
              choices={cacheTtlAvailable ? capability?.cacheTtls : undefined}
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
        {(compatible || codex) && !capability?.cacheModes && (
          <small className="full">이 연결에서는 서비스 자체의 캐싱을 직접 제어하지 않아요.</small>
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
        <small className="full">
          모델 기본값을 선택하면 해당 옵션을 보내지 않아요. 현재 설정이 맞지 않으면 값을 변경한 뒤
          저장하세요.
        </small>
        {codex && (
          <small className="full">
            출력 목표 토큰은 Uimori의 출력 목표이며 Codex 내부 hard budget을 보장하지 않아요.
          </small>
        )}
        {optionsError && (
          <p className="error full" role="alert">
            {optionsError}
          </p>
        )}
      </div>
      <div
        className="provider-model-section full"
        data-model-section="advanced"
        hidden={section !== 'advanced'}
      >
        <ModelOptionSelect
          label="Reasoning Mode"
          value={value.reasoningMode}
          choices={capability?.reasoningModes}
          onChange={(reasoningMode) => update({ reasoningMode })}
        />
        <ModelOptionSelect
          label="Reasoning Context"
          value={value.reasoningContext}
          choices={capability?.reasoningContexts}
          onChange={(reasoningContext) => update({ reasoningContext })}
        />
        <OptionalNumber
          label="Temperature"
          value={value.temperature}
          supported={temperature}
          min={0}
          max={2}
          onChange={(temperature) => update({ temperature })}
        />
        <OptionalNumber
          label="Top P"
          value={value.topP}
          supported={capability?.topP === true}
          min={0}
          max={1}
          onChange={(topP) => update({ topP })}
        />
        {(capability?.stopSequences || value.stopSequences.length > 0) && (
          <fieldset className="editor-fields full">
            <legend>정지 문자열</legend>
            {value.stopSequences.map((stop, index) => (
              <StopSequence
                key={index}
                index={index}
                value={stop}
                supported={capability?.stopSequences === true}
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
            {capability?.stopSequences && (
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
            </small>
          </fieldset>
        )}
        {connection && !fixture && (
          <>
            {codex ? (
              <p className="full">Codex 번역은 고정된 구조화 출력 계약을 사용해요.</p>
            ) : (
              !vertex && (
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
        {(codex || vertex || fixture) && value.structuredOutput !== 'default' && (
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
        <fieldset className="editor-fields full">
          <legend>선택형 평가 도구</legend>
          <ToggleRow
            label="이 모델 프리셋에 평가 도구 4개 사용"
            checked={value.evaluationToolsEnabled}
            onChange={(evaluationToolsEnabled) => update({ evaluationToolsEnabled })}
          />
          {value.evaluationToolsEnabled && value.userOverrides?.tools === false && (
            <p className="error full" role="alert">
              도구 호출을 미지원으로 설정했어요. 평가 도구를 끄거나 지원 판단을 수정한 뒤
              저장하세요.
            </p>
          )}
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
        <details className="full">
          <summary>기능 확인과 사용자 판단</summary>
          <div className="editor-grid">
            <p className="full">
              공급자의 모델별 기능과 가격은 미확인이에요. 아래 값은 사용자가 직접 확인한 판단으로
              따로 기록하며 인증·권한을 추가하지 않아요.
            </p>
            {(['tools', 'structuredOutput'] as const).map((key, index) => (
              <label key={key}>
                {index === 0 ? '도구 호출 지원 판단' : '구조화 출력 지원 판단'}
                <select
                  aria-label={index === 0 ? '도구 호출 지원 판단' : '구조화 출력 지원 판단'}
                  value={
                    value.userOverrides?.[key] === true
                      ? 'yes'
                      : value.userOverrides?.[key] === false
                        ? 'no'
                        : 'unknown'
                  }
                  onChange={(event) =>
                    override(
                      key,
                      event.target.value === 'unknown' ? null : event.target.value === 'yes'
                    )
                  }
                >
                  <option value="unknown">미확인</option>
                  <option value="yes">사용자 확인 · 지원</option>
                  <option value="no">사용자 확인 · 미지원</option>
                </select>
              </label>
            ))}
            <label className="full">
              기능 판단 메모
              <textarea
                aria-label="기능 판단 메모"
                maxLength={2000}
                value={value.userOverrides?.note ?? ''}
                onChange={(event) => override('note', event.target.value)}
              />
            </label>
            {value.userOverrides && (
              <button
                type="button"
                className="secondary"
                onClick={() => update({ userOverrides: undefined })}
              >
                사용자 판단 지우기
              </button>
            )}
          </div>
        </details>
      </div>
    </>
  );
}
