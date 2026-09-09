import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexRuntime, type CodexImageRequest } from '../server/codex-runtime.js';
import type { ProviderRequest, WireRecord } from '../core/transport.js';
import {
  CODEX_ILLUSTRATION_INSTRUCTIONS,
  CODEX_ILLUSTRATION_OUTPUT_SCHEMA,
  ILLUSTRATION_MAX_IMAGE_BYTES,
} from '../core/illustration.js';
import { PNG_BASE64 } from './fixtures/illustration.js';

const fixture = resolve('tests/fixtures/codex-app-server.mjs');
const connection = {
  id: 'codex-connection',
  protocol: 'codex-app-server-v1' as const,
  endpoint: 'codex://local',
};
const request = (references: CodexImageRequest['references'] = []): CodexImageRequest => ({
  modelId: 'gpt-5.4',
  reasoningEffort: 'low',
  developerInstructions: CODEX_ILLUSTRATION_INSTRUCTIONS,
  text: JSON.stringify({ scene: 'A lantern swings above the river.' }),
  outputSchema: CODEX_ILLUSTRATION_OUTPUT_SCHEMA,
  references,
});
const instances: CodexRuntime[] = [],
  roots: string[] = [];
function setup(
  mode: string,
  extra: NodeJS.ProcessEnv | ((directory: string) => NodeJS.ProcessEnv) = {}
) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'uimori-codex-image-test-'));
  roots.push(dir);
  const log = join(dir, 'requests.jsonl');
  const runtime = new CodexRuntime(join(dir, 'db.sqlite'), {
    enabled: true,
    launch: {
      command: process.execPath,
      args: [fixture],
      env: {
        UIMORI_CODEX_FIXTURE_MODE: mode,
        UIMORI_CODEX_FIXTURE_OUTPUT: '{"caption":"강 위의 등불"}',
        UIMORI_CODEX_FIXTURE_LOG: log,
        ...(typeof extra === 'function' ? extra(dir) : extra),
      },
    },
  });
  instances.push(runtime);
  const records = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  return { runtime, records, dir };
}
afterEach(async () => {
  await Promise.all(instances.splice(0).map((runtime) => runtime.close()));
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Codex illustration turns through the synthetic app-server', () => {
  it('enables only image generation, sends references as data URLs and returns decoded PNG bytes', async () => {
    const { runtime, records } = setup('image');
    const wires: WireRecord[] = [];
    const result = await runtime.generateImage(
      connection,
      request([{ mime: 'image/png', base64: PNG_BASE64 }]),
      {
        approvedOrigins: [],
        signal: new AbortController().signal,
        onWire: (wire) => {
          wires.push(structuredClone(wire));
        },
      }
    );
    expect(result.status).toBe('completed');
    expect(result.images).toHaveLength(1);
    expect(result.images[0].mime).toBe('image/png');
    expect(result.images[0].bytes.equals(Buffer.from(PNG_BASE64, 'base64'))).toBe(true);
    expect(result.revisedPrompt).toBe('fixture revised prompt');
    expect(result.text).toBe('{"caption":"강 위의 등불"}');
    expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 30, costUsd: null });
    const threadStart = records().find((entry) => entry.method === 'thread/start');
    expect(threadStart.params.config['features.image_generation']).toBe(true);
    expect(threadStart.params.config['features.shell_tool']).toBe(false);
    expect(threadStart.params.environments).toEqual([]);
    const turnStart = records().find((entry) => entry.method === 'turn/start');
    expect(turnStart.params.input).toEqual([
      { type: 'text', text: request().text, text_elements: [] },
      { type: 'image', url: `data:image/png;base64,${PNG_BASE64}` },
    ]);
    expect(turnStart.params.outputSchema).toEqual(CODEX_ILLUSTRATION_OUTPUT_SCHEMA);
    expect(wires).toHaveLength(1);
    expect(wires[0].role).toBe('illustration');
    expect(JSON.stringify(wires[0].body)).not.toContain(PNG_BASE64);
    expect((wires[0].body as { attachments: unknown[] }).attachments).toEqual([
      {
        mime: 'image/png',
        bytes: Buffer.from(PNG_BASE64, 'base64').length,
        sha256: createHash('sha256').update(Buffer.from(PNG_BASE64, 'base64')).digest('hex'),
      },
    ]);
  });
  it('reads a saved file from the dedicated Codex home when the result is not inline and removes it', async () => {
    const { runtime, dir } = setup('image-saved-path');
    const result = await runtime.generateImage(connection, request(), {
      approvedOrigins: [],
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('completed');
    expect(result.images[0].bytes.equals(Buffer.from(PNG_BASE64, 'base64'))).toBe(true);
    expect(result.revisedPrompt).toBe('fixture revised prompt (saved)');
    const saved = join(dir, 'db.sqlite.codex', 'generated_images');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const leftovers = existsSync(saved)
      ? readdirSync(saved, { recursive: true }).filter((name) => String(name).endsWith('.png'))
      : [];
    expect(leftovers).toEqual([]);
  });
  it('reports usage limits and missing images as distinct failure codes with usage retained', async () => {
    const limited = setup('image-usage-limit');
    const limit = await limited.runtime.generateImage(connection, request(), {
      approvedOrigins: [],
      signal: new AbortController().signal,
    });
    expect(limit.status).toBe('error');
    expect(limit.error).toEqual({
      code: 'CODEX_IMAGE_USAGE_LIMIT',
      usageLimit: { limitId: 'image_gen', resetsAt: 1800000000 },
    });
    expect(limit.images).toEqual([]);
    expect(limit.usage.inputTokens).toBe(100);
    const none = setup('image-none');
    const missing = await none.runtime.generateImage(connection, request(), {
      approvedOrigins: [],
      signal: new AbortController().signal,
    });
    expect(missing.status).toBe('error');
    expect(missing.error?.code).toBe('CODEX_IMAGE_NOT_GENERATED');
    expect(missing.text).toBe('{"caption":"강 위의 등불"}');
  });
  it('text decision turns keep image generation disabled and reject an unexpected image item', async () => {
    const { runtime, records } = setup('image', {
      UIMORI_CODEX_FIXTURE_OUTPUT: JSON.stringify({
        kind: 'final',
        text: 'A scene.',
        toolCalls: [],
      }),
    });
    const text: ProviderRequest = {
      role: 'main',
      modelId: 'gpt-5.4',
      stable: { contract: 'Write the synthetic scene.', tools: [] },
      generation: { maxOutputTokens: 1024, temperature: null },
      input: { task: 'Synthetic request', controls: {} },
    };
    const result = await runtime.execute(connection, text, {
      approvedOrigins: [],
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('CODEX_TOOL_NOT_ALLOWED');
    const threadStart = records().find((entry) => entry.method === 'thread/start');
    expect(threadStart.params.config['features.image_generation']).toBe(false);
  });
  it('rejects invalid connections, oversized reference lists and cancellation before any RPC', async () => {
    const { runtime, records } = setup('image');
    const wrong = await runtime.generateImage(
      { ...connection, protocol: 'openai-chat-v1' },
      request(),
      { approvedOrigins: [], signal: new AbortController().signal }
    );
    expect(wrong.error?.code).toBe('CODEX_INVALID_CONNECTION');
    const many = await runtime.generateImage(
      connection,
      request(Array.from({ length: 9 }, () => ({ mime: 'image/png', base64: PNG_BASE64 }))),
      { approvedOrigins: [], signal: new AbortController().signal }
    );
    expect(many.error?.code).toBe('CODEX_IMAGE_TOO_MANY_REFERENCES');
    const controller = new AbortController();
    controller.abort();
    const cancelled = await runtime.generateImage(connection, request(), {
      approvedOrigins: [],
      signal: controller.signal,
    });
    expect(cancelled.status).toBe('cancelled');
    expect(records()).toEqual([]);
  });

  it.each(['unsupported-mime', 'mime-mismatch', 'invalid-base64', 'oversize'] as const)(
    'rejects %s reference bytes before opening any RPC',
    async (fault) => {
      const { runtime, records } = setup('image');
      const png = Buffer.from(PNG_BASE64, 'base64');
      const base64 =
        fault === 'invalid-base64'
          ? `!${PNG_BASE64}`
          : fault === 'oversize'
            ? Buffer.concat([
                png,
                Buffer.alloc(ILLUSTRATION_MAX_IMAGE_BYTES + 1 - png.length),
              ]).toString('base64')
            : PNG_BASE64;
      const mime =
        fault === 'unsupported-mime'
          ? 'image/svg+xml'
          : fault === 'mime-mismatch'
            ? 'image/jpeg'
            : 'image/png';
      const result = await runtime.generateImage(connection, request([{ mime, base64 }]), {
        approvedOrigins: [],
        signal: new AbortController().signal,
      });
      expect(result.error?.code).toBe('CODEX_IMAGE_INVALID_REFERENCE');
      expect(result.images).toEqual([]);
      expect(records()).toEqual([]);
    }
  );

  it.each(['outside', 'junction'] as const)(
    'refuses a saved image reached through %s and leaves the external file untouched',
    async (kind) => {
      let outside = '';
      const { runtime } = setup('image-saved-path', (dir) => {
        const directory = join(dir, 'outside-codex-home');
        mkdirSync(directory);
        outside = join(directory, 'external.png');
        writeFileSync(outside, Buffer.from(PNG_BASE64, 'base64'));
        if (kind === 'outside') return { UIMORI_CODEX_FIXTURE_SAVED_PATH: outside };
        const codexHome = join(dir, 'db.sqlite.codex');
        mkdirSync(codexHome);
        const link = join(codexHome, 'linked-images');
        symlinkSync(directory, link, 'junction');
        return { UIMORI_CODEX_FIXTURE_SAVED_PATH: join(link, 'external.png') };
      });
      const result = await runtime.generateImage(connection, request(), {
        approvedOrigins: [],
        signal: new AbortController().signal,
      });
      expect(result.error?.code).toBe('CODEX_IMAGE_NOT_GENERATED');
      expect(result.images).toEqual([]);
      expect(existsSync(outside)).toBe(true);
    }
  );

  it('rejects an oversized saved file before reading it and preserves the rejected artifact', async () => {
    let saved = '';
    const { runtime } = setup('image-saved-path', (dir) => {
      const codexHome = join(dir, 'db.sqlite.codex');
      mkdirSync(codexHome);
      saved = join(codexHome, 'oversized.png');
      const png = Buffer.from(PNG_BASE64, 'base64');
      writeFileSync(
        saved,
        Buffer.concat([png, Buffer.alloc(ILLUSTRATION_MAX_IMAGE_BYTES + 1 - png.length)])
      );
      return { UIMORI_CODEX_FIXTURE_SAVED_PATH: saved };
    });
    const result = await runtime.generateImage(connection, request(), {
      approvedOrigins: [],
      signal: new AbortController().signal,
    });
    expect(result.error?.code).toBe('CODEX_IMAGE_NOT_GENERATED');
    expect(result.images).toEqual([]);
    await runtime.close();
    expect(existsSync(saved)).toBe(true);
  });

  it('uses a valid inline image without reading or deleting an unrelated savedPath', async () => {
    let saved = '';
    const { runtime } = setup('image', (dir) => {
      const codexHome = join(dir, 'db.sqlite.codex');
      mkdirSync(codexHome);
      saved = join(codexHome, 'local-settings.json');
      writeFileSync(saved, '{"syntheticSetting":"keep"}');
      return { UIMORI_CODEX_FIXTURE_SAVED_PATH: saved };
    });
    const result = await runtime.generateImage(connection, request(), {
      approvedOrigins: [],
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('completed');
    await runtime.close();
    expect(readFileSync(saved, 'utf8')).toBe('{"syntheticSetting":"keep"}');
  });

  it('rejects inline image data whose declared MIME disagrees with its bytes', async () => {
    const { runtime } = setup('image', {
      UIMORI_CODEX_FIXTURE_IMAGE: `data:image/jpeg;base64,${PNG_BASE64}`,
    });
    const result = await runtime.generateImage(connection, request(), {
      approvedOrigins: [],
      signal: new AbortController().signal,
    });
    expect(result.error?.code).toBe('CODEX_IMAGE_NOT_GENERATED');
  });
});
