import { isDeepStrictEqual } from 'node:util';
import type { JudgmentQuestion, JudgmentRequest, JudgmentTarget } from '../core/judgment.js';
import type { Json, ProviderResult, WireRecord } from '../core/transport.js';
import type { JudgmentHooks, JudgmentResult } from './judgment.js';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const imageLabel = '\nImage reference: ';

function decodeText(text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return text;
  }
}

// Preserve plain prose and disambiguate literal strings that also parse as JSON.
function encodeText(value: Json): string {
  if (typeof value === 'string' && value && decodeText(value) === value) return value;
  return JSON.stringify(value);
}

function requestInvalid(): never {
  throw Object.assign(new Error('JUDGMENT_REQUEST_INVALID'), { code: 'JUDGMENT_REQUEST_INVALID' });
}

export function decisionAuthorization(target: JudgmentTarget, key: string): Record<string, string> {
  return target.provider === 'gemini'
    ? { 'x-goog-api-key': key }
    : { authorization: `Bearer ${key}` };
}

// REST contracts checked 2026-11-17:
// https://developers.openai.com/api/reference/resources/decisions/methods/create
// https://aistudio.google.com/docs/decisions-api
export function prepareDecisionRequest(
  request: JudgmentRequest,
  target: JudgmentTarget
): { body: Json; headers: Record<string, string> } {
  const gemini = target.provider === 'gemini';
  const questions = Object.entries(request.questions);
  if (questions.length < 1 || questions.length > (gemini ? 1000 : 400)) requestInvalid();
  for (const [name, question] of questions) {
    if (gemini && !/^[A-Za-z0-9_-]{1,64}$/u.test(name)) requestInvalid();
    if (question.type === 'choice') {
      const options = Object.keys(question.criteria);
      if (options.length < 2 || options.length > 255) requestInvalid();
      if (
        gemini &&
        options.some(
          (option) =>
            !option.length ||
            [...option].length > 128 ||
            Buffer.byteLength(option) > 512 ||
            option.trim() !== option ||
            /[\p{Cc}\p{Zl}\p{Zp}]|[^\S ]/u.test(option)
        )
      )
        requestInvalid();
    }
  }

  const textPart = (value: string): Json => ({ type: gemini ? 'text' : 'input_text', text: value });
  const state = encodeText(request.state);
  const parts = [textPart(state)];
  for (const [reference, asset] of Object.entries(request.assets ?? {})) {
    if (!reference || !asset.data_base64) requestInvalid();
    const mime = `image/${asset.format}`;
    // Gemini concatenates adjacent text blocks without separators.
    parts.push(
      textPart(imageLabel + reference),
      gemini
        ? { type: 'image', mime_type: mime, data: asset.data_base64 }
        : { type: 'input_image', image_url: `data:${mime};base64,${asset.data_base64}` }
    );
  }
  const input =
    request.assets === undefined
      ? state
      : gemini
        ? parts
        : [{ type: 'message', role: 'user', content: parts }];
  const encodedQuestions = gemini
    ? Object.fromEntries(
        questions.map(([name, question]) => [
          name,
          {
            type: question.type,
            instructions: encodeText(question.instructions),
            ...(question.type === 'choice' && {
              criteria: Object.fromEntries(
                Object.entries(question.criteria).map(([id, description]) => [
                  id,
                  description === null ? '' : encodeText(description),
                ])
              ),
            }),
          },
        ])
      )
    : questions.map(([name, question]) => ({
        name,
        type: question.type === 'noul' ? 'predicate' : 'choice',
        instructions: encodeText(question.instructions),
        ...(question.type === 'choice' && {
          choices: Object.entries(question.criteria).map(
            ([value, description]): Json =>
              description === null ? { value } : { value, description }
          ),
        }),
      }));

  return {
    body: { model: target.modelId, input, questions: encodedQuestions },
    headers: { 'content-type': 'application/json' },
  };
}

export function readDecisionRequest(wire: WireRecord): JudgmentRequest | null {
  const protocol = wire.protocol;
  const gemini = protocol === 'gemini-decisions-v1';
  if (
    !gemini &&
    protocol !== 'openai-decisions-v1' &&
    protocol !== 'openai-compatible-decisions-v1'
  )
    return null;

  const body = object(wire.body);
  const input = body.input;
  let state: Json;
  let assets: JudgmentRequest['assets'];
  if (typeof input === 'string') {
    state = decodeText(input);
  } else {
    if (!Array.isArray(input)) return null;
    const parts: unknown = gemini ? input : object(input[0]).content;
    if (!Array.isArray(parts) || parts.length % 2 !== 1) return null;
    const first = object(parts[0]);
    if (typeof first.text !== 'string') return null;
    state = decodeText(first.text);
    const entries: [string, NonNullable<JudgmentRequest['assets']>[string]][] = [];
    for (let index = 1; index < parts.length; index += 2) {
      const label = object(parts[index]).text;
      const image = object(parts[index + 1]);
      if (typeof label !== 'string' || !label.startsWith(imageLabel)) return null;
      const reference = label.slice(imageLabel.length);
      const dataUrl =
        gemini && typeof image.data === 'string'
          ? `data:${image.mime_type};base64,${image.data}`
          : image.image_url;
      const match =
        typeof dataUrl === 'string' &&
        /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(dataUrl);
      if (!match || !reference || entries.some(([key]) => key === reference)) return null;
      const data_base64 = match[2];
      if (Buffer.from(data_base64, 'base64').toString('base64') !== data_base64) return null;
      entries.push([
        reference,
        { type: 'image', format: match[1] === 'jpeg' ? 'jpeg' : 'png', data_base64 },
      ]);
    }
    assets = Object.fromEntries(entries);
  }

  const entries = gemini
    ? Object.entries(object(body.questions))
    : Array.isArray(body.questions)
      ? body.questions.map((value): [unknown, unknown] => [object(value).name, value])
      : [];
  const questions = new Map<string, JudgmentQuestion>();
  for (const [name, value] of entries) {
    const question = object(value);
    if (
      typeof name !== 'string' ||
      questions.has(name) ||
      typeof question.instructions !== 'string'
    )
      return null;
    const instructions = decodeText(question.instructions);
    if (question.type === (gemini ? 'noul' : 'predicate')) {
      questions.set(name, { type: 'noul', instructions });
    } else if (question.type === 'choice') {
      const options = gemini
        ? Object.entries(object(question.criteria))
        : Array.isArray(question.choices)
          ? question.choices.map((value): [unknown, unknown] => {
              const option = object(value);
              return [option.value, option.description ?? null];
            })
          : [];
      const criteria = new Map<string, string | null>();
      for (const [id, description] of options) {
        const decoded =
          gemini && typeof description === 'string'
            ? description === ''
              ? null
              : decodeText(description)
            : description;
        if (
          typeof id !== 'string' ||
          criteria.has(id) ||
          (decoded !== null && typeof decoded !== 'string')
        )
          return null;
        criteria.set(id, decoded);
      }
      questions.set(name, { type: 'choice', instructions, criteria: Object.fromEntries(criteria) });
    } else {
      return null;
    }
  }
  const request: JudgmentRequest = {
    state,
    questions: Object.fromEntries(questions),
    ...(assets && { assets }),
  };
  try {
    const expected = prepareDecisionRequest(request, {
      provider: gemini ? 'gemini' : 'openai',
      connectionId: wire.connectionId,
      modelId: wire.modelId,
      endpoint: wire.url,
    });
    return isDeepStrictEqual(body, expected.body) ? request : null;
  } catch {
    return null;
  }
}

const probability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const tokens = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function parseDecisionResponse(
  payload: unknown,
  request: JudgmentRequest,
  target: JudgmentTarget,
  _kind?: JudgmentHooks['kind']
): {
  scores: Record<string, number>;
  choices: JudgmentResult['choices'];
  usage: ProviderResult['usage'];
} {
  const gemini = target.provider === 'gemini';
  const response = object(payload);
  const rawUsage = object(response.usage);
  const usage = {
    inputTokens: tokens(rawUsage[gemini ? 'total_input_tokens' : 'input_tokens']),
    outputTokens: tokens(rawUsage[gemini ? 'total_output_tokens' : 'output_tokens']),
    raw: (response.usage === rawUsage ? rawUsage : null) as Json,
    costUsd: null,
    priceRevision: null,
  };
  const invalid = (): never => {
    throw Object.assign(new Error('JUDGMENT_RESPONSE_INVALID'), {
      code: 'JUDGMENT_RESPONSE_INVALID',
      usage,
    });
  };
  const questions = Object.entries(request.questions);
  const answers = gemini ? object(response.answers) : response.answers;
  if (
    gemini
      ? Object.keys(object(answers)).length !== questions.length
      : typeof response.model !== 'string' ||
        !Array.isArray(answers) ||
        answers.length !== questions.length
  )
    invalid();

  const scores: Record<string, number> = Object.create(null);
  const choices: JudgmentResult['choices'] = Object.create(null);
  for (const [index, [name, question]] of questions.entries()) {
    const answer = object(Array.isArray(answers) ? answers[index] : object(answers)[name]);
    if (!gemini && answer.name !== name) invalid();
    if (question.type === 'noul') {
      const score = gemini ? answer.noul : answer.probability;
      if (
        answer.type !== (gemini ? 'noul' : 'predicate') ||
        !probability(score) ||
        (gemini && !probability(answer.confidence))
      )
        invalid();
      scores[name] = score as number;
      continue;
    }

    const distribution = answer.probabilities;
    const entries = gemini
      ? Object.entries(object(distribution))
      : Array.isArray(distribution)
        ? distribution.map((value): [unknown, unknown] => {
            const option = object(value);
            return [option.value, option.probability];
          })
        : [];
    const values = new Map(entries);
    const keys = Object.keys(question.criteria);
    const selected = values.get(answer.choice);
    if (
      answer.type !== 'choice' ||
      typeof answer.choice !== 'string' ||
      !Object.hasOwn(question.criteria, answer.choice) ||
      !probability(selected) ||
      !probability(answer.confidence) ||
      entries.length !== keys.length ||
      values.size !== keys.length
    )
      invalid();

    const probabilities: Record<string, number> = Object.create(null);
    let sum = 0;
    for (const key of keys) {
      const value = values.get(key);
      if (!probability(value) || value > Number(selected) + 0.000001) invalid();
      probabilities[key] = Number(value);
      sum += probabilities[key];
    }
    // Providers round published probabilities. A small tolerance also permits ties at that precision.
    if (Math.abs(sum - 1) > 0.01 + Number.EPSILON) invalid();
    choices[name] = {
      choice: answer.choice as string,
      confidence: answer.confidence as number,
      probabilities,
    };
  }
  return { scores, choices, usage };
}
