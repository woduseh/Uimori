import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionProgramError, type ExtensionProgram } from '../core/extension-program.js';
import type { RuntimeValue } from '../core/prompt-values.js';
import type { RunSnapshot } from '../core/types.js';
import { Store } from '../server/store.js';
import { exportChatTranscript, importChatTranscript } from '../server/chat-transcript.js';
import {
  captureExtensionConversation,
  createConversationExtensionHost,
  extensionConversationViewHash,
  resolveExtensionConversation,
} from '../server/extension-conversation.js';
import { createFixtureChat } from './fixtures/chat.js';

const owned: { dir: string; store: Store }[] = [];
afterEach(() => {
  for (const { dir, store } of owned.splice(0)) {
    store.close();
    const rel = relative(resolve(tmpdir()), resolve(dir));
    if (isAbsolute(rel) || rel.startsWith('..') || !rel.startsWith('uimori-conversation-tests-'))
      throw new Error('Unsafe cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
function database() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-conversation-tests-'));
  const store = new Store(join(dir, 'story.sqlite'));
  owned.push({ dir, store });
  return store;
}
function snapshot(store: Store, chatId: string, branchId?: string): RunSnapshot {
  const chat = store.chat(chatId);
  const branch = store.product.branch(chatId, branchId);
  return {
    chatId,
    branchId: branch.id,
    parentRevision: branch.headRevision,
    settingsRevision: chat.settingsRevision,
    settings: chat.settings,
    request: '',
    history: store.history(branch.headRevision),
    resources: [],
  };
}
function run(store: Store, chatId: string, request: string, branchId?: string) {
  const base = snapshot(store, chatId, branchId);
  const run = store.createRun(
    chatId,
    {
      request,
      branchId: base.branchId,
      expectedRevision: base.parentRevision,
      expectedSettingsRevision: base.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    () => ({ ...base, request })
  ).run;
  store.startRun(run.id);
  return run;
}
function turn(store: Store, chatId: string, request: string, text: string, branchId?: string) {
  const item = run(store, chatId, request, branchId);
  return store.completeRun(
    item.id,
    text,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    item.snapshot.settings
  );
}
function failed(store: Store, chatId: string, request: string, partial = '', branchId?: string) {
  const item = run(store, chatId, request, branchId);
  store.finishRun(item.id, 'failed', 'SYNTHETIC_FAILURE', partial);
  return item;
}
const program = (capability = true): ExtensionProgram => ({
  api: 'uimori-state-action-v1',
  source: 'return {state:api.state,result:null}',
  ...(capability ? { capabilities: ['conversation.read'] } : {}),
});
const signal = () => new AbortController().signal;
const list = (host: ReturnType<typeof createConversationExtensionHost>, args: RuntimeValue = {}) =>
  host('conversation.list', args, signal());
const read = (
  host: ReturnType<typeof createConversationExtensionHost>,
  args: RuntimeValue = { index: 0 }
) => host('conversation.read', args, signal());
type ConversationPage = {
  items: {
    index: number;
    role: 'user' | 'assistant';
    text: string;
    offset: number;
    nextOffset: number | null;
    totalChars: number;
  }[];
  next: { index: number; offset: number } | null;
  total: number;
};
const page = (host: ReturnType<typeof createConversationExtensionHost>, args: RuntimeValue = {}) =>
  host('conversation.page', args, signal()) as Promise<ConversationPage>;

describe('frozen conversation Host', () => {
  it('packs short messages and empty messages while bounding total UTF-16 text and fragment count', async () => {
    const view = Array.from({ length: 121 }, (_, index) => ({
      role: index % 2 ? ('assistant' as const) : ('user' as const),
      text: index % 3 ? `message ${index}` : '',
    }));
    const host = createConversationExtensionHost(
      program(),
      view,
      () => {},
      () => {}
    );
    const first = await page(host);
    expect(first.items).toHaveLength(50);
    expect(first.items[0]).toEqual({
      index: 0,
      role: 'user',
      text: '',
      offset: 0,
      nextOffset: null,
      totalChars: 0,
    });
    expect(first.next).toEqual({ index: 50, offset: 0 });
    const second = await page(host, first.next!);
    expect(second.items).toHaveLength(50);
    const third = await page(host, second.next!);
    expect(third.items).toHaveLength(21);
    expect(third.next).toBeNull();
    expect(
      [...first.items, ...second.items, ...third.items].map(({ role, text }) => ({ role, text }))
    ).toEqual(view);
    expect(await page(host, { index: view.length })).toEqual({ items: [], next: null, total: 121 });
  });

  it('reassembles long mixed-Unicode messages across pages with one global page budget', async () => {
    const view = [
      { role: 'user' as const, text: 'a'.repeat(15999) + '😀' },
      { role: 'assistant' as const, text: '가😀\n'.repeat(12000) },
      ...Array.from({ length: 500 }, (_, index) => ({
        role: 'user' as const,
        text: index % 2 ? '' : `짧은 문장 ${index}🙂`,
      })),
      { role: 'assistant' as const, text: 'end' },
    ];
    const beforeHash = extensionConversationViewHash(view);
    const host = createConversationExtensionHost(
      program(),
      view,
      () => {},
      () => {}
    );
    const restored = view.map(() => '');
    let cursor: ConversationPage['next'] = { index: 0, offset: 0 };
    let calls = 0;
    while (cursor) {
      const result = await page(host, cursor);
      expect(result.total).toBe(view.length);
      expect(result.items.length).toBeLessThanOrEqual(50);
      expect(result.items.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(
        16000
      );
      for (const item of result.items) {
        expect(item.offset).toBe(restored[item.index].length);
        expect(item.role).toBe(view[item.index].role);
        restored[item.index] += item.text;
      }
      cursor = result.next;
      expect(++calls).toBeLessThan(32);
    }
    expect(restored).toEqual(view.map((item) => item.text));
    expect(extensionConversationViewHash(view)).toBe(beforeHash);
    expect(await page(host, { index: 0, offset: 15999, limit: 1 })).toMatchObject({
      items: [{ index: 0, text: '😀'.slice(0, 1), offset: 15999, nextOffset: 16000 }],
      next: { index: 0, offset: 16000 },
    });
  });

  it('shares read slicing, preserves budget-boundary empty messages, and validates page cursors', async () => {
    const host = createConversationExtensionHost(
      program(),
      [
        { role: 'user', text: 'abc' },
        { role: 'assistant', text: '' },
        { role: 'assistant', text: 'defg' },
      ],
      () => {},
      () => {}
    );
    const first = await page(host, { limit: 3 });
    expect(first.items).toEqual([await read(host, { index: 0, limit: 3 })]);
    expect(first.next).toEqual({ index: 1, offset: 0 });
    const second = await page(host, { ...first.next!, limit: 3 });
    expect(second.items.map((item) => item.text)).toEqual(['', 'def']);
    expect(second.next).toEqual({ index: 2, offset: 3 });
    expect(await page(host, second.next!)).toMatchObject({ items: [{ text: 'g' }], next: null });
    const invalidPageArguments: RuntimeValue[] = [
      { index: 4 },
      { index: 3, offset: 1 },
      { index: 1, offset: 1 },
      { index: -1 },
      { index: 0.5 },
      { offset: -1 },
      { limit: 0 },
      { limit: 16001 },
      { limit: Infinity },
      { branchId: 'other' },
    ];
    for (const args of invalidPageArguments)
      await expect(page(host, args)).rejects.toThrow('BEHAVIOR_HOST_ARGUMENTS');
    const empty = createConversationExtensionHost(
      program(),
      [],
      () => {},
      () => {}
    );
    expect(await page(empty)).toEqual({ items: [], next: null, total: 0 });
    await expect(page(empty, { offset: 1 })).rejects.toThrow('BEHAVIOR_HOST_ARGUMENTS');
  });
  it('lists and reads bounded UTF-16 pages without exposing bodies in list or host metadata', async () => {
    const view = Array.from({ length: 52 }, (_, index) => ({
      role: index % 2 ? ('assistant' as const) : ('user' as const),
      text: `${index}:가😀`.repeat(3000),
    }));
    const permission = vi.fn(),
      current = vi.fn();
    const host = createConversationExtensionHost(program(), view, permission, current);
    expect(await list(host)).toEqual({
      items: view
        .slice(0, 20)
        .map((item, index) => ({ index, role: item.role, totalChars: item.text.length })),
      nextOffset: 20,
      total: 52,
    });
    expect(await list(host, { offset: 50, limit: 50 })).toEqual({
      items: view.slice(50).map((item, index) => ({
        index: 50 + index,
        role: item.role,
        totalChars: item.text.length,
      })),
      nextOffset: null,
      total: 52,
    });
    expect(await list(host, { offset: 52 })).toEqual({ items: [], nextOffset: null, total: 52 });
    expect(await read(host)).toEqual({
      index: 0,
      role: 'user',
      text: view[0].text.slice(0, 8000),
      offset: 0,
      nextOffset: 8000,
      totalChars: view[0].text.length,
    });
    expect(await read(host, { index: 0, offset: 8000, limit: 16000 })).toEqual({
      index: 0,
      role: 'user',
      text: view[0].text.slice(8000),
      offset: 8000,
      nextOffset: null,
      totalChars: view[0].text.length,
    });
    expect(permission).toHaveBeenCalledTimes(5);
    expect(current).toHaveBeenCalledTimes(5);
  });

  it('captures strings once and checks live grant revocation, ownership, and cancellation each call', async () => {
    const view = [{ role: 'user' as const, text: 'frozen' }];
    let granted = true;
    const grant = vi.fn(() => {
      if (!granted) throw new ExtensionProgramError('BEHAVIOR_HOST_CONVERSATION_DENIED');
    });
    const owner = vi.fn();
    const host = createConversationExtensionHost(program(), view, grant, owner);
    view[0].text = 'changed';
    view.push({ role: 'user', text: 'new' });
    expect(await read(host)).toMatchObject({ text: 'frozen' });
    granted = false;
    await expect(list(host)).rejects.toThrow('BEHAVIOR_HOST_CONVERSATION_DENIED');
    expect(owner).toHaveBeenCalledTimes(1);
    granted = true;
    owner.mockImplementation(() => {
      throw new Error('OWNER_STALE');
    });
    await expect(read(host)).rejects.toThrow('OWNER_STALE');
    const controller = new AbortController();
    controller.abort();
    await expect(host('conversation.list', {}, controller.signal)).rejects.toThrow(
      'BEHAVIOR_HOST_ABORTED'
    );
    expect(grant).toHaveBeenCalledTimes(3);
    const during = new AbortController();
    const cancelling = createConversationExtensionHost(
      program(),
      [],
      () => during.abort(),
      () => {}
    );
    await expect(cancelling('conversation.list', {}, during.signal)).rejects.toThrow(
      'BEHAVIOR_HOST_ABORTED'
    );
  });

  it('denies undeclared methods/capabilities and scope changes, invalid indexes and hostile arguments', async () => {
    const permission = vi.fn();
    await expect(
      list(createConversationExtensionHost(program(false), [], permission, () => {}))
    ).rejects.toThrow('BEHAVIOR_HOST_DENIED');
    expect(permission).not.toHaveBeenCalled();
    const host = createConversationExtensionHost(
      program(),
      [{ role: 'assistant', text: '123' }],
      permission,
      () => {}
    );
    await expect(host('conversation.write', {}, signal())).rejects.toThrow('BEHAVIOR_HOST_DENIED');
    for (const args of [
      { chatId: 'other' },
      { branchId: 'other' },
      { sourceRevision: 'secret' },
      { index: 0 },
      { offset: -1 },
      { offset: 2 },
      { limit: 0 },
      { limit: 51 },
      [],
      null,
    ])
      await expect(list(host, args as RuntimeValue)).rejects.toThrow('BEHAVIOR_HOST_ARGUMENTS');
    for (const args of [
      {},
      { index: -1 },
      { index: 1 },
      { index: 0.5 },
      { index: 0, offset: 4 },
      { index: 0, limit: 16001 },
      { index: 0, limit: NaN },
      { index: 0, runId: 'secret' },
    ])
      await expect(read(host, args as RuntimeValue)).rejects.toThrow('BEHAVIOR_HOST_ARGUMENTS');
    const getter = vi.fn(() => 0);
    const args = Object.defineProperty({}, 'index', { enumerable: true, get: getter });
    await expect(read(host, args)).rejects.toThrow('BEHAVIOR_HOST_ARGUMENTS');
    expect(getter).not.toHaveBeenCalled();
    expect(await read(host, { index: 0, offset: 3 })).toMatchObject({ text: '', nextOffset: null });
  });

  it('requires a message for reads but supports an empty conversation list', async () => {
    const host = createConversationExtensionHost(
      program(),
      [],
      () => {},
      () => {}
    );
    expect(await list(host)).toEqual({ items: [], nextOffset: null, total: 0 });
    await expect(read(host)).rejects.toThrow('BEHAVIOR_HOST_ARGUMENTS');
  });
});

describe('conversation reference capture', () => {
  it('uses preserved fork request ranks for both capture and replay despite later row insertion', () => {
    const store = database(),
      chat = createFixtureChat(store, 'Fork order');
    const first = turn(store, chat.id, 'first request', 'first answer');
    const second = turn(store, chat.id, 'second request', 'second answer');
    const dependency = failed(
      store,
      chat.id,
      'preserved middle request',
      'preserved middle partial'
    );
    const rank = (id: string, requestOrder: number) =>
      store.db
        .prepare("UPDATE runs SET snapshot=json_set(snapshot,'$.forkedFrom',json(?)) WHERE id=?")
        .run(
          JSON.stringify({
            chatId: 'origin',
            runId: `origin-${id}`,
            sourceRevision: null,
            requestOrder,
          }),
          id
        );
    rank(first.runId, -3);
    rank(second.runId, -1);
    rank(dependency.id, -2);
    failed(store, chat.id, 'new local request');
    const base = snapshot(store, chat.id);
    const refs = captureExtensionConversation(store, base);
    expect(resolveExtensionConversation(store, base, refs).map((item) => item.text)).toEqual([
      'first request',
      'first answer',
      'preserved middle request',
      'preserved middle partial',
      'second request',
      'second answer',
      'new local request',
    ]);
  });
  it('matches branch Reader ordering, including failed partials, excluding superseded and sibling history', () => {
    const store = database(),
      chat = createFixtureChat(store, 'Conversation');
    const first = turn(store, chat.id, 'first request', 'first answer');
    failed(store, chat.id, 'failed request', 'retained partial');
    turn(store, chat.id, 'second request', 'second answer');
    const replaced = failed(store, chat.id, 'superseded request', 'superseded partial');
    const retry = failed(store, chat.id, 'retry request', 'retry partial');
    store.db
      .prepare("UPDATE runs SET command=json_set(command,'$.retryOf',?) WHERE id=?")
      .run(replaced.id, retry.id);
    const sibling = store.product.createBranch(chat.id, {
      title: 'Sibling',
      fromRevision: first.id,
    });
    turn(store, chat.id, 'sibling request', 'sibling answer', sibling.id);
    failed(store, chat.id, 'sibling failure', 'sibling partial', sibling.id);
    turn(store, createFixtureChat(store, 'Other chat').id, 'other request', 'other answer');
    const base = snapshot(store, chat.id);
    const refs = captureExtensionConversation(store, base);
    expect(resolveExtensionConversation(store, base, refs).map((item) => item.text)).toEqual([
      'first request',
      'first answer',
      'failed request',
      'retained partial',
      'second request',
      'second answer',
      'retry request',
      'retry partial',
    ]);
    expect(refs.messages.every((message) => !('text' in message))).toBe(true);
    expect(JSON.stringify(refs)).not.toContain('retained partial');
    const siblingBase = snapshot(store, chat.id, sibling.id);
    expect(
      resolveExtensionConversation(
        store,
        siblingBase,
        captureExtensionConversation(store, siblingBase)
      ).map((item) => item.text)
    ).toEqual([
      'first request',
      'first answer',
      'sibling request',
      'sibling answer',
      'sibling failure',
      'sibling partial',
    ]);
  });

  it('pins an existing edited source hash, survives later edits, and ignores future requests', () => {
    const store = database(),
      chat = createFixtureChat(store, 'Frozen edits');
    const source = turn(store, chat.id, 'request', 'original');
    store.editSource(source.id, { text: 'captured edit', expectedRevision: 0 });
    const base = snapshot(store, chat.id);
    const refs = captureExtensionConversation(store, base);
    store.editSource(source.id, { text: 'future edit', expectedRevision: 1 });
    failed(store, chat.id, 'future request');
    expect(resolveExtensionConversation(store, base, refs)).toEqual([
      { role: 'user', text: 'request' },
      { role: 'assistant', text: 'captured edit' },
    ]);
    expect(() => resolveExtensionConversation(store, base, undefined)).toThrow(
      'BEHAVIOR_HOST_CONVERSATION_UNAVAILABLE'
    );
    expect(() => resolveExtensionConversation(store, base, { ...refs, branchId: 'other' })).toThrow(
      'BEHAVIOR_HOST_CONVERSATION_UNAVAILABLE'
    );
    const altered = structuredClone(refs);
    altered.messages[1].hash = '0'.repeat(64);
    expect(() => resolveExtensionConversation(store, base, altered)).toThrow(
      'BEHAVIOR_HOST_CONVERSATION_UNAVAILABLE'
    );
  });

  it('binds admission and explicit phase append without duplicating the current request', () => {
    const store = database(),
      chat = createFixtureChat(store, 'Admission');
    turn(store, chat.id, 'past request', 'past answer');
    const superseded = failed(store, chat.id, 'old failed request');
    const base = snapshot(store, chat.id);
    const refs = captureExtensionConversation(store, base, {
      admissionRunId: 'reserved-not-inserted-yet',
      supersedesRunId: superseded.id,
    });
    expect(refs.admissionRunId).toBe('reserved-not-inserted-yet');
    expect(() => resolveExtensionConversation(store, base, refs)).toThrow(
      'BEHAVIOR_HOST_CONVERSATION_UNAVAILABLE'
    );
    const actionRefs = captureExtensionConversation(store, base, {
      supersedesRunId: superseded.id,
    });
    const view = resolveExtensionConversation(store, base, actionRefs, {
      request: 'current request',
      response: 'staged answer',
    });
    expect(view.map((item) => item.text)).toEqual([
      'past request',
      'past answer',
      'current request',
      'staged answer',
    ]);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view[0])).toBe(true);
    const current = failed(store, chat.id, 'already admitted request');
    failed(store, chat.id, 'later failed request');
    const admitted = captureExtensionConversation(store, base, { admissionRunId: current.id });
    expect(
      resolveExtensionConversation(store, base, admitted).map((item) => item.text)
    ).not.toContain('already admitted request');
    expect(
      resolveExtensionConversation(store, base, admitted).map((item) => item.text)
    ).not.toContain('later failed request');
  });

  it('includes user-expandable segments even when excluded from model request context', () => {
    const store = database(),
      chat = createFixtureChat(store, 'Segments');
    const text = 'visible\n<aside>\nexpandable note\n</aside>\nending';
    turn(store, chat.id, 'request', text);
    const base = snapshot(store, chat.id);
    base.sourceSegments = {
      version: 1,
      rules: [
        {
          id: 'note',
          kind: 'aside',
          open: '<aside>',
          close: '</aside>',
          match: 'line',
          label: 'Note',
          expanded: false,
          exclude: true,
        },
      ],
    };
    expect(
      resolveExtensionConversation(store, base, captureExtensionConversation(store, base))[1].text
    ).toBe(text);
  });

  it('reads source-only transcript runs through existing source/request records', () => {
    const store = database(),
      chat = createFixtureChat(store, 'Transcript');
    turn(store, chat.id, 'imported request', 'imported answer');
    const imported = importChatTranscript(store, {
      transcript: exportChatTranscript(store, chat.id),
      idempotencyKey: randomUUID(),
    });
    const base = snapshot(store, imported.chat.id);
    const original = store.run(store.sourceOriginal(base.history[0].revision).runId).snapshot;
    expect(original.transcriptImport?.storage).toBe('source-only-v1');
    expect(original.history).toEqual([]);
    expect(
      resolveExtensionConversation(store, base, captureExtensionConversation(store, base))
    ).toEqual([
      { role: 'user', text: 'imported request' },
      { role: 'assistant', text: 'imported answer' },
    ]);
  });

  it('refuses missing branch binding, incomplete source ancestry, cross-chat refs, and changed partials', () => {
    const store = database(),
      chat = createFixtureChat(store, 'Integrity');
    turn(store, chat.id, 'request', 'answer');
    const pending = failed(store, chat.id, 'failed', 'partial');
    const base = snapshot(store, chat.id);
    const refs = captureExtensionConversation(store, base);
    expect(() => captureExtensionConversation(store, { ...base, branchId: undefined })).toThrow(
      'BEHAVIOR_HOST_CONVERSATION_UNAVAILABLE'
    );
    expect(() => captureExtensionConversation(store, { ...base, history: [] })).toThrow(
      'BEHAVIOR_HOST_CONVERSATION_UNAVAILABLE'
    );
    const other = failed(store, createFixtureChat(store, 'Other').id, 'failed', 'partial');
    const altered = structuredClone(refs);
    altered.messages.at(-1)!.runId = other.id;
    expect(() => resolveExtensionConversation(store, base, altered)).toThrow(
      'BEHAVIOR_HOST_CONVERSATION_UNAVAILABLE'
    );
    store.db.prepare('UPDATE runs SET partial_text=? WHERE id=?').run('changed', pending.id);
    expect(() => resolveExtensionConversation(store, base, refs)).toThrow(
      'BEHAVIOR_HOST_CONVERSATION_UNAVAILABLE'
    );
  });

  it('hashes exact visible content order and roles independently of reference IDs', () => {
    const first = [
      { role: 'user' as const, text: 'question' },
      { role: 'assistant' as const, text: 'answer' },
    ];
    expect(extensionConversationViewHash(structuredClone(first))).toBe(
      extensionConversationViewHash(first)
    );
    expect(extensionConversationViewHash([...first].reverse())).not.toBe(
      extensionConversationViewHash(first)
    );
    expect(
      extensionConversationViewHash([{ role: 'assistant', text: 'question' }, first[1]])
    ).not.toBe(extensionConversationViewHash(first));
  });

  it('validates complete source coverage and adjacent request/response pairs in Reader order', () => {
    const store = database(),
      chat = createFixtureChat(store, 'Receipt ordering');
    turn(store, chat.id, 'first request', 'first answer');
    failed(store, chat.id, 'middle request', 'middle partial');
    turn(store, chat.id, 'second request', 'second answer');
    const base = snapshot(store, chat.id),
      refs = captureExtensionConversation(store, base);
    const missing = structuredClone(refs);
    missing.messages.splice(0, 2);
    expect(() => resolveExtensionConversation(store, base, missing)).toThrow(
      'BEHAVIOR_HOST_CONVERSATION_UNAVAILABLE'
    );
    const detached = structuredClone(refs);
    [detached.messages[0], detached.messages[1]] = [detached.messages[1], detached.messages[0]];
    expect(() => resolveExtensionConversation(store, base, detached)).toThrow(
      'BEHAVIOR_HOST_CONVERSATION_UNAVAILABLE'
    );
    const reordered = structuredClone(refs);
    const middle = reordered.messages.splice(2, 2);
    reordered.messages.push(...middle);
    expect(() => resolveExtensionConversation(store, base, reordered)).toThrow(
      'BEHAVIOR_HOST_CONVERSATION_UNAVAILABLE'
    );
    const duplicate = structuredClone(refs);
    duplicate.messages.push(...duplicate.messages.slice(2, 4));
    expect(() => resolveExtensionConversation(store, base, duplicate)).toThrow(
      'BEHAVIOR_HOST_CONVERSATION_UNAVAILABLE'
    );
  });

  it('rejects unrelated admission owners and messages admitted after the frozen cutoff', () => {
    const store = database(),
      chat = createFixtureChat(store, 'Admission integrity');
    turn(store, chat.id, 'request', 'answer');
    const admission = failed(store, chat.id, 'current');
    const base = snapshot(store, chat.id),
      refs = captureExtensionConversation(store, base, { admissionRunId: admission.id });
    const later = failed(store, chat.id, 'later');
    const laterRefs = captureExtensionConversation(store, base);
    const forged = structuredClone(refs);
    forged.messages.push(laterRefs.messages.find((ref) => ref.runId === later.id)!);
    expect(() => resolveExtensionConversation(store, base, forged)).toThrow(
      'BEHAVIOR_HOST_CONVERSATION_UNAVAILABLE'
    );
    const other = failed(store, createFixtureChat(store, 'Other admission').id, 'current');
    expect(() =>
      resolveExtensionConversation(store, base, { ...refs, admissionRunId: other.id })
    ).toThrow('BEHAVIOR_HOST_CONVERSATION_UNAVAILABLE');
  });
});
