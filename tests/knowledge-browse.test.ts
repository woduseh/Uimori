import { expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { nativeContent } from './fixtures/native-content.js';
import { defaultProfile } from '../core/product.js';
import {
  executeTool,
  roleResources,
  knowledgeReadResults,
  buildMainInput,
} from '../core/provider.js';
import type { Resource, RunSnapshot } from '../core/types.js';
import { nativeRisuFieldKey } from '../core/risu-native-execution.js';
import type { RisuContent } from '../core/risu-content.js';

function fixture(): RunSnapshot {
  const pkg: RisuContent = {
    ...nativeContent({ name: '에르시아', description: '항상 포함되는 본문' }, { id: 'world' }),
    loreFolders: [
      { id: 'law', name: '법규' },
      { id: 'people', name: '인물' },
      { id: 'empty', name: '빈 폴더' },
    ],
    lore: [
      {
        id: 'rule',
        title: '마도 행정청',
        description: '마력 사용자 등록',
        text: '수도 입성 전에 마력 사용자는 등록해야 한다.',
        loading: 'discoverable',
        folderId: 'law',
      },
      {
        id: 'person',
        title: '세실리아',
        description: '탐험가',
        text: '인물의 원문.',
        loading: 'pinned',
        folderId: 'people',
        relatedIds: ['rule'],
      },
      {
        id: 'unfiled',
        title: '서문',
        description: '미분류',
        text: '미분류 원문.',
        loading: 'discoverable',
      },
    ],
  };
  const loose: Resource = {
    id: 'loose',
    revision: 1,
    chatId: 'chat',
    kind: 'lore',
    title: '별도 자료',
    description: '',
    text: '독립 원문',
  };
  return {
    chatId: 'chat',
    parentRevision: null,
    settingsRevision: 1,
    settings: { status: false, maxCalls: 8 },
    request: '설정 확인',
    history: [],
    resources: [loose, { ...loose, id: 'foreign', chatId: 'elsewhere', title: '누출 금지' }],
    profile: {
      ...defaultProfile('chat'),
      models: {},
      packages: [pkg],
      packageAttachments: [
        { id: pkg.id, revision: 1, role: 'bot' },
        { id: pkg.id, revision: 1, role: 'persona' },
      ],
    },
  };
}
function call(
  s: RunSnapshot,
  args: Record<string, unknown>,
  role: 'main' | 'translation' = 'main'
) {
  return executeTool(s, { callId: 'synthetic', name: 'knowledge.search', args }, undefined, role);
}
function browse(s: RunSnapshot, args: Record<string, unknown> = {}) {
  const result = call(s, { mode: 'browse', ...args });
  expect(result.denied, JSON.stringify(result.result)).toBe(false);
  return result.result as any;
}
function follow(s: RunSnapshot, item: any) {
  const result = executeTool(s, {
    callId: 'follow',
    name: item.nextRead.name,
    args: item.nextRead.arguments,
  });
  expect(result.denied, JSON.stringify(result.result)).toBe(false);
  return result.result as any;
}

test('folder navigation reaches an exact lore read after a vocabulary mismatch without losing unfiled references', () => {
  const s = fixture(),
    before = structuredClone(s);
  expect((call(s, { query: '수도 허가 마법' }).result as any).total).toBe(0);
  const root = browse(s);
  expect(root.coverage.content).toBe('metadata-only');
  expect(root.items.filter((item: any) => item.type === 'package')).toHaveLength(2);
  expect(JSON.stringify(root)).not.toContain('누출 금지');
  expect(root.items.some((item: any) => item.id === 'loose')).toBe(true);
  const bot = root.items.find((item: any) => item.type === 'package' && item.role === 'bot');
  const pack = follow(s, bot);
  expect(
    pack.items.filter((item: any) => item.type === 'folder').map((item: any) => item.title)
  ).toEqual(['법규', '인물']);
  expect(pack.items.some((item: any) => item.id?.endsWith(':lore:unfiled'))).toBe(true);
  const law = follow(
    s,
    pack.items.find((item: any) => item.type === 'folder' && item.title === '법규')
  );
  expect(law.items).toHaveLength(1);
  const entry = law.items[0];
  expect(entry.id).toBe('package:world:bot:lore:rule');
  expect(entry).not.toHaveProperty('text');
  const read = follow(s, entry).items[0].read;
  expect(read.text).toBe(s.profile!.packages![0].lore[0].text);
  expect(read.source.hash).toBe(entry.sourceHash);
  expect(knowledgeReadResults(call(s, { mode: 'browse' }))).toEqual([]);
  expect(s).toEqual(before);
});

test('same folder and entry IDs in different attachment roles and scoped overrides never alias', () => {
  const s = fixture(),
    pkg = s.profile!.packages![0];
  const attachment = { id: pkg.id, revision: 1, role: 'bot' as const };
  s.profile!.chatOverrides = {
    version: 1,
    revision: 1,
    roots: [],
    entries: [],
    headRevision: null,
    headHash: null,
    conflicts: [],
    projections: ['bot', 'persona'].map((role, i) => ({
      scope: { id: 'root', role: role as 'bot' | 'persona', modulePath: [] },
      attachment,
      package: {
        ...pkg,
        lore: pkg.lore.map((entry) => ({
          ...entry,
          text: `경로 ${i}의 ${entry.id}`,
          folderId: i ? 'people' : 'law',
        })),
      },
      overrideIds: [],
      conflicts: [],
    })),
  };
  const root = browse(s);
  const packages = root.items.filter((item: any) => item.type === 'package');
  expect(packages).toHaveLength(4); // base identity, two effective link scopes, and persona
  expect(packages.filter((item: any) => item.sourceScope !== null)).toHaveLength(2);
  expect(new Set(packages.map((item: any) => item.nodeRef)).size).toBe(4);
  const reads: string[] = [];
  for (const group of packages) {
    const children = follow(s, group);
    for (const folder of children.items.filter((item: any) => item.type === 'folder')) {
      const entries = follow(s, folder);
      for (const entry of entries.items) reads.push(follow(s, entry).items[0].read.text);
    }
  }
  expect(reads).toContain('경로 0의 rule');
  expect(reads).toContain('경로 1의 rule');
  expect(reads).toContain(pkg.lore[0].text);
});

test('paging remains bounded and lossless, including oversized authored metadata and skills', () => {
  const s = fixture();
  s.profile!.packages = [];
  s.profile!.packageAttachments = [];
  s.resources = Array.from(
    { length: 140 },
    (_, i): Resource => ({
      id: `entry-${i}`,
      revision: 1,
      chatId: s.chatId,
      kind: i === 139 ? 'skill' : 'lore',
      title: '😀'.repeat(200),
      description: '"\n'.repeat(10000),
      text: `원문 ${i}`,
      relatedIds: ['outside-scope', 'entry-1'],
    })
  );
  let page = browse(s, { limit: 100 });
  const ids: string[] = [];
  for (;;) {
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(24000);
    for (const item of page.items) {
      expect(item.description.length).toBeLessThanOrEqual(160);
      expect(item.title.isWellFormed()).toBe(true);
      expect(item.relatedIds).not.toContain('outside-scope');
      ids.push(item.id);
      if (item.kind === 'skill') expect(follow(s, item).text).toBe('원문 139');
    }
    if (!page.nextRead) break;
    page = follow(s, page);
  }
  expect(ids).toEqual(s.resources.map((resource) => resource.id));
  expect(new Set(ids).size).toBe(140);
  expect(call(s, { mode: 'browse', offset: 1 }).denied).toBe(true);
});

test('browse references bind the effective frozen corpus and role, including rendered text with unchanged package revision', () => {
  const s = fixture(),
    root = browse(s);
  const bot = root.items.find((item: any) => item.role === 'bot');
  const changed = structuredClone(s);
  const key = nativeRisuFieldKey(changed.profile!.packageAttachments![0]);
  changed.nativeRisuExecution = {
    version: 2,
    inputHash: 'rendered',
    beforeVariableRevision: 0,
    variables: {},
    fields: { [key]: { 'lore:rule': '새 실행의 유효 원문' } },
    request: '',
    messages: [],
    history: [],
    issues: [],
  };
  const oldArgs = bot.nextRead.arguments;
  expect(call(changed, oldArgs)).toMatchObject({
    denied: true,
    result: { code: 'KNOWLEDGE_VIEW_CHANGED' },
  });
  expect(call(s, oldArgs, 'translation').denied).toBe(true);
  const restarted = browse(changed);
  const pack = follow(
    changed,
    restarted.items.find((item: any) => item.role === 'bot')
  );
  const law = follow(
    changed,
    pack.items.find((item: any) => item.type === 'folder' && item.title === '법규')
  );
  expect(law.items[0].sourceHash).toBe(
    createHash('sha256').update('새 실행의 유효 원문').digest('hex')
  );
  expect(follow(changed, law.items[0]).items[0].read.text).toBe('새 실행의 유효 원문');
  expect(follow(s, bot).items.length).toBeGreaterThan(0);
});

test('browsing is optional and never changes pinned placement, runtime order or the initial flat catalog', () => {
  const s = fixture();
  const before = roleResources(s).map(({ id, text, loading }) => ({ id, text, loading }));
  const catalog = buildMainInput(s).catalog;
  browse(s);
  const moved = structuredClone(s);
  const pkg = moved.profile!.packages![0];
  pkg.loreFolders![0].name = '새 분류';
  pkg.lore[0].folderId = 'people';
  expect(roleResources(moved).map(({ id, text, loading }) => ({ id, text, loading }))).toEqual(
    before
  );
  expect(buildMainInput(moved).catalog).toEqual(catalog);
  expect(call(s, { mode: 'search', query: '마도' }).result).toEqual(
    call(s, { query: '마도' }).result
  );
  for (const args of [
    { mode: 'browse', query: '마도' },
    { mode: 'browse', nodeRef: 'invented' },
    { mode: 'unknown' },
    { nodeRef: 'invented' },
  ])
    expect(call(s, args).denied).toBe(true);
});
