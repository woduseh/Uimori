import { afterEach, expect, test, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { Store } from '../server/store.js';
import { HelperRuntime } from '../server/helper-runtime.js';
import { ResponseStreamStore } from '../server/response-stream.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { storeImage } from '../server/image-storage.js';
import { nativeContent } from './fixtures/native-content.js';
import { fixtureBotInput } from './fixtures/chat.js';
import type { ProviderResult } from '../core/transport.js';

const fixtures: {
  store: Store;
  directory: string;
  controller: AbortController;
  work: Promise<void>[];
}[] = [];
afterEach(async () => {
  for (const { store, directory, controller, work } of fixtures.splice(0)) {
    controller.abort();
    await Promise.allSettled(work);
    store.close();
    const target = resolve(directory);
    const within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-helper-image-runtime-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(target, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function fixture(
  options: {
    inputTokenLimit?: number;
    modelId?: string;
    executeCodexAgent?: ConstructorParameters<typeof HelperRuntime>[1]['executeCodexAgent'];
  } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-helper-image-runtime-'));
  const store = new Store(join(directory, 'test.sqlite'));
  const controller = new AbortController();
  const work: Promise<void>[] = [];
  fixtures.push({ store, directory, controller, work });
  const native = !!options.executeCodexAgent;
  const connection = store.product.connection({
    title: 'Synthetic image helper',
    protocol: native ? 'codex-app-server-v1' : 'openai-chat-v1',
    endpoint: native ? 'codex://local' : 'http://127.0.0.1:9/v1/chat/completions',
    enabled: true,
  });
  const helper = store.product.model({
    title: 'Synthetic image helper',
    connectionId: connection.id,
    modelId: options.modelId ?? 'synthetic-helper',
    maxOutputTokens: 2048,
    inputTokenLimit: options.inputTokenLimit ?? 272000,
    temperature: null,
  });
  const context = store.product.model({
    title: 'Synthetic image context',
    connectionId: connection.id,
    modelId: 'synthetic-context',
    maxOutputTokens: 4096,
    inputTokenLimit: 65536,
    temperature: null,
  });
  const selected = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: selected.revision,
    routes: selected.routes,
    translationPolicy: selected.translationPolicy,
    helperModel: { id: helper.id },
    contextModel: { id: context.id },
  });
  const runtime = new HelperRuntime(store, {
    owner: 'image-runtime-test',
    resolveCredential: () => 'synthetic-image-key',
    signal: controller.signal,
    track: (promise) => work.push(promise),
    streams: new ResponseStreamStore(store),
    executeCodexAgent: options.executeCodexAgent,
  });
  const conversation = runtime.workspace.open({ kind: 'library', workId: 'image-runtime-test' });
  return {
    store,
    runtime,
    conversation,
    async run(request = 'Inspect the named image and describe its visible color.') {
      const task = runtime.enqueue(conversation.id, randomUUID(), request);
      await Promise.all(work);
      return runtime.workspace.task(task.id);
    },
  };
}

async function savePortrait(store: Store) {
  const bytes = await sharp({
    create: { width: 12, height: 8, channels: 3, background: '#ff0000' },
  })
    .png()
    .toBuffer();
  const hash = createHash('sha256').update(bytes).digest('hex');
  storeImage(store.db, { hash, mime: 'image/png', bytes });
  const pkg = nativeContent(
    { name: 'Authored portrait owner', description: 'Preserve this authored description.' },
    {
      images: [
        {
          id: 'portrait-red',
          title: 'Red portrait',
          description: 'A solid red reference image',
          mime: 'image/png',
          blobHash: hash,
          allowedUse: 'both',
        },
      ],
    }
  );
  pkg.nativeRisu.assets = [
    { name: 'original-happy-face', uri: 'embeded://assets/portrait.png', imageId: 'portrait-red' },
  ];
  return store.product.content({
    kind: 'bot',
    title: pkg.title,
    description: pkg.description,
    text: pkg.body,
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  });
}

function answer(body: any, calls: { id: string; name: string; args: unknown }[] = []) {
  const delta = calls.length
    ? {
        role: 'assistant',
        tool_calls: calls.map((call, index) => ({
          index,
          id: call.id,
          type: 'function',
          function: {
            name: body.tools.find((tool: any) =>
              tool.function.name.endsWith(`_${call.name.replaceAll('.', '_')}`)
            ).function.name,
            arguments: JSON.stringify(call.args),
          },
        })),
      }
    : { role: 'assistant', content: 'The image is red.' };
  const chunks = [
    {
      id: 'synthetic-image-response',
      choices: [{ index: 0, delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
    },
    {
      id: 'synthetic-image-response',
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    },
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } }
  );
}
function call(id: string, name: string, args: unknown) {
  return { id, name: 'app.call', args: { name, arguments: args } };
}
function intercept(action: (body: any, round: number) => Response) {
  const bodies: any[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return action(body, bodies.length - 1);
    })
  );
  return bodies;
}
function toolEvent(body: any, id: string) {
  return JSON.parse(
    body.messages.findLast((message: any) => message.role === 'tool' && message.tool_call_id === id)
      .content
  );
}
function imageData(body: unknown) {
  return [...JSON.stringify(body).matchAll(/data:image\/webp;base64,([A-Za-z0-9+/=]+)/gu)].map(
    (match) => match[1]
  );
}
async function expectRedPixels(base64: string) {
  const image = sharp(Buffer.from(base64, 'base64'));
  expect(await image.metadata()).toMatchObject({ format: 'webp', width: 12, height: 8 });
  const { data, info } = await image.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(info.channels).toBe(3);
  for (let offset = 0; offset < data.length; offset += 3) {
    expect(data[offset]).toBeGreaterThanOrEqual(245);
    expect(data[offset + 1]).toBeLessThanOrEqual(8);
    expect(data[offset + 2]).toBeLessThanOrEqual(8);
  }
}
function expectNoPersistedPixels(f: ReturnType<typeof fixture>, base64: string) {
  const persisted = JSON.stringify({
    tasks: f.store.db.prepare('SELECT * FROM helper_tasks').all(),
    messages: f.runtime.workspace.messages(f.conversation.id),
    events: f.runtime.workspace.events(f.conversation.id),
    attempts: f.store.db.prepare('SELECT * FROM attempts').all(),
  });
  expect(persisted).not.toContain(base64);
  expect(persisted).not.toContain('data:image/');
  expect(persisted).not.toContain('"base64"');
}

test('gateway image discovery delivers actual pixels once across continued helper rounds and preserves authored data', async () => {
  const f = fixture();
  const original = await savePortrait(f.store);
  const originalBlobs = f.store.db.prepare('SELECT * FROM image_blobs').all();
  const bodies = intercept((body, round) => {
    if (round === 0) return answer(body, [call('list', 'image.list', { contentId: original.id })]);
    if (round === 1) {
      return answer(body, [
        call('read', 'image.read', { contentId: original.id, imageId: 'portrait-red' }),
      ]);
    }
    if (round === 2) {
      return answer(body, [call('list-again', 'image.list', { contentId: original.id })]);
    }
    return answer(body);
  });
  const task = await f.run();
  expect(task.status, task.error ?? '').toBe('completed');
  expect(bodies).toHaveLength(4);
  expect(toolEvent(bodies[1], 'list').images).toMatchObject([
    { imageId: 'portrait-red', nativeNames: ['original-happy-face'] },
  ]);
  expect(toolEvent(bodies[2], 'read')).toMatchObject({
    contentId: original.id,
    imageId: 'portrait-red',
    transmission: { mime: 'image/webp', width: 12, height: 8 },
  });
  expect(toolEvent(bodies[3], 'list-again').images).toHaveLength(1);
  expect(imageData(bodies[0])).toHaveLength(0);
  expect(imageData(bodies[1])).toHaveLength(0);
  const [pixels] = imageData(bodies[2]);
  expect(imageData(bodies[2])).toHaveLength(1);
  await expectRedPixels(pixels);
  expect(imageData(bodies[3])).toEqual([pixels]);
  expect(f.store.product.get('content', original.id)).toEqual(original);
  expect(f.store.db.prepare('SELECT * FROM image_blobs').all()).toEqual(originalBlobs);
  expectNoPersistedPixels(f, pixels);
});

test('native helper tool callbacks return decoded image pixels without persisting binary results', async () => {
  let contentId = '';
  let pixels = '';
  const executeCodexAgent = vi.fn<
    NonNullable<ConstructorParameters<typeof HelperRuntime>[1]['executeCodexAgent']>
  >(async (_connection, _request, options) => {
    const outcome = await options.onToolCall(
      {
        callId: 'native-read',
        name: 'app.call',
        arguments: { name: 'image.read', arguments: { contentId, imageId: 'portrait-red' } },
      },
      options.signal
    );
    expect(outcome.success).toBe(true);
    expect(JSON.parse(outcome.text)).toMatchObject({ contentId, imageId: 'portrait-red' });
    if (outcome.complete)
      throw new Error('Image reads must return a tool result, not finish the task');
    expect(outcome.images).toHaveLength(1);
    pixels = outcome.images![0].base64;
    await expectRedPixels(pixels);
    return {
      status: 'completed',
      text: 'The portrait is red.',
      toolCalls: [],
      refusal: null,
      error: null,
      usage: { inputTokens: 10, outputTokens: 4, costUsd: null, raw: null, priceRevision: null },
      opaqueState: null,
    } satisfies ProviderResult;
  });
  const f = fixture({ executeCodexAgent });
  contentId = (await savePortrait(f.store)).id;
  expect(await f.run()).toMatchObject({ status: 'completed' });
  expect(executeCodexAgent).toHaveBeenCalledOnce();
  expectNoPersistedPixels(f, pixels);
});

test('a known text-only helper denies image reading recoverably while image discovery still works', async () => {
  const f = fixture({ modelId: 'deepseek-chat' });
  const original = await savePortrait(f.store);
  const bodies = intercept((body, round) => {
    if (round === 0)
      return answer(body, [
        call('unsupported-read', 'image.read', { contentId: original.id, imageId: 'portrait-red' }),
      ]);
    if (round === 1) {
      return answer(body, [call('supported-list', 'image.list', { contentId: original.id })]);
    }
    return answer(body);
  });
  const task = await f.run();
  expect(task.status, task.error ?? '').toBe('completed');
  expect(bodies).toHaveLength(3);
  expect(toolEvent(bodies[1], 'unsupported-read')).toMatchObject({
    error: 'IMAGE_INPUT_UNSUPPORTED_MODEL',
    recoverable: true,
  });
  expect(toolEvent(bodies[2], 'supported-list')).toMatchObject({
    images: [{ imageId: 'portrait-red' }],
  });
  expect(
    f.runtime.workspace.events(f.conversation.id).filter((event) => event.kind === 'tool.finished')
  ).toContainEqual(
    expect.objectContaining({
      data: expect.objectContaining({ callId: 'unsupported-read', denied: true }),
    })
  );
  expect(bodies.flatMap(imageData)).toHaveLength(0);
});

test('shell image reads retain trusted pixels and viewed metadata when stdout is redirected', async () => {
  vi.stubEnv('UIMORI_SHELL_ROOT', join(tmpdir(), 'uimori-image-runtime-shell'));
  const f = fixture();
  const original = await savePortrait(f.store);
  const before = f.store.db.prepare('SELECT * FROM image_blobs').all();
  let readResult: unknown;
  // Only the external shell runner is substituted. The app callback, image conversion,
  // task-local image collection and actual HTTP request encoder remain real.
  const shell = vi
    .spyOn(f.runtime.shell, 'exec')
    .mockImplementation(async (_task, _toolId, _command, _timeoutMs, signal, invoke) => {
      if (!invoke || !signal) throw new Error('Shell must receive an app callback and signal');
      readResult = await invoke(
        'image.read',
        { contentId: original.id, imageId: 'portrait-red' },
        'nested-image-read',
        signal
      );
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        truncated: false,
        output: '',
        outputFile: 'scratch/redirected-image.log',
        applied: [],
      };
    });
  const bodies = intercept((body, round) =>
    round === 0
      ? answer(body, [
          {
            id: 'shell-read',
            name: 'data.exec',
            args: {
              command: `uimori call image.read '{"contentId":"${original.id}","imageId":"portrait-red"}' > scratch/image.json`,
            },
          },
        ])
      : answer(body)
  );
  const task = await f.run();
  expect(task.status, task.error ?? '').toBe('completed');
  expect(shell).toHaveBeenCalledOnce();
  expect(readResult).toMatchObject({ result: { contentId: original.id, imageId: 'portrait-red' } });
  expect(bodies).toHaveLength(2);
  expect(toolEvent(bodies[1], 'shell-read')).toMatchObject({
    output: '',
    viewedImages: [
      {
        contentId: original.id,
        imageId: 'portrait-red',
        transmission: { mime: 'image/webp', width: 12, height: 8 },
      },
    ],
  });
  const [pixels] = imageData(bodies[1]);
  expect(imageData(bodies[1])).toHaveLength(1);
  await expectRedPixels(pixels);
  expect(f.store.db.prepare('SELECT * FROM image_blobs').all()).toEqual(before);
  expectNoPersistedPixels(f, pixels);
});

test.each(['image.read', 'shell image.read with a save'] as const)(
  'automatic compaction of %s shows pixels to the context model and retains exact provenance',
  async (mode) => {
    const shellWrite = mode === 'shell image.read with a save';
    if (shellWrite) vi.stubEnv('UIMORI_SHELL_ROOT', join(tmpdir(), 'uimori-image-runtime-shell'));
    const f = fixture({ inputTokenLimit: 8192 });
    const original = await savePortrait(f.store);
    const changed = shellWrite ? f.store.product.content(fixtureBotInput('Before')) : undefined;
    let applied: unknown[] = [];
    const command =
      'uimori call image.read --input scratch/image-args.json > scratch/image.json; uimori call resource.patch --input scratch/patch-args.json';
    if (changed) {
      vi.spyOn(f.runtime.shell, 'exec').mockImplementation(
        async (_task, _toolId, _command, _timeoutMs, signal, invoke) => {
          if (!invoke || !signal) throw new Error('Shell must receive an app callback and signal');
          await invoke(
            'image.read',
            { contentId: original.id, imageId: 'portrait-red' },
            'nested-image-read',
            signal
          );
          const saved = await invoke(
            'resource.patch',
            {
              kind: 'content',
              id: changed.id,
              expectedRevision: changed.revision,
              changes: [{ path: '/package/nativeRisu/card/name', op: 'set', value: 'After' }],
            },
            'nested-save',
            signal
          );
          applied = saved.applied ?? [];
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            truncated: false,
            output: '',
            outputFile: 'scratch/image-save.log',
            applied,
          };
        }
      );
    }
    const source = Array.from({ length: 2000 }, (_, index) =>
      index.toString(36).padStart(4, '0')
    ).join(' ');
    const evidence = f.store.product.content(fixtureBotInput('Large evidence', source));
    let helperCalls = 0;
    const bodies = intercept((body) => {
      if (body.model === 'synthetic-context') return answer(body);
      if (++helperCalls === 1)
        return answer(body, [
          shellWrite
            ? { id: 'image-and-save', name: 'data.exec', args: { command } }
            : call('compacted-read', 'image.read', {
                contentId: original.id,
                imageId: 'portrait-red',
              }),
          call('large-read', 'resource.read', {
            kind: 'content',
            id: evidence.id,
            path: '/package/nativeRisu/card/description',
            textLimit: 10000,
          }),
        ]);
      return answer(body);
    });
    const task = await f.run();
    expect(task.status, task.error ?? '').toBe('completed');
    expect(bodies.map((body) => body.model)).toEqual([
      'synthetic-helper',
      'synthetic-context',
      'synthetic-helper',
    ]);
    const [pixels] = imageData(bodies[1]);
    expect(imageData(bodies[1])).toHaveLength(1);
    await expectRedPixels(pixels);
    expect(imageData(bodies[2])).toHaveLength(0);
    const data = JSON.parse(
      bodies[2].messages
        .find((message: any) => message.role === 'user')
        .content.replace(/^Request data \(JSON\):\n/, '')
    );
    if (changed) {
      expect(applied).toMatchObject([
        {
          name: 'resource.patch',
          operationId: 'nested-save',
          receiptId: `${task.id}:nested-save`,
          outcome: 'succeeded',
          id: changed.id,
          revision: 2,
        },
      ]);
      expect(data.source.completedToolHistory.events).toEqual([
        {
          callId: 'image-and-save',
          name: 'data.exec',
          args: { command },
          result: {
            exitCode: 0,
            signal: null,
            timedOut: false,
            truncated: false,
            output: '',
            outputFile: 'scratch/image-save.log',
            applied,
            viewedImages: [
              expect.objectContaining({ contentId: original.id, imageId: 'portrait-red' }),
            ],
          },
          denied: false,
        },
      ]);
      expect(f.store.product.get('content', changed.id)).toMatchObject({
        title: 'After',
        revision: 2,
      });
      expect(
        f.store.db.prepare('SELECT COUNT(*) n FROM helper_operations WHERE task_id=?').get(task.id)
          ?.n
      ).toBe(1);
    } else
      expect(data.source.continuation.completedReads).toContainEqual(
        expect.objectContaining({
          name: 'app.call',
          args: {
            name: 'image.read',
            arguments: { contentId: original.id, imageId: 'portrait-red' },
          },
          returned: expect.objectContaining({
            contentId: original.id,
            imageId: 'portrait-red',
            transmission: { mime: 'image/webp', width: 12, height: 8 },
          }),
        })
      );
    expect(
      f.runtime.workspace
        .events(f.conversation.id)
        .filter((event) => event.kind === 'context.compaction')
    ).toMatchObject([{ data: { applied: true } }]);
    expectNoPersistedPixels(f, pixels);
  }
);
