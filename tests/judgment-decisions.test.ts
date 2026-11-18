import { describe, expect, it } from 'vitest';
import type { JudgmentRequest, JudgmentTarget } from '../core/judgment.js';
import type { WireRecord } from '../core/transport.js';
import {
  decisionAuthorization,
  parseDecisionResponse,
  prepareDecisionRequest,
  readDecisionRequest,
} from '../server/judgment-decisions.js';

const openai: JudgmentTarget = {
  provider: 'openai',
  connectionId: 'openai',
  modelId: 'gpt-6-luna',
  endpoint: 'https://api.openai.com/v1/decisions',
};
const gemini: JudgmentTarget = {
  provider: 'gemini',
  connectionId: 'google',
  modelId: 'gemini-decision-1',
  endpoint: 'https://generativelanguage.googleapis.com/v1beta/decisions',
};
const compatible: JudgmentTarget = {
  provider: 'openai-compatible',
  connectionId: 'gateway',
  modelId: 'typesafe-ai/jev',
  endpoint: 'https://ai-gateway.vercel.sh/v1/decisions',
};
const request: JudgmentRequest = {
  state: { assets: [{ image: 'hero_photo' }, { image: 'cover_photo' }] },
  questions: {
    relevance: { type: 'noul', instructions: { task: 'Contains a relevant image?' } },
    best: { type: 'choice', instructions: 'true', criteria: { hero: '', cover: null } },
  },
  assets: {
    hero_photo: { type: 'image', format: 'jpeg', data_base64: 'AQI=' },
    cover_photo: { type: 'image', format: 'png', data_base64: 'AwQ=' },
  },
};

function wire(target: JudgmentTarget, body: WireRecord['body']): WireRecord {
  return {
    connectionId: target.connectionId,
    protocol:
      target.provider === 'gemini'
        ? 'gemini-decisions-v1'
        : target.provider === 'openai-compatible'
          ? 'openai-compatible-decisions-v1'
          : 'openai-decisions-v1',
    role: 'image',
    modelId: target.modelId,
    method: 'POST',
    url: target.endpoint,
    headers: { 'content-type': 'application/json' },
    body,
    bodySha256: '',
    stablePrefixSha256: '',
  };
}

const openAIInput = [
  {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: '{"assets":[{"image":"hero_photo"},{"image":"cover_photo"}]}' },
      { type: 'input_text', text: '\nImage reference: hero_photo' },
      { type: 'input_image', image_url: 'data:image/jpeg;base64,AQI=' },
      { type: 'input_text', text: '\nImage reference: cover_photo' },
      { type: 'input_image', image_url: 'data:image/png;base64,AwQ=' },
    ],
  },
];
const openAIQuestions = [
  { name: 'relevance', type: 'predicate', instructions: '{"task":"Contains a relevant image?"}' },
  {
    name: 'best',
    type: 'choice',
    instructions: '"true"',
    choices: [{ value: 'hero', description: '' }, { value: 'cover' }],
  },
];

describe('Decisions wire contracts', () => {
  it('sends plain text unchanged when images are absent', () => {
    const plain: JudgmentRequest = {
      state: 'A damaged delivery',
      questions: { relevance: { type: 'noul', instructions: 'Is the item damaged?' } },
    };
    const { body } = prepareDecisionRequest(plain, gemini);
    expect(body).toEqual({
      model: 'gemini-decision-1',
      input: 'A damaged delivery',
      questions: { relevance: { type: 'noul', instructions: 'Is the item damaged?' } },
    });
    expect(readDecisionRequest(wire(gemini, body))).toEqual(plain);
  });

  it.each([openai, compatible])('uses the OpenAI wire for $provider', (target) => {
    const { body, headers } = prepareDecisionRequest(request, target);
    expect(body).toEqual({ model: target.modelId, input: openAIInput, questions: openAIQuestions });
    expect(headers).toEqual({ 'content-type': 'application/json' });
    expect(decisionAuthorization(target, 'key')).toEqual({ authorization: 'Bearer key' });
    expect(readDecisionRequest(wire(target, body))).toEqual(request);
  });

  it('uses the Gemini maps and keeps image labels next to raw bytes', () => {
    const { body } = prepareDecisionRequest(request, gemini);
    expect(body).toEqual({
      model: 'gemini-decision-1',
      input: [
        { type: 'text', text: '{"assets":[{"image":"hero_photo"},{"image":"cover_photo"}]}' },
        { type: 'text', text: '\nImage reference: hero_photo' },
        { type: 'image', mime_type: 'image/jpeg', data: 'AQI=' },
        { type: 'text', text: '\nImage reference: cover_photo' },
        { type: 'image', mime_type: 'image/png', data: 'AwQ=' },
      ],
      questions: {
        relevance: { type: 'noul', instructions: '{"task":"Contains a relevant image?"}' },
        best: { type: 'choice', instructions: '"true"', criteria: { hero: '""', cover: '' } },
      },
    });
    expect(decisionAuthorization(gemini, 'key')).toEqual({ 'x-goog-api-key': 'key' });
    expect(readDecisionRequest(wire(gemini, body))).toEqual(request);
  });

  it('rejects receipt bodies with duplicate questions or a mismatched model', () => {
    const body = {
      model: openai.modelId,
      input: 'scene',
      questions: [openAIQuestions[0], openAIQuestions[0]],
    };
    expect(readDecisionRequest(wire(openai, body as WireRecord['body']))).toBeNull();
    expect(
      readDecisionRequest(
        wire(openai, {
          model: 'other',
          input: 'scene',
          questions: [{ name: 'relevance', type: 'predicate', instructions: 'Check relevance.' }],
        })
      )
    ).toBeNull();
  });

  it('rejects requests the provider cannot encode', () => {
    expect(() =>
      prepareDecisionRequest(
        {
          state: 'scene',
          questions: { 'invalid key': { type: 'noul', instructions: 'Check relevance.' } },
        },
        gemini
      )
    ).toThrow('JUDGMENT_REQUEST_INVALID');
    expect(() =>
      prepareDecisionRequest(
        {
          state: 'scene',
          questions: {
            best: { type: 'choice', instructions: 'Choose.', criteria: { only: null } },
          },
        },
        openai
      )
    ).toThrow('JUDGMENT_REQUEST_INVALID');
  });
});

const predicate = { name: 'relevance', type: 'predicate', probability: 0.8 };
const choice = {
  name: 'best',
  type: 'choice',
  choice: 'hero',
  confidence: 0.9,
  probabilities: [
    { value: 'hero', probability: 0.9 },
    { value: 'cover', probability: 0.1 },
  ],
};
const usage = { input_tokens: 110, output_tokens: 0, input_tokens_details: { cached_tokens: 15 } };
const openAIResponse = { model: 'gpt-6-luna', answers: [predicate, choice], usage };

describe('Decisions response validation', () => {
  it('normalizes OpenAI array and Gemini map responses and their usage', () => {
    const geminiResponse = {
      answers: {
        best: {
          type: 'choice',
          choice: 'hero',
          confidence: 0.9,
          probabilities: { hero: 0.9, cover: 0.1 },
        },
        relevance: { type: 'noul', noul: 0.8, confidence: 0.8 },
      },
      usage: {
        total_input_tokens: 120,
        total_output_tokens: 0,
        input_tokens_by_modality: [{ modality: 'image', tokens: 100 }],
      },
    };
    const results = [
      parseDecisionResponse(openAIResponse, request, openai),
      parseDecisionResponse(geminiResponse, request, gemini),
    ];
    for (const result of results) {
      expect(result.scores).toEqual({ relevance: 0.8 });
      expect(result.choices).toEqual({
        best: { choice: 'hero', confidence: 0.9, probabilities: { hero: 0.9, cover: 0.1 } },
      });
    }
    expect(results[0].usage).toMatchObject({ inputTokens: 110, outputTokens: 0, raw: usage });
    expect(results[1].usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 0,
      raw: geminiResponse.usage,
    });
  });

  it.each([
    { ...openAIResponse, answers: [predicate] },
    {
      ...openAIResponse,
      answers: [
        predicate,
        {
          ...choice,
          probabilities: [{ value: 'hero', probability: 0.7 }, choice.probabilities[1]],
        },
      ],
    },
    { ...openAIResponse, answers: [{ ...predicate, probability: Infinity }, choice] },
  ])('rejects unusable responses and retains usage even for image selection', (payload) => {
    expect(() => parseDecisionResponse(payload, request, openai, 'image-selection')).toThrow(
      expect.objectContaining({
        code: 'JUDGMENT_RESPONSE_INVALID',
        usage: expect.objectContaining({ inputTokens: 110, outputTokens: 0 }),
      })
    );
  });
});
