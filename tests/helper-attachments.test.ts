import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { Store } from '../server/store.js';
import { HelperRuntime } from '../server/helper-runtime.js';
import { ResponseStreamStore } from '../server/response-stream.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { helperContext, helperHistory, publishHelperContext } from '../server/helper-context.js';
import { readRequestFileBlob } from '../server/request-file-storage.js';
import { readImage } from '../server/image-storage.js';
import { readUpload, storeUpload } from '../server/uploads.js';
import type { HelperStatus, HelperTask } from '../core/helper.js';
import type { RequestFileUpload } from '../core/request-files.js';
import { readHelperTaskResults } from '../server/helper-task-results.js';
import type { ProviderProtocol } from '../core/product.js';

const owned: {
  store: Store;
  directory: string;
  controller: AbortController;
  work: Promise<void>[];
}[] = [];
afterEach(async () => {
  for (const { store, directory, controller, work } of owned.splice(0)) {
    controller.abort();
    await Promise.allSettled(work);
    store.close();
    const target = resolve(directory);
    const within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-helper-files-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(target, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
});
function fixture(protocol: ProviderProtocol = 'fixture-sse-v1') {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-helper-files-'));
  const store = new Store(join(directory, 'story.sqlite'));
  const controller = new AbortController();
  const work: Promise<void>[] = [];
  owned.push({ store, directory, controller, work });
  const connection = store.product.connection({
    title: 'Synthetic attachment helper',
    protocol,
    endpoint:
      protocol === 'openai-responses-v1' ? 'https://api.openai.com/v1' : 'http://127.0.0.1:9',
    ...(protocol === 'openai-responses-v1' ? { apiKey: 'SYNTHETIC_ATTACHMENT_TOKEN' } : {}),
    enabled: true,
  });
  const model = store.product.model({
    title: 'Synthetic attachment helper',
    connectionId: connection.id,
    modelId: 'fixture-helper',
    temperature: null,
    maxOutputTokens: 1024,
  });
  const selected = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: selected.revision,
    routes: selected.routes,
    translationPolicy: selected.translationPolicy,
    helperModel: { id: model.id },
    contextModel: { id: model.id },
  });
  const runtime = new HelperRuntime(store, {
    owner: 'attachment-test-owner',
    resolveCredential: () => 'SYNTHETIC_ATTACHMENT_TOKEN',
    signal: controller.signal,
    track: (promise) => {
      if (protocol === 'fixture-sse-v1')
        throw new Error('Synthetic fixture must not start provider work');
      work.push(promise);
    },
    streams: new ResponseStreamStore(store),
  });
  const workspace = runtime.workspace;
  const conversation = workspace.open({ kind: 'library', workId: 'attachments-test' });
  return { store, runtime, workspace, conversation, work };
}
async function stage(
  store: Store,
  bytes: Buffer,
  name = 'reference.txt'
): Promise<RequestFileUpload> {
  const upload = await storeUpload(store.path, Readable.from([bytes]));
  return { uploadId: upload.uploadId, sha256: upload.sha256, name };
}
function settle(
  f: ReturnType<typeof fixture>,
  task: HelperTask,
  status: HelperStatus = 'completed'
) {
  expect(f.workspace.start(task.id, 'attachment-test-owner')).toBeTruthy();
  const generation = f.workspace.task(task.id).generation;
  expect(
    f.workspace.finish(
      task.id,
      'attachment-test-owner',
      generation,
      status,
      status === 'completed' ? '자료를 확인했어요.' : '응답이 중단됐어요.',
      status === 'completed' ? null : 'UNEXPECTED_EOF'
    )
  ).toBe(true);
}

test('file-only helper admission binds immutable metadata and replays the same key after staged bytes are released', async () => {
  const f = fixture();
  const bytes = Buffer.from('참고 자료의 원래 내용이에요.\n');
  const upload = await stage(f.store, bytes);
  const task = await f.runtime.enqueueWithAttachments(
    f.conversation.id,
    'file-only',
    '',
    undefined,
    undefined,
    undefined,
    undefined,
    { files: [upload] },
    false
  );
  expect(task.request).toBe('');
  expect(task.snapshot.files).toMatchObject([
    { hash: upload.sha256, name: 'reference.txt', bytes: bytes.length },
  ]);
  const message = f.workspace.messages(f.conversation.id)[0];
  expect(message.files).toEqual(task.snapshot.files);
  expect(readRequestFileBlob(f.store.db, upload.sha256).bytes).toEqual(bytes);
  expect(() => readUpload(f.store.path, upload.uploadId)).toThrow('UPLOAD_NOT_FOUND');
  const replay = await f.runtime.enqueueWithAttachments(
    f.conversation.id,
    'file-only',
    '',
    undefined,
    undefined,
    undefined,
    undefined,
    { files: [{ ...upload, uploadId: 'e'.repeat(32) }] },
    false
  );
  expect(replay.id).toBe(task.id);
  await expect(
    f.runtime.enqueueWithAttachments(
      f.conversation.id,
      'file-only',
      '',
      undefined,
      undefined,
      undefined,
      undefined,
      { files: [{ ...upload, uploadId: 'e'.repeat(32), sha256: 'f'.repeat(64) }] },
      false
    )
  ).rejects.toThrow('같은 요청 키');
  expect(f.workspace.taskSummaries(f.conversation.id)).toHaveLength(1);
});

test('concurrent duplicate helper admissions return one task after the first releases their shared staging', async () => {
  const f = fixture();
  const upload = await stage(f.store, Buffer.from('Concurrent immutable source'));
  const results = await Promise.all(
    [0, 1].map(() =>
      f.runtime.enqueueWithAttachments(
        f.conversation.id,
        'concurrent-file',
        '',
        undefined,
        undefined,
        undefined,
        undefined,
        { files: [upload] },
        false
      )
    )
  );
  expect(results[0].id).toBe(results[1].id);
  expect(f.workspace.taskSummaries(f.conversation.id)).toHaveLength(1);
  expect(f.workspace.messages(f.conversation.id)).toHaveLength(1);
});

test('retry, text edits, completion cleanup, and copied seed messages retain both image and file attachments', async () => {
  const f = fixture();
  const imageBytes = await sharp({
    create: { width: 3, height: 2, channels: 4, background: { r: 40, g: 80, b: 180, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const bytes = Buffer.from('지워지면 안 되는 원본 첨부 자료\n');
  const upload = await stage(f.store, bytes);
  const image = await stage(f.store, imageBytes, 'reference.png');
  const first = await f.runtime.enqueueWithAttachments(
    f.conversation.id,
    'first',
    '자료를 읽어 주세요.',
    undefined,
    undefined,
    undefined,
    undefined,
    { files: [upload], images: [image] },
    false
  );
  settle(f, first, 'failed');
  const retry = await f.runtime.enqueueWithAttachments(
    f.conversation.id,
    'retry',
    first.request,
    undefined,
    undefined,
    first.id,
    undefined,
    {},
    false
  );
  expect(retry.snapshot.files).toEqual(first.snapshot.files);
  expect(retry.snapshot.images).toEqual(first.snapshot.images);
  settle(f, retry);
  expect(f.workspace.task(retry.id).snapshot.history).toEqual([]);
  const message = f.workspace
    .messages(f.conversation.id)
    .find((entry) => entry.taskId === retry.id && entry.role === 'user')!;
  f.runtime.editMessage(
    f.conversation.id,
    message.id,
    f.workspace.conversation(f.conversation.id).revision,
    '첨부 내용에서 핵심을 찾아 주세요.'
  );
  const history = helperHistory(f.store, f.conversation.id);
  expect(history.find((entry) => entry.id === message.id)).toMatchObject({
    text: '첨부 내용에서 핵심을 찾아 주세요.',
    files: first.snapshot.files,
    images: first.snapshot.images,
  });
  const copy = f.workspace.copy(
    f.conversation.id,
    'copy',
    f.workspace.deletionImpact(f.conversation.id).request
  );
  const copyUser = f.workspace.messages(copy.id).find((entry) => entry.role === 'user')!;
  expect(copyUser.files).toEqual(first.snapshot.files);
  expect(copyUser.images).toEqual(first.snapshot.images);
  expect(helperHistory(f.store, copy.id).find((entry) => entry.id === copyUser.id)?.files).toEqual(
    first.snapshot.files
  );
  f.runtime.deleteMessages(
    f.conversation.id,
    message.id,
    f.workspace.conversation(f.conversation.id).revision,
    'pair'
  );
  expect(readRequestFileBlob(f.store.db, upload.sha256).bytes).toEqual(bytes);
  expect(readImage(f.store.db, copyUser.images![0].hash).bytes.length).toBeGreaterThan(0);
  f.runtime.deleteMessages(
    copy.id,
    copyUser.id,
    f.workspace.conversation(copy.id).revision,
    'pair'
  );
  expect(() => readRequestFileBlob(f.store.db, upload.sha256)).toThrow('REQUEST_FILE_MISSING');
  await expect(
    f.runtime.enqueueWithAttachments(
      f.conversation.id,
      'resurrect-deleted',
      first.request,
      undefined,
      undefined,
      retry.id,
      undefined,
      {},
      false
    )
  ).rejects.toThrow();
});

test('a failed admission leaves no permanent file bytes or user message behind', async () => {
  const f = fixture();
  const upload = await stage(f.store, Buffer.from('staged input'));
  await expect(
    f.runtime.enqueueWithAttachments(
      f.conversation.id,
      'invalid-hash',
      '읽어 주세요.',
      undefined,
      undefined,
      undefined,
      undefined,
      { files: [{ ...upload, sha256: 'a'.repeat(64) }] },
      false
    )
  ).rejects.toThrow('REQUEST_FILE_CHANGED');
  expect(f.workspace.messages(f.conversation.id)).toEqual([]);
  expect(f.store.db.prepare('SELECT count(*) AS n FROM attachment_blobs').get()!.n).toBe(0);
  expect(readUpload(f.store.path, upload.uploadId).toString()).toBe('staged input');
});

test('compacted helper history binds attachment hashes even when its message text stays unchanged', async () => {
  const f = fixture();
  const upload = await stage(f.store, Buffer.from('보존해야 할 이전 자료'));
  const first = await f.runtime.enqueueWithAttachments(
    f.conversation.id,
    'summarized-file',
    '자료를 확인해 주세요.',
    undefined,
    undefined,
    undefined,
    undefined,
    { files: [upload] },
    false
  );
  settle(f, first);
  const next = await f.runtime.enqueueWithAttachments(
    f.conversation.id,
    'next',
    '계속 설명해 주세요.',
    undefined,
    undefined,
    undefined,
    undefined,
    {},
    false
  );
  expect(f.workspace.start(next.id, 'attachment-test-owner')).toBeTruthy();
  const checkpoint = publishHelperContext(
    f.store,
    f.workspace.task(next.id),
    '이전 자료를 설명한 요약',
    { modelCalls: 1, inputTokens: 10, outputTokens: 5, costUsd: null },
    20,
    next.snapshot.context!
  );
  const history = helperHistory(f.store, f.conversation.id);
  expect(helperContext(f.store, f.conversation.id, history).checkpoint).toEqual(
    checkpoint.checkpoint
  );
  const changed = structuredClone(history);
  const attached = changed.find((entry) => entry.files?.length)!;
  attached.files![0].hash = 'f'.repeat(64);
  expect(() => helperContext(f.store, f.conversation.id, changed)).toThrow(
    'HELPER_CONTEXT_DEPENDENCY_CHANGED'
  );
  expect(f.store.context.checkpoint(checkpoint.checkpoint).plan.summary).toBe(
    '이전 자료를 설명한 요약'
  );
});

test('helper file-only requests and later history transmit original bytes while unmeasured PDF input stays unknown', async () => {
  const sent: Record<string, any>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      sent.push(JSON.parse(options.body));
      return new Response(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'synthetic-file-response',
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: '첨부를 확인했어요.', annotations: [] }],
              },
            ],
            usage: { input_tokens: 123, output_tokens: 7 },
          },
        })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } }
      );
    })
  );
  const f = fixture('openai-responses-v1');
  const bytes = Buffer.from('%PDF-1.7\nSynthetic attachment fixture\n%%EOF');
  const upload = await stage(f.store, bytes, 'reference.pdf');
  const first = await f.runtime.enqueueWithAttachments(
    f.conversation.id,
    'wire-file-only',
    '',
    undefined,
    undefined,
    undefined,
    undefined,
    { files: [upload] }
  );
  await Promise.all(f.work);
  expect(f.workspace.task(first.id).status).toBe('completed');
  expect(sent).toHaveLength(1);
  expect(JSON.stringify(sent[0])).toContain(
    `data:application/pdf;base64,${bytes.toString('base64')}`
  );
  expect(JSON.stringify(sent[0])).not.toContain('uimori-file://');
  const measured = readHelperTaskResults(f.store, first.id).usage;
  expect(measured.latestInputEstimate).toBeNull();
  expect(measured.knownInputEstimate).toBeGreaterThan(0);
  expect(measured.unmeasuredFileCount).toBe(1);
  expect(measured.attempts[0].inputTokens).toBe(123);
  const next = f.runtime.enqueue(
    f.conversation.id,
    'wire-history',
    '이 자료를 계속 설명해 주세요.'
  );
  await Promise.all(f.work);
  expect(f.workspace.task(next.id).status).toBe('completed');
  expect(sent).toHaveLength(2);
  const attachmentTurn = sent[1].input.find((turn: any) =>
    turn.content?.some((part: any) => part.type === 'input_file')
  );
  expect(attachmentTurn.role).toBe('user');
  expect(attachmentTurn.content).toContainEqual({
    type: 'input_file',
    filename: 'reference.pdf',
    file_data: `data:application/pdf;base64,${bytes.toString('base64')}`,
  });
  expect(JSON.stringify(f.workspace.task(first.id))).not.toContain(bytes.toString('base64'));
  expect(
    String(
      f.store.db.prepare('SELECT request FROM attempts ORDER BY rowid DESC LIMIT 1').get()!.request
    )
  ).not.toContain(bytes.toString('base64'));
});

test.each([false, true])(
  'attachment tool continuations preserve their segment binding (steering: %s)',
  async (steering) => {
    const f = fixture('openai-responses-v1');
    const sent: Record<string, any>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, options) => {
        const body = JSON.parse(options.body);
        sent.push(body);
        const first = sent.length === 1;
        const discovery = body.tools.find((tool: any) => tool.name?.endsWith('_app_tools'));
        if (first && steering) {
          const task = f.workspace.taskSummaries(f.conversation.id)[0];
          f.runtime.steer(
            task.id,
            'steer-after-attachment',
            '추가로 구성 관련 기능만 확인해 주세요.'
          );
        }
        return new Response(
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: `synthetic-file-tool-${sent.length}`,
              status: 'completed',
              output: first
                ? [
                    {
                      type: 'function_call',
                      id: 'discover-item',
                      call_id: 'discover-call',
                      name: discovery.name,
                      arguments: JSON.stringify({ query: 'outline' }),
                      status: 'completed',
                    },
                  ]
                : [
                    {
                      type: 'message',
                      role: 'assistant',
                      content: [
                        {
                          type: 'output_text',
                          text: '첨부와 도구 결과를 확인했어요.',
                          annotations: [],
                        },
                      ],
                    },
                  ],
              usage: { input_tokens: 123, output_tokens: 7 },
            },
          })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } }
        );
      })
    );
    const bytes = Buffer.from('%PDF-1.7\nSynthetic tool continuation attachment\n%%EOF');
    const upload = await stage(f.store, bytes, 'reference.pdf');
    const task = await f.runtime.enqueueWithAttachments(
      f.conversation.id,
      'attachment-tool-loop',
      '이 첨부를 읽고 사용 가능한 구성 도구를 확인해 주세요.',
      undefined,
      undefined,
      undefined,
      undefined,
      { files: [upload] }
    );
    await Promise.all(f.work);
    expect(f.workspace.task(task.id)).toMatchObject({ status: 'completed', error: null });
    expect(sent).toHaveLength(2);
    expect(sent[1].input.slice(0, sent[0].input.length)).toEqual(sent[0].input);
    expect(sent[1].input).toContainEqual(
      expect.objectContaining({ type: 'function_call_output', call_id: 'discover-call' })
    );
    expect(JSON.stringify(sent[1])).toContain(bytes.toString('base64'));
    if (steering) {
      expect(JSON.stringify(sent[0])).not.toContain('추가로 구성 관련 기능만');
      expect(JSON.stringify(sent[1])).toContain('추가로 구성 관련 기능만');
      expect(f.workspace.instructions(task.id)[0].status).toBe('delivered');
    }
  }
);

test('a new attachment is checked against retained history after the older attachment was compacted', async () => {
  const f = fixture('openai-responses-v1');
  const oldBytes = Buffer.alloc(26_000_000, 32);
  oldBytes.write('%PDF-1.7\nOld compacted attachment\n');
  const oldUpload = await stage(f.store, oldBytes, 'old-reference.pdf');
  const first = await f.runtime.enqueueWithAttachments(
    f.conversation.id,
    'old-large-file',
    '이전 자료',
    undefined,
    undefined,
    undefined,
    undefined,
    { files: [oldUpload] },
    false
  );
  settle(f, first);
  const summaryTask = f.runtime.enqueue(
    f.conversation.id,
    'compact-old-file',
    '이전 자료를 요약해 주세요.',
    undefined,
    undefined,
    undefined,
    undefined,
    false
  );
  expect(f.workspace.start(summaryTask.id, 'attachment-test-owner')).toBeTruthy();
  publishHelperContext(
    f.store,
    f.workspace.task(summaryTask.id),
    '이전 첨부의 내용을 요약했어요.',
    { modelCalls: 1, inputTokens: 100, outputTokens: 10, costUsd: null },
    100,
    summaryTask.snapshot.context!
  );
  const running = f.workspace.task(summaryTask.id);
  expect(
    f.workspace.finish(
      running.id,
      'attachment-test-owner',
      running.generation,
      'completed',
      '이전 자료의 요약이에요.',
      null
    )
  ).toBe(true);
  const newBytes = Buffer.alloc(26_000_000, 32);
  newBytes.write('%PDF-1.7\nNew retained attachment\n');
  const newUpload = await stage(f.store, newBytes, 'new-reference.pdf');
  const next = await f.runtime.enqueueWithAttachments(
    f.conversation.id,
    'new-large-file',
    '새 자료도 확인해 주세요.',
    undefined,
    undefined,
    undefined,
    undefined,
    { files: [newUpload] },
    false
  );
  expect(next.snapshot.files?.[0].hash).toBe(newUpload.sha256);
  expect(next.snapshot.history.flatMap((message) => message.files ?? [])).toHaveLength(1);
  expect(next.snapshot.context?.checkpoint).not.toBeNull();
});

test.each([false, true])(
  'retry replaces its previous large attachment turn before admission (checkpoint: %s)',
  async (checkpoint) => {
    const f = fixture('openai-responses-v1');
    const bytes = Buffer.alloc(26_000_000, 32);
    bytes.write('%PDF-1.7\nRetry attachment\n');
    const upload = await stage(f.store, bytes, 'retry-reference.pdf');
    const first = await f.runtime.enqueueWithAttachments(
      f.conversation.id,
      'large-failed-file',
      '자료를 확인해 주세요.',
      undefined,
      undefined,
      undefined,
      undefined,
      { files: [upload] },
      false
    );
    if (checkpoint) {
      expect(f.workspace.start(first.id, 'attachment-test-owner')).toBeTruthy();
      publishHelperContext(
        f.store,
        f.workspace.task(first.id),
        '진행 중 작업 요약',
        { modelCalls: 1, inputTokens: 20, outputTokens: 10, costUsd: null },
        100,
        first.snapshot.context!
      );
      const running = f.workspace.task(first.id);
      expect(
        f.workspace.finish(
          first.id,
          'attachment-test-owner',
          running.generation,
          'failed',
          '',
          'UNEXPECTED_EOF'
        )
      ).toBe(true);
    } else settle(f, first, 'failed');
    const retry = await f.runtime.enqueueWithAttachments(
      f.conversation.id,
      'large-file-retry',
      first.request,
      undefined,
      undefined,
      first.id,
      undefined,
      {},
      false
    );
    expect(retry.snapshot.files).toEqual(first.snapshot.files);
    expect(retry.snapshot.history).toEqual([]);
    expect(retry.snapshot.context?.checkpoint).toBeNull();
    expect(retry.snapshot.context?.activeRevision).toBe(checkpoint ? 2 : 0);
    expect(
      helperHistory(f.store, f.conversation.id).filter((message) => message.files?.length)
    ).toHaveLength(1);
  }
);
