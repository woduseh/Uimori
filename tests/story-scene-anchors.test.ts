import { describe, expect, test } from 'vitest';
import { sourceHash } from '../core/source-history.js';
import { executeStoryRead, STORY_RESULT_MAX_BYTES } from '../core/story-context.js';
import type { RunSnapshot } from '../core/types.js';

function snapshot(
  texts = ['Authored opening.', 'Mira promises the lantern.', 'The captain waits.']
): RunSnapshot {
  const history = texts.map((text, index) => ({
    revision: `source-${index}`,
    text,
    contentHash: sourceHash(text),
  }));
  return {
    chatId: 'scene-test',
    parentRevision: history.at(-1)?.revision ?? null,
    settingsRevision: 1,
    settings: { status: false, maxCalls: 8 },
    request: 'Continue.',
    resources: [],
    history,
    logicalHistory: history.map((item, index) => ({
      id: `message-${index}`,
      role: 'assistant',
      text: item.text,
      sourceRevision: item.revision,
      sourceHash: item.contentHash,
      ...(index === 0 ? { sourceKind: 'authored-start' as const } : {}),
    })),
  };
}
function invoke(fixed: RunSnapshot, name: string, args: Record<string, unknown>) {
  return executeStoryRead(fixed, { callId: 'scene-tool', name, args });
}
function read(fixed: RunSnapshot, name: string, args: Record<string, unknown>) {
  const event = invoke(fixed, name, args);
  expect(event.denied, JSON.stringify(event)).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(event.result))).toBeLessThanOrEqual(
    STORY_RESULT_MAX_BYTES
  );
  return event.result as any;
}

describe('scene locators in frozen source ancestry', () => {
  test('authored starts count, and compacting, searching and paging never renumber originals', () => {
    const fixed = snapshot();
    fixed.contextPlan = {
      version: 1,
      status: 'ready',
      budget: { inputTokenLimit: 8192, estimator: 'o200k_base-v1' },
      dependencyKey: 'synthetic',
      estimatedInputTokens: 10,
      compacted: fixed.history
        .slice(0, 2)
        .map((item) => ({ revision: item.revision, hash: item.contentHash! })),
      recentSourceRevisions: ['source-2'],
      summary: 'Promise [scene 2].',
      summaryCalls: 0,
      usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      error: null,
    };
    const original = structuredClone(fixed);
    const listed = read(fixed, 'story.search', { offset: 1, limit: 1 });
    expect(listed.results).toEqual([
      expect.objectContaining({ sceneNumber: 2, revision: 'source-1', compacted: true }),
    ]);
    expect(listed).toMatchObject({
      total: 3,
      nextOffset: 2,
      sceneScope: {
        chatId: fixed.chatId,
        headRevision: 'source-2',
        headHash: fixed.history[2].contentHash,
        numbering: 'source-ancestry-1-based',
      },
    });
    const found = read(fixed, 'story.search', { query: 'lantern' });
    expect(found.results[0]).toMatchObject({
      sceneNumber: 2,
      source: { revision: 'source-1', hash: fixed.history[1].contentHash },
    });
    expect(read(fixed, 'story.read', { sceneNumber: 1 }).text).toBe('Authored opening.');
    expect(fixed).toEqual(original);
  });

  test.each([0, -1, 1.5, '2', true, null, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid sceneNumber %s without coercing it',
    (sceneNumber) => {
      expect(invoke(snapshot(), 'story.read', { sceneNumber })).toMatchObject({
        denied: true,
        result: { code: 'INVALID_ARGUMENTS' },
      });
    }
  );

  test('legacy revision selector is invalid while an out-of-range scene is unavailable', () => {
    const fixed = snapshot();
    expect(invoke(fixed, 'story.read', { id: 'source-0' })).toMatchObject({
      denied: true,
      result: { code: 'INVALID_ARGUMENTS' },
    });
    expect(invoke(fixed, 'story.read', { sceneNumber: 4 })).toMatchObject({
      denied: true,
      result: { code: 'RESOURCE_UNAVAILABLE' },
    });
  });

  test('forks share prefix ordinals while divergent tails and edits retain exact source identity', () => {
    const original = snapshot();
    const fork = structuredClone(original);
    fork.chatId = 'fork';
    fork.history[2] = {
      revision: 'fork-tail',
      text: 'The captain leaves.',
      contentHash: sourceHash('The captain leaves.'),
    };
    fork.parentRevision = 'fork-tail';
    const prefix = read(fork, 'story.read', { sceneNumber: 2 });
    expect(prefix.source).toEqual(read(original, 'story.read', { sceneNumber: 2 }).source);
    const tail = read(fork, 'story.read', { sceneNumber: 3 });
    expect(tail.source.revision).toBe('fork-tail');
    expect(tail.sceneScope).toMatchObject({ chatId: 'fork', headRevision: 'fork-tail' });
    fork.history[1] = {
      ...fork.history[1],
      text: 'Corrected promise.',
      contentHash: sourceHash('Corrected promise.'),
    };
    const edited = read(fork, 'story.read', { sceneNumber: 2 });
    expect(edited.source.hash).toBe(sourceHash('Corrected promise.'));
    expect(edited.source.hash).not.toBe(prefix.source.hash);
  });

  test('scene-number reads preserve UTF-16 continuation and the byte cap', () => {
    const text = '🌙 "정확한 인용"\n'.repeat(4000);
    const fixed = snapshot([text]);
    let offset: number | null = 0;
    let recovered = '';
    while (offset !== null) {
      const page = read(fixed, 'story.read', { sceneNumber: 1, offset, limit: 16000 });
      expect(page.source.start).toBe(offset);
      recovered += page.text;
      offset = page.nextOffset;
    }
    expect(recovered).toBe(text);
  });
});
