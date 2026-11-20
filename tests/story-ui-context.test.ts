import { expect, test } from 'vitest';
import { selectLogicalHistory, storyUiHistoryMode } from '../core/context-projection.js';
import { encodeStoryUi, type StoryUiMessage } from '../core/story-ui.js';
import type { RunSnapshot } from '../core/types.js';
import { buildMainInput } from '../core/provider.js';
import { sourceHash } from '../core/source-history.js';

test('logical history projects visible UI text without mutating the frozen snapshot', () => {
  const messages = [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'main',
        catalogId: 'urn:uimori:story-ui:1',
        components: [{ id: 'root', component: 'Text', text: 'Harbor bulletin' }],
      },
    },
  ] as unknown as StoryUiMessage[];
  const text = `Opening\n${encodeStoryUi('<a2ui>root = Text("Harbor bulletin")</a2ui>', messages)}`;
  const snapshot = {
    history: [{ revision: 'r1', text }],
    logicalHistory: [{ id: 's1', role: 'assistant', text, sourceRevision: 'r1' }],
  } as RunSnapshot;
  const projected = selectLogicalHistory(snapshot, snapshot.history);
  expect(projected[0].text).toBe('Opening\nHarbor bulletin');
  expect(storyUiHistoryMode({ settings: {} } as RunSnapshot)).toBe('text');
  expect(storyUiHistoryMode({ settings: { storyUi: true } } as RunSnapshot)).toBe('expression');
  expect(selectLogicalHistory(snapshot, snapshot.history, 'expression')[0].text).toBe(
    'Opening\n<a2ui>root = Text("Harbor bulletin")</a2ui>'
  );
  expect(snapshot.history[0].text).toBe(text);
  expect(snapshot.logicalHistory?.[0].text).toBe(text);
});

test('main input validates the canonical hash before projecting its text', () => {
  const messages = [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'main',
        catalogId: 'urn:uimori:story-ui:1',
        components: [{ id: 'root', component: 'Text', text: 'A notice' }],
      },
    },
  ] as unknown as StoryUiMessage[];
  const text = encodeStoryUi('<a2ui>root = Text("A notice")</a2ui>', messages);
  const snapshot = {
    chatId: 'chat',
    request: 'continue',
    resources: [],
    settings: {},
    history: [{ revision: 'r1', text, contentHash: sourceHash(text) }],
  } as unknown as RunSnapshot;
  expect(buildMainInput(snapshot).history[0]).toEqual({
    revision: 'r1',
    text: 'A notice',
    contentHash: sourceHash(text),
  });
  expect(snapshot.history[0].text).toBe(text);
  snapshot.history[0].contentHash = sourceHash('A notice');
  expect(() => buildMainInput(snapshot)).toThrow('STORY_SOURCE_HASH_MISMATCH');
});
