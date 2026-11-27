import { parse } from '@babel/parser';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  forgetBotStorage,
  forgetChatStorage,
  forgetMissingBots,
  forgetMissingChats,
  localStorageNamespaces,
  storageFamilies,
  storageFamily,
  storageKeys,
  sweepUnregisteredStorage,
} from '../web/storage-keys.js';

class MemoryStorage {
  values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, String(value));
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
let local: MemoryStorage;
let session: MemoryStorage;
beforeEach(() => {
  local = new MemoryStorage();
  session = new MemoryStorage();
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
});
afterEach(() => vi.unstubAllGlobals());

test('builders keep the key names browsers already hold', () => {
  const scope = JSON.stringify({ kind: 'chat', chatId: 'c1' });
  expect([
    storageKeys.uiLanguage,
    storageKeys.libraryViews,
    storageKeys.botTree,
    storageKeys.readingPosition('c1'),
    storageKeys.activityAcknowledgement('c1', '["main","r1",0,"2026-01-01"]'),
    storageKeys.chatFolders('b1'),
    storageKeys.illustrationCollapsed('cut'),
    storageKeys.promptOptionGroup('controls:Tone'),
    storageKeys.helperConfirmationDeclined('t1', 'k1'),
    storageKeys.helperSession('chat:c1'),
    storageKeys.helperSessionScope(scope),
    storageKeys.helperSeen('h1'),
    storageKeys.helperCreate(`${scope}:project:p1`),
    storageKeys.helperCopy('h1'),
    storageKeys.helperProjectCreate('Title'),
    storageKeys.command('c1'),
    storageKeys.draft('c1'),
    storageKeys.draftCursor(storageKeys.draft('c1')),
    storageKeys.requestState(storageKeys.draft('c1')),
    storageKeys.loreReset(storageKeys.draft('c1')),
    storageKeys.inputTranslationOriginal(storageKeys.draft('c1')),
    storageKeys.forkCommand('c1', null),
    storageKeys.sceneDeletion('c1', 's1'),
    storageKeys.outlineWorkspace('c1'),
    storageKeys.storyUiDraft('c1', 's1', 'h', 'b'),
    storageKeys.textDraft('s1', 'original'),
    storageKeys.turnActivity('c1', 'r1'),
    storageKeys.helperTaskActivity('h1', 't1', true),
    storageKeys.helperTaskActivity('h1', 't1', false),
  ]).toEqual([
    'uimori:ui-language',
    'uimori-library-views',
    'uimori.bot-tree.v1',
    'reading:c1',
    'uimori:activity-acknowledged:v1:"c1":["main","r1",0,"2026-01-01"]',
    'uimori.chat-folders.b1',
    'uimori:illustration-collapsed:cut',
    'uimori:prompt-option-group:controls:Tone',
    'uimori:helper-confirmation-declined:t1:k1',
    'uimori:helper-session:chat:c1',
    `uimori:helper-session-scope:${scope}`,
    'uimori:helper-seen:h1',
    `uimori:helper-create:${scope}:project:p1`,
    'uimori:helper-copy:h1',
    'uimori:helper-project-create:Title',
    'command:c1',
    'draft:c1',
    'cursor:draft:c1',
    'request-state:draft:c1',
    'lore-reset:draft:c1',
    'input-translation:draft:c1',
    'fork-command:c1:null',
    'scene-delete:c1:s1',
    'outline-workspace:c1',
    'uimori:story-ui-draft:c1:s1:h:b',
    'uimori:text-draft:s1:original',
    'turn-activity:c1:r1',
    'helper-task-activity:h1:t1:settled',
    'helper-task-activity:h1:t1',
  ]);
  for (const value of Object.values(storageKeys)) {
    const key =
      typeof value === 'function'
        ? (value as (...parts: unknown[]) => string)('x', 'y', false)
        : value;
    expect(
      storageFamily('local', key) ?? storageFamily('session', key),
      `${key} has no family`
    ).toBeDefined();
  }
  expect(localStorageNamespaces().toSorted()).toEqual([
    'reading:',
    'uimori-',
    'uimori.',
    'uimori:',
  ]);
});

test('the startup sweep removes only unregistered keys in the app namespaces of localStorage', () => {
  const kept = {
    [storageKeys.theme]: 'dark',
    [storageKeys.readingPosition('c1')]: '{}',
    [storageKeys.chatFolders('b1')]: '{"b1:":true}',
    [storageKeys.helperCreate('{"kind":"library"}')]: '{"requestKey":"k"}',
    [storageKeys.helperCopy('h1')]: '{"requestKey":"k"}',
    'other-app:setting': '1',
    'test-helper-read-fails': '1',
  };
  for (const [key, value] of Object.entries(kept)) local.setItem(key, value);
  for (const key of [
    'uimori:editor-buffer:content:a',
    'uimori:helper-outbox:retired',
    'uimori:helper-input:retired',
    'uimori:helper-artifact-draft:a:1',
    'uimori:helper-sidebar-width',
    'uimori:unknown-setting',
    'uimori.provider-registration.request-key',
    'uimori-retired-view',
  ])
    local.setItem(key, 'x');
  session.setItem('uimori:unknown-session', 'x');
  sweepUnregisteredStorage();
  expect(Object.fromEntries(local.values)).toEqual(kept);
  expect(session.getItem('uimori:unknown-session')).toBe('x');
});

test('unsent work and recovery receipts are registered and therefore never swept', () => {
  const work = storageFamilies.filter((family) => family.work).map((family) => family.key);
  expect(work).toEqual(
    expect.arrayContaining([
      'uimori:helper-create:',
      'uimori:helper-copy:',
      'uimori:helper-project-create:',
      'command:',
      'draft:',
      'queued-request:',
      'pending-profile:',
      'fork-command:',
      'scene-delete:',
    ])
  );
  expect(storageFamilies.filter((family) => family.work && family.cap)).toEqual([]);
});

test('deleting a chat or bot, or its absence from the server list, removes its browser state', () => {
  const chatScope = JSON.stringify({ kind: 'chat', chatId: 'gone' });
  const ownedByGone = [
    storageKeys.readingPosition('gone'),
    storageKeys.activityAcknowledgement('gone', '["main","r",0,"2026-01-01"]'),
    storageKeys.helperSession('chat:gone'),
    storageKeys.helperSessionScope(chatScope),
  ];
  const others = [
    storageKeys.readingPosition('live'),
    storageKeys.activityAcknowledgement('live', '["main","r",0,"2026-01-01"]'),
    storageKeys.helperSession('all'),
    storageKeys.helperSessionScope(JSON.stringify({ kind: 'library', workId: 'workspace' })),
    storageKeys.helperCreate(chatScope),
    storageKeys.chatFolders('bot'),
  ];
  for (const key of [...ownedByGone, ...others]) local.setItem(key, '1');
  session.setItem(storageKeys.readingPosition('gone'), '{}');
  forgetChatStorage('gone');
  expect([...local.values.keys()]).toEqual(others);
  expect(session.getItem(storageKeys.readingPosition('gone'))).toBeNull();

  for (const key of ownedByGone) local.setItem(key, '1');
  forgetMissingChats(new Set(['live']));
  expect([...local.values.keys()]).toEqual(others);
  forgetMissingChats(new Set());
  expect(local.getItem(storageKeys.readingPosition('live'))).toBeNull();
  expect(local.getItem(storageKeys.helperCreate(chatScope))).toBe('1');

  local.setItem(storageKeys.chatFolders('other'), '{}');
  forgetBotStorage('bot');
  expect(local.getItem(storageKeys.chatFolders('bot'))).toBeNull();
  forgetMissingBots(new Set(['other']));
  expect(local.getItem(storageKeys.chatFolders('other'))).toBe('{}');
  forgetMissingBots(new Set());
  expect(local.getItem(storageKeys.chatFolders('other'))).toBeNull();
});

const webRoot = resolve(import.meta.dirname, '../web');
const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? entry.name === 'locales'
        ? []
        : sourceFiles(resolve(directory, entry.name))
      : /\.tsx?$/u.test(entry.name)
        ? [resolve(directory, entry.name)]
        : []
  );
const notStorageKeys: Record<string, string> = {
  'uimori:notification-open': 'service worker message type',
  'uimori-editor-recovery': 'IndexedDB database name',
  'uimori-presentation': 'IndexedDB database name',
  'uimori-archive': 'file type marker',
  'uimori-backup.sqlite': 'download file name',
  'uimori-editor-context-changed': 'window event name',
  'uimori-theme-css': 'style element id',
  'uimori-theme-': 'generated asset name',
  'uimori-': 'exported file name',
};
const storageCalls: Record<string, number> = {
  readOptionalStorage: 1,
  readOptionalJson: 1,
  writeOptionalStorage: 1,
  removeOptionalStorage: 1,
  readPresentationSetting: 0,
  writePresentationSetting: 0,
  removePresentationSetting: 0,
  readPresentationChoice: 0,
  writeRecentStorage: 0,
  removeRecentStorage: 0,
};
type Node = { type: string; [key: string]: unknown };
function visit(node: unknown, parents: Node[], use: (node: Node, parents: Node[]) => void) {
  if (!node || typeof node !== 'object') return;
  const current = node as Node;
  if (typeof current.type === 'string') use(current, parents);
  const next = typeof current.type === 'string' ? [...parents, current] : parents;
  for (const [key, value] of Object.entries(current)) {
    if (key === 'loc' || key === 'extra' || key === 'comments') continue;
    if (Array.isArray(value)) for (const child of value) visit(child, next, use);
    else if (value && typeof value === 'object') visit(value, next, use);
  }
}
const calleeName = (node: Node): string | undefined => {
  const callee = node.callee as Node;
  if (callee.type === 'Identifier') return callee.name as string;
  if (callee.type === 'MemberExpression') return ((callee.property as Node).name as string) ?? '';
  return undefined;
};
function nonStorageUse(parents: Node[]) {
  const parent = parents.at(-1);
  if (!parent) return false;
  if (parent.type === 'NewExpression' || parent.type === 'CallExpression') {
    const name = calleeName(parent);
    return ['Event', 'CustomEvent', 'addEventListener', 'removeEventListener', 'request'].includes(
      name ?? ''
    );
  }
  return (
    parent.type === 'VariableDeclarator' &&
    /Event$|EVENT$/u.test(((parent.id as Node).name as string) ?? '')
  );
}

test('every storage key in the web source is registered in web/storage-keys.ts', () => {
  const namespaces = localStorageNamespaces();
  const failures: string[] = [];
  for (const file of sourceFiles(webRoot)) {
    const name = relative(resolve(webRoot, '..'), file).replaceAll('\\', '/');
    if (name === 'web/storage-keys.ts') continue;
    const source = readFileSync(file, 'utf8');
    const tree = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
    visit(tree, [], (node, parents) => {
      const line = (node.loc as { start: { line: number } }).start.line;
      if (node.type === 'CallExpression') {
        const callee = node.callee as Node;
        const index =
          callee.type === 'Identifier'
            ? storageCalls[callee.name as string]
            : callee.type === 'MemberExpression' &&
                ['getItem', 'setItem', 'removeItem'].includes(
                  (callee.property as Node).name as string
                )
              ? 0
              : undefined;
        const key = index === undefined ? undefined : (node.arguments as Node[])[index];
        if (key && ['StringLiteral', 'TemplateLiteral', 'BinaryExpression'].includes(key.type))
          failures.push(
            `${name}:${line}: builds a storage key inline; declare it in web/storage-keys.ts and use storageKeys`
          );
        return;
      }
      const text =
        node.type === 'StringLiteral'
          ? (node.value as string)
          : node.type === 'TemplateLiteral'
            ? ((node.quasis as Node[])[0]!.value as { cooked: string }).cooked
            : undefined;
      if (text === undefined || !namespaces.some((namespace) => text.startsWith(namespace))) return;
      if (
        parents.at(-1)?.type === 'TemplateLiteral' ||
        notStorageKeys[text] ||
        nonStorageUse(parents)
      )
        return;
      const exact = node.type === 'StringLiteral' || (node.quasis as Node[]).length === 1;
      const covered = exact
        ? storageFamily('local', text) || storageFamily('session', text)
        : storageFamilies.some(
            (family) => family.match === 'prefix' && text.startsWith(family.key)
          );
      if (!covered)
        failures.push(
          `${name}:${line}: "${text}" looks like a browser storage key but is not registered; add it to web/storage-keys.ts (or to notStorageKeys in this test if it is not a storage key)`
        );
    });
  }
  expect(failures).toEqual([]);
});
