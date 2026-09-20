import { createHash } from 'node:crypto';
import { estimateContextTokens } from '../core/context-budget.js';
import type { Json, ProviderResult, WireRecord } from '../core/transport.js';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
// https://docs.typesafe.ai/models (2026-09-20). Host estimates use o200k_base,
// not a guaranteed provider tokenizer; explicit provider budget failures also remain fatal.
export const JEV_REQUEST_TOKEN_LIMIT = 64_000;
export const JEV_STATE_QUESTION_TOKEN_LIMIT = 32_000;
export type JevQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> };
export type JevRequest = { state: Json; questions: Record<string, JevQuestion> };
export type JevResult = {
  scores: Record<string, number>;
  choices: Record<
    string,
    { choice: string; probabilities: Record<string, number>; confidence: number }
  >;
  usage: ProviderResult['usage'];
  attemptId: string;
};
export type JevHooks = {
  kind?: 'lore-selection' | 'translation-refusal' | 'image-selection' | 'main-refusal';
  signal: AbortSignal;
  onAttemptStart: (wire: WireRecord) => string | Promise<string>;
  onAttemptFinish: (id: string, result: ProviderResult) => void | Promise<void>;
  /** Only the server supplies this. It is neither serialized nor accepted from a card. */
  credential?: () => string | undefined | Promise<string | undefined>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  onStarted?: () => void;
};
export class JevError extends Error {
  constructor(
    readonly code: string,
    readonly usage?: ProviderResult['usage'],
    readonly attempted = false
  ) {
    super(code);
    this.name = 'JevError';
  }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
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
export async function executeJevJudgment(
  request: JevRequest,
  inputHash: string,
  maxInputTokens: number | null,
  hooks: JevHooks
): Promise<JevResult> {
  if (hooks.signal.aborted) throw new JevError('JEV_CANCELLED');
  if (
    !/^[a-f0-9]{64}$/u.test(inputHash) ||
    !Object.keys(request.questions).length ||
    Object.keys(request.questions).length > 2000
  )
    throw new JevError('JEV_REQUEST_INVALID');
  const body = { model: JEV_MODEL, ...request };
  const stateTokens = estimateContextTokens(request.state);
  const questionTokens = Object.values(request.questions).map((question) =>
    estimateContextTokens(question)
  );
  if (
    stateTokens + Math.max(...questionTokens) > JEV_STATE_QUESTION_TOKEN_LIMIT ||
    stateTokens + questionTokens.reduce((sum, tokens) => sum + tokens, 0) >
      JEV_REQUEST_TOKEN_LIMIT ||
    (maxInputTokens !== null && estimateContextTokens(body) > maxInputTokens)
  )
    throw new JevError('JEV_INPUT_BUDGET');
  const key = await (hooks.credential ?? (() => process.env.TYPESAFE_API_KEY))();
  if (!key || /[\r\n]/u.test(key)) throw new JevError('JEV_CREDENTIAL_REQUIRED');
  if (hooks.signal.aborted) throw new JevError('JEV_CANCELLED');
  const encoded = JSON.stringify(body);
  const wire: WireRecord = {
    connectionId: 'typesafe-judgment',
    protocol: 'typesafe-systemone-v1',
    role:
      hooks.kind === 'main-refusal'
        ? 'main'
        : hooks.kind === 'translation-refusal'
          ? 'translation'
          : hooks.kind === 'image-selection'
            ? 'image'
            : 'context',
    modelId: JEV_MODEL,
    method: 'POST',
    url: JEV_ENDPOINT,
    headers: { 'content-type': 'application/json' },
    body: body as unknown as Json,
    bodySha256: digest(encoded),
    stablePrefixSha256: digest(JSON.stringify(request.questions)),
    judgment: { kind: hooks.kind ?? 'lore-selection', inputHash },
  };
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
  const choices: JevResult['choices'] = Object.create(null);
  try {
    if (hooks.signal.aborted) throw new JevError('JEV_CANCELLED');
    const response = await (hooks.fetch ?? fetch)(JEV_ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: encoded,
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    if (!reader)
      throw new JevError(response.ok ? 'JEV_RESPONSE_INVALID' : `JEV_HTTP_${response.status}`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new JevError('JEV_RESPONSE_LIMIT');
      }
      chunks.push(part.value);
    }
    const responseText = Buffer.concat(chunks).toString('utf8');
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
      throw new JevError(
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
    if (
      typeof payload.model !== 'string' ||
      Object.keys(answers).length !== Object.keys(request.questions).length
    )
      throw new JevError('JEV_RESPONSE_INVALID');
    scores = Object.create(null) as Record<string, number>;
    for (const name of Object.keys(request.questions)) {
      const answer = object(answers[name]);
      const question = request.questions[name];
      if (question.type === 'noul') {
        if (answer.type !== 'noul' || !probability(answer.noul))
          throw new JevError('JEV_RESPONSE_INVALID');
        scores[name] = answer.noul;
      } else {
        const probabilities = object(answer.probabilities);
        const keys = Object.keys(question.criteria);
        if (
          answer.type !== 'choice' ||
          typeof answer.choice !== 'string' ||
          !keys.includes(answer.choice) ||
          !probability(answer.confidence) ||
          Object.keys(probabilities).length !== keys.length ||
          keys.some((key) => !probability(probabilities[key])) ||
          Math.abs(keys.reduce((sum, key) => sum + Number(probabilities[key]), 0) - 1) > 0.01 ||
          keys.some(
            (key) =>
              Number(probabilities[key]) > Number(probabilities[answer.choice as string]) + 0.000001
          )
        )
          throw new JevError('JEV_RESPONSE_INVALID');
        choices[name] = {
          choice: answer.choice,
          confidence: answer.confidence,
          probabilities: probabilities as Record<string, number>,
        };
      }
    }
    if (controller.signal.aborted) throw new JevError('JEV_CANCELLED');
    result = { ...result, status: 'completed', text: responseText, error: null };
  } catch (error) {
    const cancelled = hooks.signal.aborted;
    result = {
      ...result,
      status: cancelled ? 'cancelled' : 'error',
      error: {
        code: cancelled
          ? 'JEV_CANCELLED'
          : controller.signal.aborted
            ? 'JEV_TIMEOUT'
            : error instanceof JevError
              ? error.code
              : 'JEV_EXECUTION_FAILED',
      },
    };
  } finally {
    clearTimeout(timeout);
    hooks.signal.removeEventListener('abort', abort);
  }
  try {
    await hooks.onAttemptFinish(attemptId, result);
  } catch {
    throw new JevError('JEV_ATTEMPT_FINISH_FAILED', result.usage, true);
  }
  if (result.status !== 'completed' || !scores)
    throw new JevError(result.error?.code ?? 'JEV_EXECUTION_FAILED', result.usage, true);
  return { scores, choices, usage: result.usage, attemptId };
}
