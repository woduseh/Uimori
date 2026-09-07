import { expect, test } from 'vitest';
import { defaultProfile, VERTEX_GEMINI_MODEL_ID } from '../core/product.js';
import { modelCapability } from '../core/model-capabilities.js';
import { validateContentPackage, type ContentPackage } from '../core/content-package.js';
import { compiledPackages } from '../core/package-context.js';
import { buildMainInput } from '../core/provider.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import type { RunSnapshot } from '../core/types.js';
import type { PromptProgram } from '../core/prompt-program.js';
import { buildMainProviderRequest } from '../server/main-request.js';
import { encodeResponses } from '../core/openai-protocol.js';
import { encodeChat } from '../core/openai-chat-protocol.js';
import { encodeAnthropic } from '../core/anthropic-protocol.js';
import { encodeVertex } from '../core/vertex-protocol.js';
import {
  appendLoreReads,
  loreHistory,
  DEFAULT_LORE_CONTEXT,
  type RetainedLore,
  type LoreContextSnapshot,
} from '../core/lore-context.js';

function fixture(): RunSnapshot {
  const pkg: ContentPackage = {
    version: 1,
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
    instructions: [],
    controls: [],
    transforms: [],
  };
  return {
    chatId: 'chat',
    parentRevision: 'old',
    settingsRevision: 1,
    settings: { preset: 'calm', mode: 'direct', translation: false, status: false, maxCalls: 4 },
    request: 'CURRENT_SENTINEL',
    history: [{ revision: 'old', text: 'HISTORY_SENTINEL' }],
    resources: [],
    profile: {
      ...defaultProfile('chat'),
      contents: [],
      models: {},
      packages: [pkg],
      packageAttachments: [{ id: 'pkg', revision: 1, role: 'module' }],
    },
  };
}
const texts = (s: RunSnapshot) =>
  s.promptCompilation!.messages.map((m) => m.content.map((c) => c.text).join('')).join('\n');
test('places background before history and scene next to current exactly once', () => {
  const s = compileSnapshotPrompt(fixture()),
    text = texts(s);
  expect(text.match(/BACKGROUND_SENTINEL/g)).toHaveLength(1);
  expect(text.match(/SCENE_SENTINEL/g)).toHaveLength(1);
  expect(text.indexOf('BACKGROUND_SENTINEL')).toBeLessThan(text.indexOf('HISTORY_SENTINEL'));
  expect(text.indexOf('HISTORY_SENTINEL')).toBeLessThan(text.indexOf('SCENE_SENTINEL'));
  expect(text.indexOf('SCENE_SENTINEL')).toBeLessThan(text.indexOf('CURRENT_SENTINEL'));
});
test('disabled and untaken slots cannot suppress fallback; custom cache anchors stay fixed', () => {
  const program: PromptProgram = {
    version: 1,
    controls: [],
    blocks: [
      { id: 'off', title: 'off', kind: 'slot', slot: 'references', role: 'system', enabled: false },
      {
        id: 'system',
        title: 'system',
        kind: 'message',
        role: 'system',
        template: [
          { kind: 'text', text: 'CUSTOM' },
          { kind: 'if', condition: false, then: [{ kind: 'slot', name: 'backgroundLore' }] },
        ],
      },
      { id: 'cache', title: 'cache', kind: 'cache', role: 'all', depth: 1, policy: 'prefer' },
      { id: 'history', title: 'history', kind: 'history', from: 0, to: 'end' },
    ],
  };
  const s = compileSnapshotPrompt(fixture(), program);
  expect(texts(s).match(/BACKGROUND_SENTINEL/g)).toHaveLength(1);
  expect(s.promptCompilation!.usedSlots).toEqual([]);
  expect(s.promptCompilation!.cachePlan[0].afterMessageId).toBe('system');
  expect(s.promptCompilation!.messages[0].role).toBe('system');
});
test('consumed custom references suppress automatic pinned delivery', () => {
  const s = compileSnapshotPrompt(fixture(), {
    version: 1,
    controls: [],
    blocks: [
      { id: 'refs', title: 'refs', kind: 'slot', slot: 'references', role: 'user' },
      { id: 'history', title: 'history', kind: 'history', from: 0, to: 'end' },
    ],
  });
  expect(texts(s).match(/BACKGROUND_SENTINEL/g)).toHaveLength(1);
  expect(texts(s).match(/SCENE_SENTINEL/g)).toHaveLength(1);
});
test('custom lore consumes module body and identity as well as legacy pinned module content once', () => {
  const s = fixture(),
    pkg = s.profile!.packages![0];
  pkg.body = 'MODULE_BODY';
  pkg.identity = { name: 'N', description: 'MODULE_IDENTITY' };
  s.profile!.contents.push({
    id: 'legacy',
    revision: 1,
    kind: 'module',
    title: 'Legacy',
    description: '',
    text: 'LEGACY_MODULE',
    loading: 'pinned',
    relatedIds: [],
  });
  const result = compileSnapshotPrompt(s, {
    version: 1,
    controls: [],
    blocks: [
      { id: 'lore', title: 'Lore', kind: 'slot', role: 'user', slot: 'lore' },
      { id: 'history', title: 'History', kind: 'history', from: 0, to: 'end' },
    ],
  });
  for (const marker of ['MODULE_BODY', 'MODULE_IDENTITY', 'LEGACY_MODULE'])
    expect(texts(result).split(marker)).toHaveLength(2);
  expect(result.promptCompilation!.messages.some((m) => m.id === '__host_background_lore__')).toBe(
    false
  );
});
test('fallback cannot bypass provider part or aggregate message limits', () => {
  const s = fixture();
  s.profile!.packages![0].lore[0].text = 'x'.repeat(510_000);
  s.profile!.loreContext = { ...DEFAULT_LORE_CONTEXT, maxPinnedChars: 600_000 };
  expect(() =>
    compileSnapshotPrompt(s, {
      version: 1,
      controls: [],
      blocks: [{ id: 'history', title: 'History', kind: 'history', from: 0, to: 'end' }],
    })
  ).toThrow();
  const many = fixture();
  many.history = Array.from({ length: 999 }, (_, i) => ({ revision: `r${i}`, text: 'H' }));
  expect(() =>
    compileSnapshotPrompt(many, {
      version: 1,
      controls: [],
      blocks: [{ id: 'history', title: 'History', kind: 'history', from: 0, to: 'end' }],
    })
  ).toThrow('PROMPT_INVALID_COMPILED');
});
test('ordering is stable inside package-role groups and independent of folders', () => {
  const s = fixture(),
    pkg = s.profile!.packages![0];
  pkg.loreFolders = [{ id: 'folder', name: 'Folder' }];
  pkg.lore[0].folderId = 'folder';
  expect(compiledPackages(s, 'main')[0].resources.map((r) => r.title)).toEqual(['B', 'A']);
  expect(compiledPackages(s, 'main')[0].resources[0].loreContext).toEqual({
    placement: 'scene',
    group: 'g',
    order: 1,
  });
  pkg.lore[0].loreContext!.order = NaN;
  expect(() => validateContentPackage(pkg)).toThrow('PACKAGE_LORE_ORDER');
});
test('pinned budget fails explicitly without silently dropping content', () => {
  const s = fixture();
  s.profile!.loreContext = {
    enabled: true,
    maxRetainedChars: 100,
    maxRetainedEntries: 2,
    maxPinnedChars: 2,
  };
  expect(() => buildMainInput(s)).toThrow('LORE_PINNED_BUDGET_EXCEEDED');
});
test('four native wire codecs deliver pinned bodies once and preserve fixed prefix across turns', () => {
  const s = fixture();
  s.profile!.models.main = {
    id: 'm',
    revision: 1,
    title: 'M',
    connectionId: 'c',
    modelId: 'gpt-5.6',
    capabilityProtocol: 'openai-responses-v1',
    capabilityRevision: modelCapability('openai-responses-v1', 'gpt-5.6')!.revision,
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
  const first = buildMainProviderRequest(s);
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
  const second = buildMainProviderRequest(next);
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
  const messages = first.snapshot.promptCompilation!.messages;
  expect(messages.findIndex((m) => m.id === 'native.host-context')).toBeGreaterThan(
    messages.findIndex((m) => m.provenance.origin === 'history')
  );
});
test('a new retained read appends without changing old reference ranges or text', () => {
  const first: RetainedLore = {
    id: 'resource',
    revision: 1,
    hash: 'hash',
    title: 'R',
    start: 0,
    end: 3,
    text: 'ABC',
    origin: { sourceRevision: 'old', sourceHash: 'old-hash', runId: 'run', callId: 'call' },
    lastUsed: 'old',
  };
  const read: RetainedLore = {
    ...first,
    start: 1,
    end: 6,
    text: 'BCDEF',
    origin: { sourceRevision: 'new', sourceHash: 'new-hash', runId: 'run2', callId: 'call2' },
    lastUsed: 'new',
  };
  const appended = appendLoreReads([first], [read], DEFAULT_LORE_CONTEXT, ['old', 'new']);
  expect(appended.entries.map(({ lastUsed: _lastUsed, ...entry }) => entry)).toEqual([
    (({ lastUsed: _lastUsed, ...entry }) => entry)(first),
    (({ lastUsed: _lastUsed, ...entry }) => entry)({ ...read, start: 3, end: 6, text: 'DEF' }),
  ]);
  const context = (entries: RetainedLore[]): LoreContextSnapshot => ({
    version: 1,
    policy: DEFAULT_LORE_CONTEXT,
    canonHash: 'canon',
    dependencies: [],
    entries,
    stats: {
      retainedChars: 0,
      retainedEntries: entries.length,
      appendedChars: 0,
      droppedEntries: 0,
      reasons: [],
    },
  });
  const history = [
    { id: 'old', role: 'assistant' as const, text: 'OLD', sourceRevision: 'old' },
    { id: 'new', role: 'assistant' as const, text: 'NEW', sourceRevision: 'new' },
  ];
  expect(loreHistory(history, context(appended.entries))[0]).toEqual(
    loreHistory(history, context([first]))[0]
  );
});
