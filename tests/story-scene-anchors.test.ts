import { describe, expect, test } from 'vitest';
import { sourceHash } from '../core/source-history.js';
import { executeStoryRead, STORY_RESULT_MAX_BYTES } from '../core/story-context.js';
import type { RunSnapshot } from '../core/types.js';
import { MAIN_READ_TOOLS } from '../server/main-request.js';
import { createSourceSegmentFixture } from './fixtures/source-segments.js';

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
    settings: { preset: 'calm', mode: 'direct', translation: false, status: false, maxCalls: 8 },
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
  test('authored starts count, and compacting, filtering and paging never renumber originals', () => {
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
    const listed = read(fixed, 'story.list', { offset: 1, limit: 1 });
    expect(listed.results).toEqual([
      expect.objectContaining({ sceneNumber: 2, index: 1, revision: 'source-1', compacted: true }),
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
    expect(found.sceneScope).toEqual(listed.sceneScope);
    expect(read(fixed, 'story.read', { sceneNumber: 1 }).text).toBe('Authored opening.');
    expect(read(fixed, 'story.read', { sceneNumber: 2 })).toEqual(
      read(fixed, 'story.read', { id: 'source-1', sceneNumber: 2 })
    );
    expect(fixed).toEqual(original);
    expect(MAIN_READ_TOOLS.find((tool) => tool.name === 'story.read')!.inputSchema).toMatchObject({
      properties: { sceneNumber: { type: 'integer', minimum: 1 } },
      anyOf: [{ required: ['id'] }, { required: ['sceneNumber'] }],
    });
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

  test('mismatched selectors, another branch and stale source hashes cannot be read', () => {
    const fixed = snapshot();
    expect(invoke(fixed, 'story.read', { id: 'source-0', sceneNumber: 2 })).toMatchObject({
      denied: true,
      result: { code: 'INVALID_ARGUMENTS' },
    });
    for (const args of [{ sceneNumber: 4 }, { id: 'other-branch' }])
      expect(invoke(fixed, 'story.read', args)).toMatchObject({
        denied: true,
        result: { code: 'RESOURCE_UNAVAILABLE' },
      });
    expect(invoke(fixed, 'story.read', {})).toMatchObject({
      denied: true,
      result: { code: 'INVALID_ARGUMENTS' },
    });
    fixed.history[0].text = 'Unhashed edit.';
    expect(invoke(fixed, 'story.read', { sceneNumber: 2 })).toMatchObject({
      denied: true,
      result: { code: 'RESOURCE_UNAVAILABLE' },
    });
  });

  test('forks share prefix ordinals while divergent tails and edits retain exact source identity', () => {
    const original = snapshot(),
      fork = structuredClone(original);
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
    expect(tail.sceneScope).toMatchObject({
      chatId: 'fork',
      headRevision: 'fork-tail',
      headHash: fork.history[2].contentHash,
    });
    expect(tail.source).not.toEqual(read(original, 'story.read', { sceneNumber: 3 }).source);
    fork.history[1] = {
      ...fork.history[1],
      text: 'Corrected promise.',
      contentHash: sourceHash('Corrected promise.'),
    };
    const edited = read(fork, 'story.read', { sceneNumber: 2 });
    expect(edited).toMatchObject({
      sceneNumber: 2,
      source: { revision: prefix.source.revision, hash: sourceHash('Corrected promise.') },
    });
    expect(edited.source.hash).not.toBe(prefix.source.hash);
  });

  test('number reads preserve UTF-16 continuation and the byte cap, identical to ID reads', () => {
    const text = '🌙 "정확한 인용"\n'.repeat(4000),
      fixed = snapshot([text]);
    let offset: number | null = 0,
      recovered = '';
    while (offset !== null) {
      const numbered = read(fixed, 'story.read', { sceneNumber: 1, offset, limit: 16000 });
      expect(numbered).toEqual(read(fixed, 'story.read', { id: 'source-0', offset, limit: 16000 }));
      expect(numbered.source.start).toBe(offset);
      recovered += numbered.text;
      offset = numbered.nextOffset;
    }
    expect(recovered).toBe(text);
  });

  test('direct scene selection preserves hidden ranges and cannot search across an excluded span', () => {
    const hidden =
      'Visible introduction.\r\n\r\n@hsTitle: Quiet Bell\r\n⟦Harbor @ Dusk @ Keeper⟧\r\nSecret witness.\r\n@hs\r\n\r\nThe reader hears waves.';
    const fixed = snapshot(['Authored opening.', hidden, 'Later exchange.']);
    fixed.sourceSegments = createSourceSegmentFixture({ excludeAsides: true });
    const numbered = read(fixed, 'story.read', { sceneNumber: 2, limit: 16000 });
    expect(numbered).toEqual(read(fixed, 'story.read', { id: 'source-1', limit: 16000 }));
    expect(numbered.text).not.toContain('Secret witness');
    expect(numbered.source.hash).toBe(sourceHash(hidden));
    expect(
      numbered.keptRanges
        .map((range: { start: number; end: number }) => hidden.slice(range.start, range.end))
        .join('')
    ).toBe(numbered.text);
    expect(read(fixed, 'story.search', { query: 'Secret witness' }).total).toBe(0);
    expect(read(fixed, 'story.search', { query: 'introduction waves' }).total).toBe(0);
    expect(read(fixed, 'story.search', { query: 'waves' }).results[0].sceneNumber).toBe(2);
  });
});
