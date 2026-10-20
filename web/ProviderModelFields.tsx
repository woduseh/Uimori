import { t, useI18n, translateMessage, formatNumber } from './i18n.js';
import { ToggleRow } from './ToggleRow.js';
import { ModelPricingEditor } from './ModelPricingEditor.js';
import { AddIcon, CloseIcon } from './ui-icons.js';
import { useEffect, useRef } from 'react';
import { isGeminiProtocol, type Connection, type VertexRequestTier } from '../core/product.js';
import {
  GEMINI_SAFETY_CATEGORIES,
  GEMINI_SAFETY_THRESHOLDS,
  type GeminiSafetyCategory,
  type GeminiSafetyThreshold,
} from '../core/gemini-safety.js';
import {
  MODEL_FAMILY_CHOICES,
  effectiveModelFamily,
  modelFamilyOptionKeys,
} from '../core/model-family.js';
import {
  PROTOCOL_OPTION_VALUES,
  protocolCacheTtls,
  protocolServiceTiers,
  supportedModels,
} from '../core/model-capabilities.js';
import { modelHints, type ModelHints } from '../core/model-hints.js';
import {
  automaticEvaluationMetadataProfile,
  type EvaluationMetadataProfile,
  type EvaluationToolOptions,
} from '../core/evaluation-tool-config.js';
import { PROVIDER_OPTIONS_MAX_CHARS } from '../core/provider-options.js';
import { TOKENIZER_PROFILES, resolveTokenizerProfile } from '../core/tokenizer-profiles.js';
import {
  forcedServiceTierError,
  modelDraftError,
  providerOptionsDraftError,
  selectModelFamily,
  type ModelDraft,
} from './provider-model-draft.js';

const geminiSafetyLabels: Record<GeminiSafetyCategory, string> = {
  get HARM_CATEGORY_HARASSMENT() {
    return t('providers.m164');
  },
  get HARM_CATEGORY_HATE_SPEECH() {
    return t('providers.m165');
  },
  get HARM_CATEGORY_SEXUALLY_EXPLICIT() {
    return t('providers.m166');
  },
  get HARM_CATEGORY_DANGEROUS_CONTENT() {
    return t('providers.m167');
  },
};
const geminiThresholdLabels: Record<GeminiSafetyThreshold, string> = {
  get OFF() {
    return t('providers.m168');
  },
  get BLOCK_NONE() {
    return t('providers.m169');
  },
  get BLOCK_ONLY_HIGH() {
    return t('providers.m170');
  },
  get BLOCK_MEDIUM_AND_ABOVE() {
    return t('providers.m171');
  },
  get BLOCK_LOW_AND_ABOVE() {
    return t('providers.m172');
  },
};
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
  get none() {
    return t('providers.m173');
  },
  get minimal() {
    return t('providers.m174');
  },
  get low() {
    return t('providers.m175');
  },
  get medium() {
    return t('providers.m176');
  },
  get high() {
    return t('providers.m177');
  },
  get xhigh() {
    return t('providers.m178');
  },
  get max() {
    return t('providers.m179');
  },
  get MINIMAL() {
    return t('providers.m174');
  },
  get LOW() {
    return t('providers.m175');
  },
  get MEDIUM() {
    return t('providers.m176');
  },
  get HIGH() {
    return t('providers.m177');
  },
};
const strengthLabel = (value: string) =>
  strengthLabels[value] ? `${strengthLabels[value]} · ${value}` : value;
const modeLabel = (value: string) =>
  value === 'adaptive' ? t('providers.m180') : value === 'disabled' ? t('providers.m181') : value;
const UNDOCUMENTED = () => t('providers.m182');
const evaluationMetadataLabels: Record<EvaluationMetadataProfile, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  deepmind: 'Google DeepMind',
  get neutral() {
    return t('providers.m183');
  },
};

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
  defaultLabel = t('providers.m184'),
  invalidMessage,
  validationError,
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
  full?: boolean;
}) {
  useI18n();
  const ref = useRef<HTMLSelectElement>(null);
  const all = vocabulary ?? choices;
  const unsendable = value !== '' && !!vocabulary && !vocabulary.includes(value);
  const undocumented = value !== '' && !unsendable && !!choices && !choices.includes(value);
  const error =
    validationError ||
    (unsendable
      ? (invalidMessage ?? t('providers.m552', { value0: label, value1: defaultLabel }))
      : '');
  useEffect(() => {
    ref.current?.setCustomValidity(translateMessage(error));
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
            {t('providers.m553', { value0: format(value) })}
          </option>
        )}
        {choices && rest.length > 0 ? (
          <>
            <optgroup label={t('providers.m186')}>{documented.map(option)}</optgroup>
            <optgroup label={t('providers.m187')}>{rest.map(option)}</optgroup>
          </>
        ) : (
          documented.map(option)
        )}
      </select>
      {error ? (
        <small className="error">{translateMessage(error)}</small>
      ) : undocumented ? (
        <small className="provider-undocumented">{UNDOCUMENTED()}</small>
      ) : null}
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
  useI18n();
  const ref = useRef<HTMLInputElement>(null),
    invalid = value !== '' && !sendable;
  const error = invalid ? t('providers.m554', { value0: label }) : '';
  useEffect(() => {
    ref.current?.setCustomValidity(translateMessage(error));
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
        placeholder={t('providers.m184')}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? (
        <small className="error">{translateMessage(error)}</small>
      ) : documented === false && value !== '' ? (
        <small className="provider-undocumented">{UNDOCUMENTED()}</small>
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
  useI18n();
  const ref = useRef<HTMLTextAreaElement>(null),
    error = sendable ? '' : t('providers.m188');
  useEffect(() => {
    ref.current?.setCustomValidity(translateMessage(error));
  }, [error]);
  return (
    <div className="provider-stop-row full">
      <label>
        {t('providers.m555', { value0: index + 1 })}
        <textarea
          ref={ref}
          aria-label={t('providers.m556', { value0: index + 1 })}
          aria-invalid={!sendable || undefined}
          maxLength={1000}
          required
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        {error && <small className="error">{translateMessage(error)}</small>}
      </label>
      <button
        type="button"
        className="secondary icon-button"
        aria-label={t('providers.m557', { value0: index + 1 })}
        title={t('providers.m557', { value0: index + 1 })}
        onClick={onRemove}
      >
        <CloseIcon size={18} aria-hidden="true" />
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
  useI18n();
  const thinking = hints.thinking;
  // A value kept from another connection's protocol stays visible so the user can clear it.
  const stale = (['thinkingLevel', 'reasoningEffort', 'outputEffort'] as const).filter(
    (field) => field !== thinking?.field && value[field] !== ''
  );
  return (
    <>
      {thinking && (
        <ModelOptionSelect
          label={t('providers.m190')}
          value={value[thinking.field]}
          choices={thinking.known}
          vocabulary={thinking.all}
          onChange={(next) => onChange({ [thinking.field]: next })}
          format={strengthLabel}
          full
        />
      )}
      {stale.map((field) => (
        <ModelOptionSelect
          key={field}
          label={t('providers.m558', { value0: field })}
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
  useI18n();
  const protocol = connection?.protocol;
  const vertex = protocol === 'vertex-gemini-v1',
    fixture = protocol === 'fixture-sse-v1',
    codex = protocol === 'codex-app-server-v1';
  const family = connection
    ? effectiveModelFamily(connection.protocol, value.modelId, value.modelFamily)
    : undefined;
  const keys = protocol ? modelFamilyOptionKeys(protocol, family) : [];
  const sends = (key: string) => keys.includes(key);
  const hints = connection ? modelHints(connection, value.modelId, value.modelFamily) : undefined;
  const capability = hints?.capability;
  const cacheTtlAvailable = value.cacheMode === 'explicit' || value.cacheMode === 'automatic';
  const optionsError =
    connection && value.modelId ? modelDraftError(value, connection, forcedVertexTier) : '';
  const providerOptionsError =
    connection && protocol === 'vercel-chat-v1' ? providerOptionsDraftError(value, connection) : '';
  const providerOptionsRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    providerOptionsRef.current?.setCustomValidity(translateMessage(providerOptionsError));
  }, [providerOptionsError]);
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
  const specified: { key: string; label: string; text: string; reset: () => void }[] = (
    [
      ['tokenizer', t('providers.m191')],
      ['inputTokenLimit', t('providers.m192')],
      ['timeoutSeconds', t('providers.m193')],
      ['thinkingMode', t('providers.m194')],
      ['verbosity', 'Verbosity'],
      ['reasoningMode', 'Reasoning Mode'],
      ['reasoningContext', 'Reasoning Context'],
      ['temperature', 'Temperature'],
      ['topP', 'Top P'],
      ['cacheMode', t('providers.m195')],
      ['cacheTtl', t('providers.m196')],
      ['providerOptions', t('providers.m197')],
    ] as const
  )
    .filter(([field]) => value[field] !== '' && !(field === 'timeoutSeconds' && fixture))
    .map(([field, label]) => ({
      key: field,
      label,
      text:
        field === 'tokenizer'
          ? (TOKENIZER_PROFILES.find((profile) => profile.id === value.tokenizer)?.label ??
            value.tokenizer)
          : field === 'providerOptions'
            ? t('providers.m198')
            : value[field],
      reset: () => update({ [field]: '' }),
    }));
  if (value.structuredOutput !== 'default')
    specified.push({
      key: 'structuredOutput',
      label: t('providers.m199'),
      text: value.structuredOutput === 'on' ? t('providers.m200') : t('providers.m201'),
      reset: () => update({ structuredOutput: 'default' }),
    });
  if (Object.keys(value.safetySettings).length > 0)
    specified.push({
      key: 'safetySettings',
      label: t('providers.m202'),
      text: t('providers.m559', { value0: Object.keys(value.safetySettings).length }),
      reset: () => update({ safetySettings: {} }),
    });
  if (value.stopSequences.length > 0)
    specified.push({
      key: 'stopSequences',
      label: t('providers.m189'),
      text: t('providers.m560', { value0: value.stopSequences.length }),
      reset: () => update({ stopSequences: [] }),
    });
  const evaluation = value.evaluationTools;
  const automaticMetadata = protocol ? automaticEvaluationMetadataProfile(protocol) : undefined;
  const automaticTokenizer = resolveTokenizerProfile({ modelId: value.modelId, connection });
  const tokenizer = TOKENIZER_PROFILES.find(
    (profile) => profile.id === (value.tokenizer || automaticTokenizer)
  );
  const setEvaluation = (next: ModelDraft['evaluationTools']) => update({ evaluationTools: next });
  return (
    <>
      <div
        className="provider-model-section full"
        data-model-section="basic"
        hidden={section !== 'basic'}
      >
        <label className="full">
          {t('providers.m203')}
          <input
            aria-label={t('providers.m203')}
            list="available-models"
            required
            value={value.modelId}
            onChange={(event) => onChange({ ...value, modelId: event.target.value })}
          />
          <datalist id="available-models">
            {modelChoices.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </datalist>
        </label>
        {connection && protocol === 'vercel-chat-v1' && (
          <label className="full">
            {t('providers.m204')}
            <select
              aria-label={t('providers.m204')}
              value={value.modelFamily}
              onChange={(event) =>
                onChange(
                  selectModelFamily(
                    value,
                    event.target.value as ModelDraft['modelFamily'],
                    connection
                  )
                )
              }
            >
              <option value="">
                {t('providers.m561', {
                  value0:
                    MODEL_FAMILY_CHOICES.find(
                      (item) => item.id === effectiveModelFamily(connection.protocol, value.modelId)
                    )?.label ?? t('providers.m206'),
                })}
              </option>
              {MODEL_FAMILY_CHOICES.map((item) => (
                <option key={item.id} value={item.id}>
                  {translateMessage(item.label)}
                </option>
              ))}
            </select>
          </label>
        )}
        <ToggleRow
          label={t('providers.m207')}
          description={t('providers.m208')}
          checked={value.enabled}
          onChange={(enabled) => update({ enabled })}
        />
        <h4 className="provider-field-heading full">{t('providers.m209')}</h4>
        <label>
          {codex ? t('providers.m210') : t('providers.m51')}
          <input
            aria-label={codex ? t('providers.m210') : t('providers.m51')}
            type="number"
            min={1}
            max={500000}
            required
            value={value.maxOutputTokens}
            onChange={(event) => update({ maxOutputTokens: event.target.value })}
          />
          {hints?.maxOutputTokens !== undefined && (
            <small>{t('providers.m562', { value0: formatNumber(hints.maxOutputTokens) })}</small>
          )}
        </label>
        {hints && <ThinkingSelect hints={hints} value={value} onChange={update} />}
        {protocol === 'anthropic-messages-v1' && (
          <label>
            {t('providers.m213')}
            <select
              aria-label={t('providers.m213')}
              value={value.executionMode}
              onChange={(event) =>
                update({ executionMode: event.target.value as ModelDraft['executionMode'] })
              }
            >
              <option value="realtime">{t('providers.m214')}</option>
              <option value="batch">{t('providers.m215')}</option>
            </select>
            <small>{t('providers.m216')}</small>
          </label>
        )}
        {protocol && (sends('serviceTier') || value.serviceTier) && (
          <ModelOptionSelect
            label={t('providers.m217')}
            value={value.serviceTier}
            choices={capability?.serviceTiers ?? protocolServiceTiers(protocol)}
            vocabulary={
              !sends('serviceTier')
                ? []
                : isGeminiProtocol(protocol)
                  ? protocolServiceTiers(protocol)
                  : undefined
            }
            onChange={(serviceTier) => update({ serviceTier })}
            format={tierLabel}
            validationError={forcedServiceTierError(value, connection, forcedVertexTier)}
          />
        )}
        {vertex && forcedVertexTier && (
          <p className="muted full">
            {t('providers.m563', {
              value0: tierLabel(forcedVertexTier),
              value1: tierLabel(forcedVertexTier),
            })}
          </p>
        )}
        <details className="provider-setting-help full">
          <summary>{t('providers.m221')}</summary>
          <p>{t('providers.m222')}</p>
          {protocol === 'vercel-chat-v1' && <p>{t('providers.m223')}</p>}
          {codex && <p>{t('providers.m224')}</p>}
        </details>
      </div>
      <div
        className="provider-model-section full"
        data-model-section="advanced"
        hidden={section !== 'advanced'}
      >
        {specified.length > 0 && (
          <details className="provider-specified-settings full">
            <summary>{t('providers.m564', { value0: specified.length })}</summary>
            <ul>
              {specified.map((item) => (
                <li key={item.key}>
                  <span>
                    {translateMessage(item.label)} ·{' '}
                    <strong>
                      {item.key === 'tokenizer' ? translateMessage(item.text) : item.text}
                    </strong>
                  </span>
                  <button
                    type="button"
                    className="secondary"
                    aria-label={t('providers.m565', { value0: item.label })}
                    onClick={item.reset}
                  >
                    {t('providers.m227')}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
        <h4 className="provider-field-heading full">{t('providers.m228')}</h4>
        <label className="full">
          {t('providers.m191')}
          <select
            aria-label={t('providers.m191')}
            value={value.tokenizer}
            onChange={(event) =>
              update({ tokenizer: event.target.value as ModelDraft['tokenizer'] })
            }
          >
            <option value="">
              {t('providers.m561', {
                value0: translateMessage(
                  TOKENIZER_PROFILES.find((profile) => profile.id === automaticTokenizer)?.label ??
                    ''
                ),
              })}
            </option>
            {TOKENIZER_PROFILES.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {translateMessage(profile.label)}
              </option>
            ))}
          </select>
          {value.tokenizer && <small>{translateMessage(tokenizer?.description ?? '')}</small>}
        </label>
        <label className="full">
          {t('providers.m192')}
          <input
            aria-label={t('providers.m192')}
            type="number"
            min={8192}
            max={1000000}
            step={1}
            placeholder="272000"
            value={value.inputTokenLimit}
            onChange={(event) => update({ inputTokenLimit: event.target.value })}
          />
          {hints?.inputTokenLimit !== undefined && (
            <small>{t('providers.m566', { value0: formatNumber(hints.inputTokenLimit) })}</small>
          )}
        </label>
        {!fixture && (
          <label>
            {t('providers.m193')}
            <input
              aria-label={t('providers.m193')}
              type="number"
              step="any"
              min={0.001}
              max={1800}
              placeholder={t('providers.m230')}
              value={value.timeoutSeconds}
              onChange={(event) => update({ timeoutSeconds: event.target.value })}
            />
          </label>
        )}
        <details className="provider-setting-help full">
          <summary>{t('providers.m231')}</summary>
          {!value.tokenizer && <p>{translateMessage(tokenizer?.description ?? '')}</p>}
          <p>{t('providers.m232')}</p>
          <p>{t('providers.m233')}</p>
        </details>
        <h4 className="provider-field-heading full">{t('providers.m234')}</h4>
        {protocol === 'vercel-chat-v1' && (
          <details className="full provider-extra-options" open={!!value.providerOptions}>
            <summary>{t('providers.m197')}</summary>
            <label>
              providerOptions (JSON)
              <textarea
                ref={providerOptionsRef}
                aria-label="providerOptions (JSON)"
                aria-invalid={providerOptionsError ? true : undefined}
                maxLength={PROVIDER_OPTIONS_MAX_CHARS}
                rows={5}
                spellCheck={false}
                value={value.providerOptions}
                onChange={(event) => update({ providerOptions: event.target.value })}
                placeholder={'{\n  "gateway": {\n    "only": ["openai"]\n  }\n}'}
              />
              <small>{t('providers.m235')}</small>
            </label>
          </details>
        )}
        {/* Options the protocol cannot send stay visible while a value is set, so it can be cleared. */}
        {(hints?.thinkingModes || value.thinkingMode) && (
          <ModelOptionSelect
            label={t('providers.m194')}
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
        {connection && !fixture && !codex && sends('structuredOutput') && (
          <label>
            {t('providers.m199')}
            <select
              aria-label={t('providers.m199')}
              value={value.structuredOutput}
              onChange={(event) =>
                update({ structuredOutput: event.target.value as ModelDraft['structuredOutput'] })
              }
            >
              <option value="default">{t('providers.m236')}</option>
              <option value="on">{t('providers.m200')}</option>
              <option value="off">{t('providers.m201')}</option>
            </select>
          </label>
        )}
        {protocol && !sends('structuredOutput') && value.structuredOutput !== 'default' && (
          <p className="error full">
            {t('providers.m237')}
            <button
              type="button"
              className="secondary"
              onClick={() => update({ structuredOutput: 'default' })}
            >
              {t('providers.m238')}
            </button>
          </p>
        )}
        {(sends('stopSequences') || value.stopSequences.length > 0) && (
          <details className="provider-stop-sequences full" open={value.stopSequences.length > 0}>
            <summary>{t('providers.m189')}</summary>
            <div className="provider-stop-sequences-body">
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
                  className="secondary provider-stop-add"
                  disabled={value.stopSequences.length >= 4}
                  onClick={() => update({ stopSequences: [...value.stopSequences, ''] })}
                >
                  <AddIcon size={18} aria-hidden="true" />
                  {t('providers.m239')}
                </button>
              )}
              <small className="full">
                {t('providers.m567', {
                  value0: capability?.stopSequences === false ? ` ${UNDOCUMENTED()}` : '',
                })}
              </small>
            </div>
          </details>
        )}
        {(sends('safetySettings') || Object.keys(value.safetySettings).length > 0) && (
          <details
            className="provider-stop-sequences full"
            open={Object.keys(value.safetySettings).length > 0}
          >
            <summary>
              {t('providers.m568', { count: Object.keys(value.safetySettings).length })}
            </summary>
            <div className="provider-stop-sequences-body editor-fields">
              {sends('safetySettings') ? (
                <>
                  <p className="muted full">{t('providers.m241')}</p>
                  {GEMINI_SAFETY_CATEGORIES.map((category) => (
                    <label key={category}>
                      {geminiSafetyLabels[category]}
                      <select
                        aria-label={t('providers.m569', { value0: geminiSafetyLabels[category] })}
                        value={value.safetySettings[category] ?? ''}
                        onChange={(event) => {
                          const next = { ...value.safetySettings };
                          if (event.target.value)
                            next[category] = event.target.value as GeminiSafetyThreshold;
                          else delete next[category];
                          update({ safetySettings: next });
                        }}
                      >
                        <option value="">{t('providers.m242')}</option>
                        {GEMINI_SAFETY_THRESHOLDS.map((threshold) => (
                          <option key={threshold} value={threshold}>
                            {geminiThresholdLabels[threshold]}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                  <small className="full">{t('providers.m243')}</small>
                </>
              ) : (
                <p className="error full">{t('providers.m244')}</p>
              )}
            </div>
          </details>
        )}
        {protocol && (sends('cacheMode') || value.cacheMode || value.cacheTtl) && (
          <fieldset className="editor-fields full">
            <legend>{t('providers.m245')}</legend>
            <ModelOptionSelect
              label={t('providers.m195')}
              value={value.cacheMode}
              choices={capability?.cacheModes}
              vocabulary={sends('cacheMode') ? PROTOCOL_OPTION_VALUES.cacheMode : []}
              onChange={(cacheMode) => update({ cacheMode })}
              defaultLabel={t('providers.m246')}
              format={(mode) =>
                mode === 'disabled'
                  ? t('providers.m247')
                  : mode === 'explicit'
                    ? t('providers.m248')
                    : mode === 'automatic'
                      ? t('providers.m249')
                      : mode
              }
            />
            <ModelOptionSelect
              label={t('providers.m196')}
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
              defaultLabel={t('providers.m236')}
              format={(ttl) =>
                ttl === '5m'
                  ? t('providers.m250')
                  : ttl === '30m'
                    ? t('providers.m251')
                    : ttl === '1h'
                      ? t('providers.m252')
                      : ttl
              }
              invalidMessage={!cacheTtlAvailable ? t('providers.m253') : undefined}
            />
            {value.cacheMode === 'disabled' && (
              <small className="full">{t('providers.m254')}</small>
            )}
            {value.cacheTtl === '1h' && <small className="full">{t('providers.m255')}</small>}
            {value.cacheMode === 'automatic' && (
              <details className="provider-setting-help full">
                <summary>{t('providers.m256')}</summary>
                <p>{t('providers.m257')}</p>
              </details>
            )}
          </fieldset>
        )}
        <h4 className="provider-field-heading full">{t('providers.m258')}</h4>
        <fieldset className="editor-fields full">
          <legend>{t('providers.m259')}</legend>
          <ToggleRow
            label={t('providers.m260')}
            checked={value.evaluationToolsEnabled}
            onChange={(evaluationToolsEnabled) => update({ evaluationToolsEnabled })}
          />
          {value.evaluationToolsEnabled && (
            <>
              <label className="full">
                {t('providers.m261')}
                {automaticMetadata ? (
                  <input
                    aria-label={t('providers.m261')}
                    readOnly
                    value={t('providers.m602', {
                      value0: evaluationMetadataLabels[automaticMetadata],
                    })}
                  />
                ) : (
                  <select
                    aria-label={t('providers.m261')}
                    value={evaluation.metadataProfile ?? 'neutral'}
                    onChange={(event) =>
                      setEvaluation({
                        ...evaluation,
                        metadataProfile: event.target.value as EvaluationMetadataProfile,
                      })
                    }
                  >
                    {Object.entries(evaluationMetadataLabels).map(([profile, label]) => (
                      <option key={profile} value={profile}>
                        {label}
                      </option>
                    ))}
                  </select>
                )}
                <small>{t('providers.m262')}</small>
              </label>
              <label className="full">
                {t('providers.m263')}
                <select
                  aria-label={t('providers.m263')}
                  value={evaluation.contextMode}
                  onChange={(event) =>
                    setEvaluation({
                      ...evaluation,
                      contextMode: event.target.value as EvaluationToolOptions['contextMode'],
                    })
                  }
                >
                  <option value="model-selected">{t('providers.m264')}</option>
                  <option value="preloaded" disabled={capability?.forcedTools === false}>
                    {t('providers.m571', {
                      unsupported: String(capability?.forcedTools === false),
                    })}
                  </option>
                </select>
                {capability?.forcedTools === false && <small>{t('providers.m267')}</small>}
                <small>{t('providers.m268')}</small>
              </label>
              {evaluation.contextMode === 'preloaded' && (
                <label className="full">
                  {t('providers.m269')}
                  <select
                    aria-label={t('providers.m269')}
                    value={evaluation.approvalReasoningMode}
                    onChange={(event) =>
                      setEvaluation({
                        ...evaluation,
                        approvalReasoningMode: event.target
                          .value as EvaluationToolOptions['approvalReasoningMode'],
                      })
                    }
                  >
                    <option value="configured">{t('providers.m270')}</option>
                    <option value="economized">{t('providers.m271')}</option>
                  </select>
                  <small>{t('providers.m272')}</small>
                </label>
              )}
            </>
          )}
          <small className="full">{t('providers.m273')}</small>
        </fieldset>
        <h4 className="provider-field-heading full">{t('providers.m274')}</h4>
        <ModelPricingEditor
          value={value}
          connection={connection}
          forcedVertexTier={forcedVertexTier}
          onChange={(pricing) => update({ pricing })}
        />
      </div>
      {optionsError && (
        <p className="error full" role="alert">
          {translateMessage(optionsError)}
        </p>
      )}
    </>
  );
}
