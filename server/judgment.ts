import { createHash } from 'node:crypto';
import { estimateContextTokens } from '../core/context-budget.js';
import type { Json, ProviderResult, WireRecord } from '../core/transport.js';
import type { JevSettings } from '../core/jev-provider.js';
import { ProviderBodyLimitError, readProviderBody } from '../core/provider-fetch.js';
import {
  validJudgmentTarget,
  type JudgmentTarget,
  type JudgmentRequest,
} from '../core/judgment.js';
import {
  prepareDecisionRequest,
  parseDecisionResponse,
  decisionAuthorization,
  readDecisionRequest,
} from './judgment-decisions.js';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
export const DEFAULT_JUDGMENT_TARGET = {
  provider: 'typesafe',
  connectionId: 'typesafe-judgment',
  modelId: JEV_MODEL,
  endpoint: JEV_ENDPOINT,
} as const satisfies JudgmentTarget;
// https://docs.typesafe.ai/models (2026-09-20). Host estimates use o200k_base,
// not a guaranteed provider tokenizer; explicit provider budget failures also remain fatal.
export const JEV_REQUEST_TOKEN_LIMIT = 64_000;
export const JEV_STATE_QUESTION_TOKEN_LIMIT = 32_000;
export const JEV_LONG_CONTEXT_TOKEN_LIMIT = 262_000;
// https://docs.typesafe.ai/api (2026-10-08): maximum options per Choice.
export const JEV_CHOICE_OPTION_LIMIT = 255;
/** Text estimates only: the provider reports image tokens after evaluation. */
export function jevRequestBudget(request: JudgmentRequest) {
  const state = estimateContextTokens(request.state);
  const questions = Object.values(request.questions).map((question) =>
    estimateContextTokens(question)
  );
  return {
    requestTokens: state + questions.reduce((sum, tokens) => sum + tokens, 0),
    questionTokens: state + Math.max(0, ...questions),
  };
}

export function jevRequestFits(
  request: JudgmentRequest,
  maxInputTokens: number | null = null,
  longContext = false
): boolean {
  const budget = jevRequestBudget(request);
  return (
    budget.requestTokens <=
      (longContext ? JEV_LONG_CONTEXT_TOKEN_LIMIT : JEV_REQUEST_TOKEN_LIMIT) &&
    budget.questionTokens <=
      (longContext ? JEV_LONG_CONTEXT_TOKEN_LIMIT : JEV_STATE_QUESTION_TOKEN_LIMIT) &&
    (maxInputTokens === null || budget.requestTokens <= maxInputTokens)
  );
}
export function judgmentLimits(target?: JudgmentTarget, longContext = false) {
  if (!target || target.provider === 'typesafe' || target.provider === 'typesafe-compatible') {
    return {
      maxQuestions: 2000,
      maxOptions: JEV_CHOICE_OPTION_LIMIT,
      requestTokens: longContext ? JEV_LONG_CONTEXT_TOKEN_LIMIT : JEV_REQUEST_TOKEN_LIMIT,
      questionTokens: longContext ? JEV_LONG_CONTEXT_TOKEN_LIMIT : JEV_STATE_QUESTION_TOKEN_LIMIT,
    };
  }
  return target.provider === 'gemini'
    ? {
        maxQuestions: 1000,
        maxOptions: JEV_CHOICE_OPTION_LIMIT,
        requestTokens: 262144,
        questionTokens: 262144,
      }
    : {
        maxQuestions: target.provider === 'openai-compatible' ? 128 : 400,
        maxOptions: JEV_CHOICE_OPTION_LIMIT,
        requestTokens: 64000,
        questionTokens: 32000,
      };
}
export function judgmentRequestFits(
  request: JudgmentRequest,
  target?: JudgmentTarget,
  maxInputTokens: number | null = null,
  longContext = false
) {
  const limits = judgmentLimits(target, longContext);
  const budget = jevRequestBudget(request);
  return (
    Object.keys(request.questions).length <= limits.maxQuestions &&
    budget.requestTokens <= limits.requestTokens &&
    budget.questionTokens <= limits.questionTokens &&
    (maxInputTokens === null || budget.requestTokens <= maxInputTokens)
  );
}
export type JudgmentResult = {
  scores: Record<string, number>;
  choices: Record<
    string,
    { choice: string; probabilities: Record<string, number>; confidence: number | null }
  >;
  usage: ProviderResult['usage'];
  attemptId: string;
};
export type JudgmentHooks = {
  target?: JudgmentTarget;
  settings?: Pick<JevSettings, 'images' | 'longContext'>;
  readImage?: (hash: string) => Uint8Array | undefined;
  kind?: NonNullable<WireRecord['judgment']>['kind'];
  signal: AbortSignal;
  onAttemptStart: (wire: WireRecord) => string | Promise<string>;
  onAttemptFinish: (id: string, result: ProviderResult) => void | Promise<void>;
  /** Only the server supplies this. It is neither serialized nor accepted from a card. */
  credential?: () => string | undefined | Promise<string | undefined>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  onStarted?: () => void;
};
export class JudgmentError extends Error {
  constructor(
    readonly code: string,
    readonly usage?: ProviderResult['usage'],
    readonly attempted = false
  ) {
    super(code);
    this.name = 'JevError';
  }
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const probability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const emptyUsage = (): ProviderResult['usage'] => ({
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  raw: null,
  priceRevision: null,
});

/** Official typed API contract: https://docs.typesafe.ai/api (checked 2026-09-19).
 * One attempt, no automatic retry. A cancelled/uncertain paid call remains a recorded terminal.
 */
async function executeJudgmentAttempt(
  request: JudgmentRequest,
  inputHash: string,
  maxInputTokens: number | null,
  hooks: JudgmentHooks
): Promise<JudgmentResult> {
  if (hooks.signal.aborted) throw new JudgmentError('JEV_CANCELLED');
  if (
    !/^[a-f0-9]{64}$/u.test(inputHash) ||
    !Object.keys(request.questions).length ||
    Object.keys(request.questions).length > 2000 ||
    Object.values(request.questions).some((question) => {
      if (question.type !== 'choice') return false;
      const optionCount = Object.keys(object(question.criteria)).length;
      return optionCount === 0 || optionCount > JEV_CHOICE_OPTION_LIMIT;
    })
  )
    throw new JudgmentError('JEV_REQUEST_INVALID');
  const target = hooks.target ?? DEFAULT_JUDGMENT_TARGET;
  const typesafe = target.provider === 'typesafe' || target.provider === 'typesafe-compatible';
  const wire = buildJudgmentWire(request, inputHash, hooks);
  if (!judgmentRequestFits(request, target, maxInputTokens, hooks.settings?.longContext))
    throw new JudgmentError('JEV_INPUT_BUDGET');
  if (request.assets && Object.keys(request.assets).length && !hooks.settings?.images)
    throw new JudgmentError('JEV_IMAGES_DISABLED');
  const key = await (
    hooks.credential ??
    (() => (target.provider === 'typesafe' ? process.env.TYPESAFE_API_KEY : undefined))
  )();
  if (!key || /[\r\n]/u.test(key)) throw new JudgmentError('JEV_CREDENTIAL_REQUIRED');
  if (hooks.signal.aborted) throw new JudgmentError('JEV_CANCELLED');
  const encoded = JSON.stringify(wire.body);
  const attemptId = await hooks.onAttemptStart(wire);
  hooks.onStarted?.();
  const controller = new AbortController();
  const abort = () => controller.abort();
  hooks.signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), hooks.timeoutMs ?? 60_000);
  let result: ProviderResult = {
    status: 'error',
    text: '',
    toolCalls: [],
    refusal: null,
    error: { code: 'JEV_EXECUTION_FAILED' },
    usage: emptyUsage(),
    opaqueState: null,
  };
  let scores: Record<string, number> | undefined;
  const choices: JudgmentResult['choices'] = Object.create(null);
  try {
    if (hooks.signal.aborted) throw new JudgmentError('JEV_CANCELLED');
    const response = await (hooks.fetch ?? fetch)(target.endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        ...wire.headers,
        ...(typesafe ? { authorization: `Bearer ${key}` } : decisionAuthorization(target, key)),
      },
      body: encoded,
      signal: controller.signal,
    });
    if (!response.body)
      throw new JudgmentError(response.ok ? 'JEV_RESPONSE_INVALID' : `JEV_HTTP_${response.status}`);
    let responseText: string;
    try {
      responseText = (
        await readProviderBody(response, controller.signal, 2 * 1024 * 1024)
      ).toString('utf8');
    } catch (error) {
      if (error instanceof ProviderBodyLimitError) throw new JudgmentError('JEV_RESPONSE_LIMIT');
      throw error;
    }
    if (!response.ok) {
      let errorType: unknown;
      try {
        const payload = object(JSON.parse(responseText));
        errorType =
          payload.error_type ??
          object(payload.error).error_type ??
          object(payload.detail).error_type;
      } catch {
        // Non-JSON provider errors retain their HTTP status.
      }
      throw new JudgmentError(
        errorType === 'max_tokens_exceeded' ? 'JEV_INPUT_BUDGET' : `JEV_HTTP_${response.status}`
      );
    }
    const payload = object(JSON.parse(responseText)),
      answers = object(payload.answers),
      usage = object(payload.usage);
    result.usage = {
      inputTokens:
        Number.isSafeInteger(usage.input_tokens) && Number(usage.input_tokens) >= 0
          ? Number(usage.input_tokens)
          : null,
      outputTokens:
        Number.isSafeInteger(usage.output_tokens) && Number(usage.output_tokens) >= 0
          ? Number(usage.output_tokens)
          : null,
      costUsd: null,
      raw: {
        input_tokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : null,
        output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : null,
      },
      priceRevision: null,
    };
    if (!typesafe) {
      const parsed = parseDecisionResponse(payload, request, target, hooks.kind);
      scores = parsed.scores;
      Object.assign(choices, parsed.choices);
      result.usage = parsed.usage;
    } else {
      if (
        typeof payload.model !== 'string' ||
        Object.keys(answers).length !== Object.keys(request.questions).length
      )
        throw new JudgmentError('JEV_RESPONSE_INVALID');
      scores = Object.create(null) as Record<string, number>;
      for (const name of Object.keys(request.questions)) {
        const answer = object(answers[name]);
        const question = request.questions[name];
        if (question.type === 'noul') {
          if (answer.type !== 'noul' || !probability(answer.noul))
            throw new JudgmentError('JEV_RESPONSE_INVALID');
          scores[name] = answer.noul;
        } else {
          const probabilities = object(answer.probabilities);
          const keys = Object.keys(question.criteria);
          const selected =
            typeof answer.choice === 'string' ? probabilities[answer.choice] : undefined;
          const tolerant = target.provider === 'typesafe' && hooks.kind === 'image-selection';
          if (
            answer.type !== 'choice' ||
            typeof answer.choice !== 'string' ||
            !keys.includes(answer.choice) ||
            !probability(selected) ||
            keys.some(
              (key) =>
                probability(probabilities[key]) &&
                Number(probabilities[key]) > Number(selected) + 0.000001
            ) ||
            (!tolerant &&
              (!probability(answer.confidence) ||
                Object.keys(probabilities).length !== keys.length ||
                keys.some((key) => !probability(probabilities[key])) ||
                Math.abs(keys.reduce((sum, key) => sum + Number(probabilities[key]), 0) - 1) >
                  0.01))
          )
            throw new JudgmentError('JEV_RESPONSE_INVALID');
          choices[name] = {
            choice: answer.choice,
            confidence: probability(answer.confidence) ? answer.confidence : null,
            probabilities: tolerant
              ? Object.fromEntries(
                  keys.flatMap((key) =>
                    probability(probabilities[key]) ? [[key, Number(probabilities[key])]] : []
                  )
                )
              : (probabilities as Record<string, number>),
          };
        }
      }
    }
    if (controller.signal.aborted) throw new JudgmentError('JEV_CANCELLED');
    result = { ...result, status: 'completed', text: responseText, error: null };
  } catch (error) {
    const cancelled = hooks.signal.aborted;
    const adapterError = error as { code?: unknown; usage?: ProviderResult['usage'] };
    if (adapterError?.usage) result.usage = adapterError.usage;
    result = {
      ...result,
      status: cancelled ? 'cancelled' : 'error',
      error: {
        code: cancelled
          ? 'JEV_CANCELLED'
          : controller.signal.aborted
            ? 'JEV_TIMEOUT'
            : error instanceof JudgmentError
              ? error.code
              : typeof adapterError?.code === 'string'
                ? adapterError.code
                : 'JEV_EXECUTION_FAILED',
      },
    };
  } finally {
    clearTimeout(timeout);
    hooks.signal.removeEventListener('abort', abort);
  }
  if (target.provider !== 'typesafe' && result.error?.code.startsWith('JEV_')) {
    result.error.code = result.error.code.replace(/^JEV_/u, 'JUDGMENT_');
  }
  try {
    await hooks.onAttemptFinish(attemptId, result);
  } catch {
    throw new JudgmentError('JEV_ATTEMPT_FINISH_FAILED', result.usage, true);
  }
  if (result.status !== 'completed' || !scores)
    throw new JudgmentError(result.error?.code ?? 'JEV_EXECUTION_FAILED', result.usage, true);
  return { scores, choices, usage: result.usage, attemptId };
}

export async function executeJudgment(
  request: JudgmentRequest,
  inputHash: string,
  maxInputTokens: number | null,
  hooks: JudgmentHooks
): Promise<JudgmentResult> {
  try {
    return await executeJudgmentAttempt(request, inputHash, maxInputTokens, hooks);
  } catch (error) {
    if (!(error instanceof JudgmentError) && hooks.target?.provider !== 'typesafe') {
      const adapterError = error as { code?: unknown; usage?: ProviderResult['usage'] };
      if (typeof adapterError?.code === 'string' && adapterError.code.startsWith('JUDGMENT_')) {
        throw new JudgmentError(adapterError.code, adapterError.usage);
      }
    }
    if (
      hooks.target &&
      hooks.target.provider !== 'typesafe' &&
      error instanceof JudgmentError &&
      error.code.startsWith('JEV_')
    ) {
      throw new JudgmentError(
        error.code.replace(/^JEV_/u, 'JUDGMENT_'),
        error.usage,
        error.attempted
      );
    }
    throw error;
  }
}

export type { JudgmentRequest, JudgmentTarget } from '../core/judgment.js';

export function targetFromJudgmentWire(wire: WireRecord): JudgmentTarget | null {
  const provider =
    wire.protocol === 'typesafe-systemone-v1'
      ? 'typesafe'
      : wire.protocol === 'typesafe-compatible-systemone-v1'
        ? 'typesafe-compatible'
        : wire.protocol === 'openai-decisions-v1'
          ? 'openai'
          : wire.protocol === 'openai-compatible-decisions-v1'
            ? 'openai-compatible'
            : wire.protocol === 'gemini-decisions-v1'
              ? 'gemini'
              : null;
  if (!provider) return null;
  const target: JudgmentTarget = {
    provider,
    connectionId: wire.connectionId,
    modelId: wire.modelId,
    endpoint: wire.url,
  };
  return validJudgmentTarget(target) ? target : null;
}

export function readJudgmentRequest(wire: WireRecord): JudgmentRequest | null {
  const target = targetFromJudgmentWire(wire);
  if (!target) return null;
  if (target.provider === 'typesafe' || target.provider === 'typesafe-compatible') {
    const body = wire.body as Record<string, Json>;
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.model !== target.modelId)
      return null;
    const { model: _model, ...request } = body;
    if (
      Object.keys(request).some((key) => !['state', 'questions', 'assets'].includes(key)) ||
      !Object.hasOwn(request, 'state') ||
      !request.questions ||
      typeof request.questions !== 'object' ||
      Array.isArray(request.questions)
    )
      return null;
    const questions = request.questions as Record<string, unknown>;
    if (
      !Object.keys(questions).length ||
      Object.values(questions).some((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
        const question = value as Record<string, unknown>;
        if (!Object.hasOwn(question, 'instructions')) return true;
        if (question.type === 'noul')
          return Object.keys(question).some((key) => !['type', 'instructions'].includes(key));
        return (
          question.type !== 'choice' ||
          !question.criteria ||
          typeof question.criteria !== 'object' ||
          Array.isArray(question.criteria) ||
          Object.keys(question).some(
            (key) => !['type', 'instructions', 'criteria'].includes(key)
          ) ||
          Object.values(question.criteria).some(
            (value) => value !== null && typeof value !== 'string'
          )
        );
      })
    )
      return null;
    if (
      request.assets !== undefined &&
      (!request.assets ||
        typeof request.assets !== 'object' ||
        Array.isArray(request.assets) ||
        Object.values(request.assets).some((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
          const asset = value as Record<string, unknown>;
          return (
            asset.type !== 'image' ||
            (asset.format !== 'jpeg' && asset.format !== 'png') ||
            typeof asset.data_base64 !== 'string' ||
            Object.keys(asset).some((key) => !['type', 'format', 'data_base64'].includes(key))
          );
        }))
    )
      return null;
    return request as JudgmentRequest;
  }
  return readDecisionRequest(wire);
}

export function buildJudgmentWire(
  request: JudgmentRequest,
  inputHash: string,
  hooks: Pick<JudgmentHooks, 'target' | 'kind' | 'settings'>
): WireRecord {
  const target = hooks.target ?? DEFAULT_JUDGMENT_TARGET;
  if (!target.endpoint) throw new JudgmentError('JUDGMENT_CONNECTION_UNAVAILABLE');
  if (!validJudgmentTarget(target)) throw new JudgmentError('JUDGMENT_REQUEST_INVALID');
  const typesafe = target.provider === 'typesafe' || target.provider === 'typesafe-compatible';
  const prepared = typesafe
    ? {
        body: { model: target.modelId, ...request } as unknown as Json,
        headers: {} as Record<string, string>,
      }
    : prepareDecisionRequest(request, target);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...prepared.headers,
  };
  if (typesafe && hooks.settings?.longContext)
    headers['TypeSafe-Danger-Zone-Long-Context'] = 'true';
  if (typesafe && request.assets && Object.keys(request.assets).length)
    headers['TypeSafe-Danger-Zone-Images'] = 'true';
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const protocol =
    target.provider === 'typesafe'
      ? 'typesafe-systemone-v1'
      : target.provider === 'typesafe-compatible'
        ? 'typesafe-compatible-systemone-v1'
        : target.provider === 'openai'
          ? 'openai-decisions-v1'
          : target.provider === 'gemini'
            ? 'gemini-decisions-v1'
            : 'openai-compatible-decisions-v1';
  return {
    connectionId: target.connectionId,
    protocol,
    role:
      hooks.kind === 'illustration-content'
        ? 'illustration'
        : hooks.kind === 'main-refusal'
          ? 'main'
          : hooks.kind === 'translation-refusal'
            ? 'translation'
            : hooks.kind === 'image-selection'
              ? 'image'
              : 'context',
    modelId: target.modelId,
    method: 'POST',
    url: target.endpoint,
    headers,
    body: prepared.body,
    bodySha256: digest(JSON.stringify(prepared.body)),
    stablePrefixSha256: digest(JSON.stringify(request.questions)),
    judgment: { kind: hooks.kind ?? 'lore-selection', inputHash },
  };
}
