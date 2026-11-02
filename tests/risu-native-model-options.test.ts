import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { afterEach, expect, test, vi } from 'vitest';
import { defaultProfile, type Connection, type ModelSnapshot } from '../core/product.js';
import type { RequestImage } from '../core/request-images.js';
import type { WireRecord } from '../core/transport.js';
import type { RunSnapshot, Usage } from '../core/types.js';
import { storeImage } from '../server/image-storage.js';
import { createNativeRisuHost, validateNativeScriptAttempt } from '../server/risu-native-host.js';
import { disposeAllNativeRisuSessions, executeRisuNative } from '../server/risu-native-runtime.js';
import type { Store } from '../server/store.js';
import { nativeContent } from './fixtures/native-content.js';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.unstubAllGlobals();
  disposeAllNativeRisuSessions();
});

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE image_blobs (hash TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes BLOB NOT NULL)'
  );
  databases.push(db);
  const pkg = nativeContent({
    extensions: {
      risuai: {
        lowLevelAccess: true,
        triggerscript: [
          {
            type: 'start',
            effect: [
              {
                type: 'triggerlua',
                code: `function onStart(id)
        local answer = axLLM(id, {{role='user', content='Continue'}}, false, {mode='translate', streaming=true})
        setChatVar(id, 'answer', answer.result)
      end`,
              },
            ],
          },
        ],
      },
    },
  });
  const connection: Connection = {
    id: 'synthetic-connection',
    revision: 1,
    title: 'Synthetic',
    protocol: 'openai-chat-v1',
    endpoint: 'https://compatible.synthetic.invalid/v1',
    credentialRef: 'UIMORI_SYNTHETIC_SECRET',
    enabled: true,
    catalog: [],
    catalogError: null,
  };
  const model: ModelSnapshot = {
    id: 'model-main',
    revision: 1,
    title: 'Synthetic',
    connectionId: connection.id,
    modelId: 'main-model',
    connection,
    maxOutputTokens: 512,
    temperature: null,
  };
  const snapshot: RunSnapshot = {
    chatId: 'synthetic-chat',
    parentRevision: null,
    settingsRevision: 0,
    settings: { maxCalls: 8 },
    request: 'Continue',
    history: [],
    resources: [],
    profile: {
      ...defaultProfile('synthetic-chat'),
      models: {
        main: model,
        translation: { ...model, id: 'translation', modelId: 'translation-model' },
      },
      contextModel: { ...model, id: 'context', modelId: 'context-model' },
      scriptModel: { ...model, id: 'script', modelId: 'script-model' },
      packages: [pkg],
      packageAttachments: [{ id: pkg.id, revision: pkg.revision, role: 'bot' }],
    },
  };
  const usage: Usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const wires: WireRecord[] = [];
  const authorize = vi.fn(() => connection);
  const finishAttempt = vi.fn();
  const store = {
    db,
    run: () => ({ status: 'running' }),
    product: {
      authorize,
      startAttempt: (_chatId: string, _runId: string, _job: null, wire: WireRecord) => {
        wires.push(wire);
        return 'synthetic-attempt';
      },
      finishAttempt,
    },
  } as unknown as Store;
  const bodies: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const events = [
      {
        id: 'synthetic',
        choices: [{ index: 0, delta: { role: 'assistant', content: '첫' }, finish_reason: null }],
      },
      {
        id: 'synthetic',
        choices: [{ index: 0, delta: { content: ' 답' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      },
    ];
    return new Response(
      events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } }
    );
  });
  vi.stubGlobal('fetch', fetch);
  const host = createNativeRisuHost(
    store,
    'synthetic-run',
    snapshot,
    usage,
    { resolveCredential: () => 'synthetic-key' },
    'start'
  );
  const signal = new AbortController().signal;
  return { db, pkg, snapshot, usage, wires, authorize, finishAttempt, bodies, fetch, host, signal };
}

test.each([
  [undefined, 'script-model', 'otherAx'],
  ['otherAx', 'script-model', 'otherAx'],
  ['memory', 'context-model', 'memory'],
  ['translate', 'translation-model', 'translate'],
] as const)(
  'axLLM mode %s selects its frozen model and records its attribution',
  async (mode, model, expectedMode) => {
    const f = fixture();
    const result = await f.host(
      'axLLM',
      { prompt: 'Continue', options: mode ? { mode } : {} },
      f.signal
    );
    expect(result).toEqual({ success: true, result: '첫 답' });
    expect(f.bodies[0]?.model).toBe(model);
    expect(f.wires[0]?.nativeScript).toEqual({
      method: 'axLLM',
      event: 'start',
      mode: expectedMode,
    });
    expect(f.usage).toMatchObject({ modelCalls: 1, inputTokens: 12, outputTokens: 3 });
    expect(f.finishAttempt).toHaveBeenCalledOnce();
  }
);

test('otherAx falls back to the frozen main model, while the receipt checks mode and model identity', async () => {
  const f = fixture();
  f.snapshot.profile!.scriptModel = undefined;
  await f.host('axLLM', { prompt: 'Continue' }, f.signal);
  const wire = f.wires[0];
  expect(wire.modelId).toBe('main-model');
  expect(() =>
    validateNativeScriptAttempt(f.snapshot, {
      ...wire,
      nativeScript: { method: 'axLLM', event: 'start' },
    })
  ).not.toThrow();
  expect(() =>
    validateNativeScriptAttempt(f.snapshot, {
      ...wire,
      nativeScript: { method: 'axLLM', event: 'start', mode: 'translate' },
    })
  ).toThrow('RISU_NATIVE_ATTEMPT_MODEL');
  expect(() => validateNativeScriptAttempt(f.snapshot, { ...wire, connectionId: 'other' })).toThrow(
    'RISU_NATIVE_ATTEMPT_MODEL'
  );
  expect(() =>
    validateNativeScriptAttempt(f.snapshot, {
      ...wire,
      nativeScript: { method: 'LLM', event: 'start', mode: 'memory' },
    })
  ).toThrow('RISU_NATIVE_ATTEMPT_IDENTITY');
});

test('Lua streaming=true collects streamed chunks and honors the requested translation model', async () => {
  const f = fixture();
  const result = await executeRisuNative(
    {
      native: f.pkg.nativeRisu,
      variables: {},
      messages: [],
      charName: 'Bot',
      userName: 'User',
      event: 'start',
    },
    { host: f.host }
  );
  expect(result.variables.answer).toBe('첫 답');
  expect(f.bodies[0]).toMatchObject({ model: 'translation-model', stream: true });
  expect(f.usage.modelCalls).toBe(1);
});

test.each([
  ['unknown', 'Error: Invalid axLLM mode: unknown'],
  ['emotion', 'Error: RISU_NATIVE_MODEL_MODE_UNSUPPORTED:emotion'],
  ['submodel', 'Error: RISU_NATIVE_MODEL_MODE_UNSUPPORTED:submodel'],
] as const)(
  'unsupported or invalid axLLM mode %s does not start a provider attempt',
  async (mode, error) => {
    const f = fixture();
    expect(await f.host('axLLM', { prompt: 'Continue', options: { mode } }, f.signal)).toEqual({
      success: false,
      result: error,
    });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.usage.modelCalls).toBe(0);
  }
);

test.each(['memory', 'translate'] as const)(
  'unconfigured %s returns a structured failure without falling back',
  async (mode) => {
    const f = fixture();
    if (mode === 'memory') f.snapshot.profile!.contextModel = undefined;
    else delete f.snapshot.profile!.models.translation;
    expect(await f.host('axLLM', { prompt: 'Continue', options: { mode } }, f.signal)).toEqual({
      success: false,
      result: `Error: RISU_NATIVE_MODEL_REQUIRED:${mode}`,
    });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.usage.modelCalls).toBe(0);
  }
);

test.each([
  ['main', 'LLM', undefined],
  ['translation', 'axLLM', 'translate'],
  ['context', 'axLLM', 'memory'],
  ['script', 'axLLM', 'otherAx'],
] as const)(
  'disabled %s model fails without sending or falling back',
  async (role, method, mode) => {
    const f = fixture();
    const profile = f.snapshot.profile!;
    const target =
      role === 'context'
        ? profile.contextModel!
        : role === 'script'
          ? profile.scriptModel!
          : profile.models[role]!;
    target.enabled = false;
    expect(
      await f.host(method, { prompt: 'Continue', ...(mode ? { options: { mode } } : {}) }, f.signal)
    ).toEqual({ success: false, result: `Error: RISU_NATIVE_MODEL_DISABLED:${mode ?? 'main'}` });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.usage.modelCalls).toBe(0);
  }
);

test('explicit non-streaming fails without charging a provider call', async () => {
  const f = fixture();
  expect(
    await f.host('LLM', { prompt: 'Continue', options: { streaming: false } }, f.signal)
  ).toEqual({ success: false, result: 'Error: RISU_NATIVE_NONSTREAMING_UNSUPPORTED' });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.usage.modelCalls).toBe(0);
});

test('connection revocation before the wire prevents a provider attempt', async () => {
  const f = fixture();
  f.authorize.mockImplementationOnce(() => f.snapshot.profile!.models.main!.connection);
  f.authorize.mockImplementationOnce(() => {
    throw new Error('connection revoked');
  });
  const result = await f.host('LLM', { prompt: 'Continue' }, f.signal);
  expect(result).toMatchObject({ success: false });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.wires).toHaveLength(0);
  expect(f.usage.modelCalls).toBe(0);
});

test('cancellation after a request starts retains its cancelled attempt without a late result', async () => {
  const f = fixture();
  const controller = new AbortController();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      controller.abort();
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    })
  );
  await expect(f.host('LLM', { prompt: 'Continue' }, controller.signal)).rejects.toThrow();
  expect(f.wires).toHaveLength(1);
  expect(f.usage.modelCalls).toBe(1);
  expect(f.finishAttempt).toHaveBeenCalledWith(
    'synthetic-attempt',
    expect.objectContaining({ status: 'cancelled' })
  );
});

test('multimodal sends only frozen card and chat images, with actual image bytes at the provider boundary', async () => {
  const f = fixture();
  const png = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#ff0000' } })
    .png()
    .toBuffer();
  const assetHash = createHash('sha256').update(png).digest('hex');
  storeImage(f.db, { hash: assetHash, mime: 'image/png', bytes: png });
  f.pkg.images = [
    {
      id: 'image-0',
      title: 'happy-face',
      description: '',
      blobHash: assetHash,
      mime: 'image/png',
      allowedUse: 'both',
    },
  ];
  f.pkg.nativeRisu.assets = [
    { name: 'happy-face', uri: 'embeded://assets/happy.png', imageId: 'image-0' },
  ];
  const webp = await sharp({ create: { width: 10, height: 6, channels: 3, background: '#0000ff' } })
    .webp()
    .toBuffer();
  const chatHash = createHash('sha256').update(webp).digest('hex');
  storeImage(f.db, { hash: chatHash, mime: 'image/webp', bytes: webp });
  const chatImage: RequestImage = {
    hash: chatHash,
    mime: 'image/webp',
    name: 'chat.webp',
    width: 10,
    height: 6,
    input: { hash: chatHash, width: 10, height: 6 },
  };
  f.snapshot.requestImages = [chatImage];
  const result = await f.host(
    'LLM',
    {
      useMultimodal: true,
      prompt: [
        {
          role: 'user',
          content: `Look {{inlay::happy-face}} and {{inlayed::request-image:${chatHash}}}`,
        },
        { role: 'assistant', content: 'Earlier {{inlay::unknown}} {{inlayed::unknown}}' },
        { role: 'user', content: 'Continue {{inlayeddata::embeded://assets/happy.png}}' },
      ],
    },
    f.signal
  );
  expect(result).toEqual({ success: true, result: '첫 답' });
  const messages = f.bodies[0]!.messages as { role: string; content: unknown }[];
  const first = messages[1].content as {
    type: string;
    text?: string;
    image_url?: { url: string };
  }[];
  expect(first[0]).toEqual({ type: 'text', text: 'Look  and ' });
  expect(first).toHaveLength(3);
  expect(messages[2]).toEqual({
    role: 'assistant',
    content: [{ type: 'text', text: 'Earlier  ' }],
  });
  const red = Buffer.from(first[1].image_url!.url.split(',')[1], 'base64');
  const blue = Buffer.from(first[2].image_url!.url.split(',')[1], 'base64');
  const redPixels = await sharp(red).raw().toBuffer();
  const bluePixels = await sharp(blue).raw().toBuffer();
  expect(redPixels[0]).toBeGreaterThan(240);
  expect(redPixels[2]).toBeLessThan(15);
  expect(bluePixels[0]).toBeLessThan(15);
  expect(bluePixels[2]).toBeGreaterThan(240);
  expect(JSON.stringify(f.wires[0].body)).not.toContain(first[1].image_url!.url);
  expect(f.usage.modelCalls).toBe(1);
});

test('unowned inlay identifiers and unsupported message roles fail explicitly before a call', async () => {
  const f = fixture();
  const unowned = Buffer.from('not a chat attachment');
  const unownedHash = createHash('sha256').update(unowned).digest('hex');
  storeImage(f.db, { hash: unownedHash, mime: 'image/webp', bytes: unowned });
  for (const [role, content, error] of [
    ['user', '{{inlay::https://outside.example/image.png}}', 'RISU_NATIVE_INLAY_UNAVAILABLE'],
    ['user', `{{inlay::request-image:${unownedHash}}}`, 'RISU_NATIVE_INLAY_UNAVAILABLE'],
    ['system', '{{inlay::any}}', 'RISU_NATIVE_INLAY_ROLE_UNSUPPORTED'],
    ['assistant', '{{inlayeddata::any}}', 'RISU_NATIVE_INLAY_ROLE_UNSUPPORTED'],
  ] as const) {
    expect(
      await f.host('axLLM', { prompt: [{ role, content }], useMultimodal: true }, f.signal)
    ).toEqual({ success: false, result: `Error: ${error}` });
  }
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.wires).toHaveLength(0);
  expect(f.usage.modelCalls).toBe(0);
});
