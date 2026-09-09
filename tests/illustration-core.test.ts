import { describe, expect, test } from 'vitest';
import {
  codexIllustrationText,
  defaultIllustrationSettings,
  detectImageMime,
  excerptScene,
  fillComfyWorkflow,
  illustrationPromptRequest,
  IllustrationError,
  isRetryableIllustrationCode,
  parseCodexIllustrationCaption,
  parseComfyWorkflow,
  parseIllustrationPlan,
  parseIllustrationPrompt,
  randomComfySeed,
} from '../core/illustration.js';
import { FIXTURE_WORKFLOW } from './fixtures/comfyui-server.js';
import { PNG_BASE64 } from './fixtures/illustration.js';

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
  test('accepts fenced, BOM-prefixed and embedded JSON while bounding field lengths', () => {
    expect(
      parseIllustrationPrompt(
        '```json\n{"prompt":"a girl","negativePrompt":"text","caption":"소녀"}\n```'
      )
    ).toEqual({ prompt: 'a girl', negativePrompt: 'text', caption: '소녀' });
    expect(parseIllustrationPrompt('﻿ {"prompt":"a"} ')).toEqual({
      prompt: 'a',
      negativePrompt: '',
      caption: '',
    });
    expect(parseIllustrationPrompt('Sure! {"prompt":"b","caption":"c"} done')).toMatchObject({
      prompt: 'b',
      caption: 'c',
    });
    expect(parseIllustrationPrompt(`{"prompt":"${'x'.repeat(3000)}"}`).prompt).toHaveLength(2000);
    for (const bad of ['', 'nope', '{"negativePrompt":"only"}', '{"prompt":"  "}', '[1]'])
      expect(() => parseIllustrationPrompt(bad)).toThrow('ILLUSTRATION_PROMPT_INVALID');
    try {
      parseIllustrationPrompt('nope');
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
  test('builds the prompt request as an illustration-role provider request with bounded scene data', () => {
    const request = illustrationPromptRequest(
      {
        id: 'm',
        revision: 1,
        title: 'Prompt model',
        connectionId: 'c',
        modelId: 'provider/model',
        maxOutputTokens: 1024,
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
        text: 'x'.repeat(30_000),
        styleGuidance: 'watercolor',
        negativeGuidance: 'lowres',
        bot: 'Mira has silver hair.',
        persona: null,
        instructions: ['Always show the lantern.'],
        allowSkip: false,
      },
      { maxOutputTokens: 1024, temperature: null }
    );
    expect(request.role).toBe('illustration');
    expect(request.modelId).toBe('provider/model');
    expect(request.stable.tools).toEqual([]);
    const source = request.input.source as { scene: string; characterNotes: { bot: string } };
    expect(source.scene.length).toBe(24_000);
    expect(source.scene.startsWith('…')).toBe(true);
    expect(source.characterNotes.bot).toBe('Mira has silver hair.');
  });
  test('the Codex input text labels references by role without carrying bytes', () => {
    const text = codexIllustrationText(
      {
        text: 'Scene',
        styleGuidance: 'ink',
        bot: null,
        persona: null,
        instructions: [],
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

describe('image bytes, excerpts, retry classes and defaults', () => {
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
    const excerpt = excerptScene('a'.repeat(10) + 'END', 5);
    expect(excerpt).toBe('…aEND');
  });
  test('classifies transport and remote execution failures as retryable and configuration as final', () => {
    for (const code of [
      'COMFYUI_UNREACHABLE',
      'COMFYUI_EXECUTION_FAILED',
      'CODEX_IMAGE_NOT_GENERATED',
      'AUXILIARY_PROVIDER_HTTP_503',
      'UND_ERR_SOCKET',
      'FIXTURE_FAILURE',
    ])
      expect(isRetryableIllustrationCode(code)).toBe(true);
    for (const code of [
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
  test('defaults start disabled with bounded limits', () => {
    expect(defaultIllustrationSettings()).toMatchObject({
      generator: 'none',
      automatic: false,
      maxPerSource: 2,
      maxAutoRetries: 1,
      codex: { model: null, useReferences: true },
      comfyui: { baseUrl: '', promptModel: null, timeoutMs: 300_000, pollIntervalMs: 1000 },
    });
  });
});
