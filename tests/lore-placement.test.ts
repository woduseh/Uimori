import { VERTEX_GEMINI_MODEL_ID } from './fixtures/vertex-model.js';
import { prepareNativeRisuRun } from '../server/risu-native-run.js';
import { nativeContent } from './fixtures/native-content.js';
import { expect, test } from 'vitest';
import { defaultProfile } from '../core/product.js';
import { validateRisuContent, type RisuContent } from '../core/risu-content.js';
import { compiledPackages } from '../core/package-context.js';
import { buildMainInput } from '../core/provider.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import type { RunSnapshot } from '../core/types.js';
import { buildMainProviderRequest } from '../server/main-request.js';
import { encodeResponses } from '../core/openai-protocol.js';
import { encodeChat } from '../core/openai-chat-protocol.js';
import { encodeAnthropic } from '../core/anthropic-protocol.js';
import { encodeVertex } from '../core/vertex-protocol.js';
import { DEFAULT_LORE_CONTEXT } from '../core/lore-context.js';

function fixture(): RunSnapshot {
  const pkg: RisuContent = {
    ...nativeContent({ name: 'P' }, { id: 'pkg' }, 'module'),
    id: 'pkg',
    revision: 1,
    title: 'P',
    description: '',
    lore: [
      {
        id: 'a',
        title: 'A',
        description: '',
        text: 'BACKGROUND_SENTINEL',
        loading: 'pinned',
        loreContext: { placement: 'background', group: 'g', order: 2 },
      },
      {
        id: 'b',
        title: 'B',
        description: '',
        text: 'SCENE_SENTINEL',
        loading: 'pinned',
        loreContext: { placement: 'scene', group: 'g', order: 1 },
      },
    ],
  };
  return {
    chatId: 'chat',
    parentRevision: 'old',
    settingsRevision: 1,
    settings: { status: false, maxCalls: 4 },
    request: 'CURRENT_SENTINEL',
    history: [{ revision: 'old', text: 'HISTORY_SENTINEL' }],
    resources: [],
    profile: {
      ...defaultProfile('chat'),
      models: {},
      packages: [pkg],
      packageAttachments: [{ id: 'pkg', revision: 1, role: 'module' }],
    },
  };
}
const texts = (s: RunSnapshot) =>
  s.promptCompilation!.messages.map((m) => m.content.map((c) => c.text).join('')).join('\n');
test('places authored pinned references once before the current input', () => {
  const s = compileSnapshotPrompt(fixture()),
    text = texts(s);
  expect(text.match(/BACKGROUND_SENTINEL/g)).toHaveLength(1);
  expect(text.match(/SCENE_SENTINEL/g)).toHaveLength(1);
  expect(text.indexOf('BACKGROUND_SENTINEL')).toBeLessThan(text.indexOf('HISTORY_SENTINEL'));
  expect(text.indexOf('SCENE_SENTINEL')).toBeLessThan(text.indexOf('CURRENT_SENTINEL'));
});
test('ordering is stable inside package-role groups and independent of folders', () => {
  const s = fixture(),
    pkg = s.profile!.packages![0];
  pkg.loreFolders = [{ id: 'folder', name: 'Folder' }];
  pkg.lore[0].folderId = 'folder';
  expect(
    compiledPackages(s, 'main')[0]
      .resources.filter((r) => r.sourceKind === 'lore')
      .map((r) => r.title)
  ).toEqual(['B', 'A']);
  expect(
    compiledPackages(s, 'main')[0].resources.find((r) => r.sourceKind === 'lore')!.loreContext
  ).toEqual({
    placement: 'scene',
    group: 'g',
    order: 1,
  });
  pkg.lore[0].loreContext!.order = NaN;
  expect(() => validateRisuContent(pkg)).toThrow('PACKAGE_LORE_ORDER');
});
test('pinned budget fails explicitly without silently dropping content', () => {
  const s = fixture();
  s.profile!.loreContext = {
    ...DEFAULT_LORE_CONTEXT,
    enabled: true,
    maxRetainedTokens: 100,
    maxRetainedEntries: 2,
    maxPinnedTokens: 2,
  };
  expect(() => buildMainInput(s)).toThrow('LORE_PINNED_BUDGET_EXCEEDED');
});
test('four native wire codecs deliver pinned bodies once and preserve fixed prefix across turns', async () => {
  const s = fixture();
  s.profile!.models.main = {
    id: 'm',
    revision: 1,
    title: 'M',
    connectionId: 'c',
    modelId: 'gpt-5.6',
    capabilityProtocol: 'openai-responses-v1',
    maxOutputTokens: 1000,
    temperature: null,
    connection: {
      id: 'c',
      revision: 1,
      title: 'C',
      protocol: 'openai-responses-v1',
      endpoint: 'http://127.0.0.1:19999',
      enabled: true,
      catalog: [],
      catalogError: null,
    },
  };
  const first = buildMainProviderRequest(await prepareNativeRisuRun(s));
  for (const encode of [encodeResponses, encodeChat, encodeAnthropic, encodeVertex]) {
    const body = JSON.stringify(
      encode({
        ...first.request,
        ...(encode === encodeVertex ? { modelId: VERTEX_GEMINI_MODEL_ID } : {}),
      }).body
    );
    expect(body.match(/BACKGROUND_SENTINEL/g)).toHaveLength(1);
    expect(body.match(/SCENE_SENTINEL/g)).toHaveLength(1);
  }
  const next = structuredClone(s);
  next.parentRevision = 'new';
  next.request = 'NEXT_CURRENT';
  next.history.push({ revision: 'new', text: 'NEW_HISTORY' });
  next.logicalHistory = [
    { id: 'source:old', role: 'assistant', text: 'HISTORY_SENTINEL', sourceRevision: 'old' },
    { id: 'request:new', role: 'user', text: s.request, sourceRevision: 'new' },
    { id: 'source:new', role: 'assistant', text: 'NEW_HISTORY', sourceRevision: 'new' },
  ];
  const second = buildMainProviderRequest(await prepareNativeRisuRun(next));
  for (const encode of [encodeResponses, encodeChat, encodeAnthropic, encodeVertex]) {
    const wirePrefix = (request: typeof first.request) => {
      const wire = encode({
        ...request,
        ...(encode === encodeVertex ? { modelId: VERTEX_GEMINI_MODEL_ID } : {}),
      }).body as Record<string, any>;
      const messages = wire.input ?? wire.messages ?? wire.contents;
      const end = messages.findIndex((m: unknown) =>
        JSON.stringify(m).includes('HISTORY_SENTINEL')
      );
      expect(end).toBeGreaterThanOrEqual(0);
      return {
        system: wire.system,
        systemInstruction: wire.systemInstruction,
        instructions: wire.instructions,
        tools: wire.tools,
        messages: messages.slice(0, end + 1),
      };
    };
    expect(wirePrefix(second.request)).toEqual(wirePrefix(first.request));
  }
  const prefix = (run: RunSnapshot) =>
    run.promptCompilation!.messages.slice(
      0,
      run.promptCompilation!.messages.findIndex((m) => m.provenance.origin === 'history')
    );
  expect(prefix(second.snapshot)).toEqual(prefix(first.snapshot));
});
