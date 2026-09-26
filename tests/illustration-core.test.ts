import { describe, expect, test } from 'vitest';
import {
  codexIllustrationText,
  detectImageMime,
  excerptScene,
  fillComfyWorkflow,
  illustrationPromptRequest,
  ILLUSTRATION_EXCERPT_TOKENS,
  IllustrationError,
  isRetryableIllustrationCode,
  parseCodexIllustrationCaption,
  parseComfyWorkflow,
  parseIllustrationPlan,
  randomComfySeed,
} from '../core/illustration.js';
import { FIXTURE_WORKFLOW } from './fixtures/comfyui-server.js';
import { PNG_BASE64 } from './fixtures/illustration.js';
import { countTextTokens } from '../core/text-tokens.js';

describe('ComfyUI API-format workflow templates', () => {
  test('parses an API workflow, rejects the UI export and requires the prompt placeholder', () => {
    const workflow = parseComfyWorkflow(FIXTURE_WORKFLOW);
    expect(Object.keys(workflow)).toEqual(['3', '4', '6', '7', '9']);
    expect(() => parseComfyWorkflow('not json')).toThrow(
      new IllustrationError('COMFYUI_WORKFLOW_INVALID')
    );
    expect(() => parseComfyWorkflow(JSON.stringify({ nodes: [], links: [] }))).toThrow(
      'COMFYUI_WORKFLOW_UI_FORMAT'
    );
    expect(() =>
      parseComfyWorkflow(JSON.stringify({ '1': { class_type: 'X', inputs: { text: 'fixed' } } }))
    ).toThrow('COMFYUI_WORKFLOW_PROMPT_PLACEHOLDER_MISSING');
    expect(() => parseComfyWorkflow(JSON.stringify({ '1': { inputs: {} } }))).toThrow(
      'COMFYUI_WORKFLOW_INVALID'
    );
    expect(() => parseComfyWorkflow('﻿' + FIXTURE_WORKFLOW)).not.toThrow();
  });
  test('fills only string inputs, turns a bare seed placeholder into a number and keeps the template intact', () => {
    const workflow = parseComfyWorkflow(FIXTURE_WORKFLOW);
    const before = JSON.stringify(workflow);
    const filled = fillComfyWorkflow(workflow, {
      prompt: 'a lantern over a river, night',
      negativePrompt: 'lowres',
      seed: 42,
    });
    expect(filled['6'].inputs.text).toBe('a lantern over a river, night');
    expect(filled['7'].inputs.text).toBe('blurry, lowres');
    expect(filled['3'].inputs.seed).toBe(42);
    expect(filled['3'].inputs.model).toEqual(['4', 0]);
    expect(JSON.stringify(workflow)).toBe(before);
    expect(() =>
      fillComfyWorkflow(workflow, { prompt: 'x', negativePrompt: '', seed: -1 })
    ).toThrow('COMFYUI_WORKFLOW_INVALID');
    const seed = randomComfySeed(() => 0.5);
    expect(Number.isSafeInteger(seed) && seed >= 0).toBe(true);
  });
});

describe('prompt model output and Codex caption parsing', () => {
  test('accepts fenced, BOM-prefixed and embedded JSON without cutting image prompts', () => {
    expect(
      parseIllustrationPlan(
        '```json\n{"prompt":"a girl","negativePrompt":"text","caption":"소녀"}\n```',
        false
      )
    ).toEqual({
      kind: 'generate',
      prompt: { prompt: 'a girl', negativePrompt: 'text', caption: '소녀' },
    });
    expect(parseIllustrationPlan('﻿ {"prompt":"a"} ', false)).toEqual({
      kind: 'generate',
      prompt: { prompt: 'a', negativePrompt: '', caption: '' },
    });
    expect(parseIllustrationPlan('Sure! {"prompt":"b","caption":"c"} done', false)).toMatchObject({
      kind: 'generate',
      prompt: { prompt: 'b', caption: 'c' },
    });
    const prompt = 'silver hair, blue cloak, '.repeat(200);
    const negativePrompt = 'blurry, text, '.repeat(200);
    expect(
      parseIllustrationPlan(
        JSON.stringify({ prompt, negativePrompt, caption: '장면'.repeat(200) }),
        false
      )
    ).toEqual({
      kind: 'generate',
      prompt: {
        prompt: prompt.trim(),
        negativePrompt: negativePrompt.trim(),
        caption: '장면'.repeat(150),
      },
    });
    for (const bad of ['', 'nope', '{"negativePrompt":"only"}', '{"prompt":"  "}', '[1]'])
      expect(() => parseIllustrationPlan(bad, false)).toThrow('ILLUSTRATION_PROMPT_INVALID');
    try {
      parseIllustrationPlan('nope', false);
    } catch (error) {
      expect((error as IllustrationError).retryable).toBe(true);
    }
  });
  test('honors a skip decision only when the host allowed it', () => {
    expect(parseIllustrationPlan('{"decision":"skip","reason":"dialogue only"}', true)).toEqual({
      kind: 'skip',
      reason: 'dialogue only',
    });
    expect(parseIllustrationPlan('{"skip":true}', true)).toMatchObject({ kind: 'skip' });
    expect(() => parseIllustrationPlan('{"decision":"skip","reason":"x"}', false)).toThrow(
      'ILLUSTRATION_PROMPT_INVALID'
    );
    expect(parseIllustrationPlan('{"prompt":"a lantern"}', true)).toEqual({
      kind: 'generate',
      prompt: { prompt: 'a lantern', negativePrompt: '', caption: '' },
    });
    expect(parseCodexIllustrationCaption('{"caption":"SKIP: only dialogue"}')).toMatchObject({
      skipped: 'only dialogue',
    });
    expect(parseCodexIllustrationCaption('{"caption":"강 위의 등불"}').skipped).toBeNull();
  });
  test('reads the Codex caption envelope, plain text and the unavailable marker', () => {
    expect(parseCodexIllustrationCaption('{"caption":"달빛 아래 소녀"}')).toEqual({
      caption: '달빛 아래 소녀',
      unavailable: false,
      skipped: null,
    });
    expect(parseCodexIllustrationCaption('  plain caption ')).toEqual({
      caption: 'plain caption',
      unavailable: false,
      skipped: null,
    });
    expect(parseCodexIllustrationCaption('{"caption":"UNAVAILABLE: tool disabled"}')).toMatchObject(
      { unavailable: true }
    );
  });
  test('bounds scene and character notes by tokens and carries the selected model input budget', () => {
    const request = illustrationPromptRequest(
      {
        id: 'm',
        revision: 1,
        title: 'Prompt model',
        connectionId: 'c',
        modelId: 'provider/model',
        maxOutputTokens: 1024,
        inputTokenLimit: 16_384,
        temperature: null,
        connection: {
          id: 'c',
          revision: 1,
          title: 'C',
          protocol: 'openai-chat-v1',
          endpoint: 'https://api.openai.com/v1',
          enabled: true,
          catalog: [],
          catalogError: null,
        },
      },
      {
        text: '강가에서 은빛 머리의 소녀가 등불을 흔들었다. '.repeat(3000) + '마지막 장면',
        styleGuidance: 'watercolor',
        negativeGuidance: 'lowres',
        bot: 'Mira has silver hair. '.repeat(3000),
        persona: '나그네는 푸른 옷을 입고 있다. '.repeat(3000),
        allowSkip: false,
      },
      { maxOutputTokens: 1024, temperature: null }
    );
    expect(request.role).toBe('illustration');
    expect(request.modelId).toBe('provider/model');
    expect(request.stable.tools).toEqual([]);
    expect(request.contextBudget?.inputTokenLimit).toBe(16_384);
    const source = request.input.source as {
      scene: string;
      characterNotes: { bot: string; persona: string };
    };
    for (const [key, value] of Object.entries({ scene: source.scene, ...source.characterNotes })) {
      expect(value.startsWith('[Earlier text omitted]\n')).toBe(true);
      expect(countTextTokens(value)).toBeLessThanOrEqual(
        ILLUSTRATION_EXCERPT_TOKENS[key as keyof typeof ILLUSTRATION_EXCERPT_TOKENS]
      );
    }
    expect(source.scene.endsWith('마지막 장면')).toBe(true);
  });
  test('the Codex input text labels references by role without carrying bytes', () => {
    const text = codexIllustrationText(
      {
        text: 'Scene',
        styleGuidance: 'ink',
        bot: null,
        persona: null,
        allowSkip: true,
      },
      [
        { role: 'character', label: 'Mira' },
        { role: 'style', label: 'Sketchbook' },
      ]
    );
    const parsed = JSON.parse(text) as { attachedReferences: { role: string; label: string }[] };
    expect(parsed.attachedReferences).toEqual([
      { attachment: 1, role: 'character design reference', label: 'Mira' },
      { attachment: 2, role: 'art style reference', label: 'Sketchbook' },
    ]);
    expect(text).not.toContain('base64');
  });
});

describe('image bytes, excerpts and retry classes', () => {
  test('detects PNG, JPEG and WebP by magic bytes only', () => {
    expect(detectImageMime(Buffer.from(PNG_BASE64, 'base64'))).toBe('image/png');
    expect(detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(
      detectImageMime(
        Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])
      )
    ).toBe('image/webp');
    expect(detectImageMime(Buffer.from('<svg/>'))).toBeNull();
  });
  test('excerpts long scenes from the end and keeps short scenes verbatim', () => {
    expect(excerptScene('short')).toBe('short');
    const inexpensive = 'x'.repeat(30_000);
    expect(excerptScene(inexpensive)).toBe(inexpensive);
    const excerpt = excerptScene('등불 아래 두 사람이 강을 바라본다. 🌙 '.repeat(100) + 'END', 80);
    expect(excerpt.startsWith('[Earlier text omitted]\n')).toBe(true);
    expect(excerpt.endsWith('END')).toBe(true);
    expect(countTextTokens(excerpt)).toBeLessThanOrEqual(80);
    expect(new TextDecoder().decode(new TextEncoder().encode(excerpt))).toBe(excerpt);
  });
  test('retries known-safe failures and leaves uncertain remote outcomes final', () => {
    for (const code of ['COMFYUI_EXECUTION_FAILED', 'CODEX_IMAGE_NOT_GENERATED', 'FIXTURE_FAILURE'])
      expect(isRetryableIllustrationCode(code)).toBe(true);
    for (const code of [
      'COMFYUI_UNREACHABLE',
      'COMFYUI_HTTP_5XX',
      'TIMEOUT',
      'TRANSPORT_ERROR',
      'CODEX_UNAVAILABLE',
      'CODEX_TURN_FAILED',
      'CODEX_EXECUTION_INTERRUPTED',
      'AUXILIARY_PROVIDER_HTTP_503',
      'UND_ERR_SOCKET',
      'COMFYUI_PROMPT_REJECTED',
      'COMFYUI_TIMEOUT',
      'COMFYUI_WORKFLOW_INVALID',
      'CODEX_IMAGE_USAGE_LIMIT',
      'ILLUSTRATION_CANCELLED',
      'AUXILIARY_PROVIDER_HTTP_400',
      'ILLUSTRATION_GENERATOR_UNCONFIGURED',
    ])
      expect(isRetryableIllustrationCode(code)).toBe(false);
  });
});
