import { afterEach, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import {
  prepareRisuPresetImport,
  applyRisuPresetImport,
  risuPresetImportRoutes,
} from '../server/risu-preset-import.js';
import { nativeTransferOriginal } from '../server/native-transfer.js';
import {
  modelWorkspace,
  promptWorkspace,
  promptWorkspaceRoutes,
} from '../server/prompt-workspace.js';
import { promptRoutes } from '../server/prompt-routes.js';
import { createFixtureChat } from './fixtures/chat.js';

const owned: { path: string; store: Store; app: FastifyInstance }[] = [];
afterEach(async () => {
  for (const { path, store, app } of owned.splice(0)) {
    await app.close();
    store.close();
    const target = resolve(path),
      within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-risu-preset-')
    )
      throw new Error('Unsafe preset fixture cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-risu-preset-'));
  const store = new Store(join(path, 'test.sqlite'));
  const app = Fastify();
  risuPresetImportRoutes(app, store);
  promptWorkspaceRoutes(app, store, () => {});
  promptRoutes(app, store);
  owned.push({ path, store, app });
  return { store, app };
}
const document = () => ({
  name: 'Synthetic imported directions',
  aiModel: 'ignored-provider-model',
  temperature: 123,
  modelTools: ['ignored-tool'],
  customPromptTemplateToggle: 'tone=Tone=select=Quiet,Bold',
  promptTemplate: [
    {
      type: 'plain',
      type2: 'normal',
      role: 'system',
      text: '{{#when::tone::tis::1}}BOLD{{:else}}QUIET{{/when}}',
    },
    { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
  ],
});
const sourceOf = (value: unknown) => ({
  name: 'synthetic-preset.json',
  base64: Buffer.from(JSON.stringify(value)).toString('base64'),
});

test('review is read-only; explicit import, reuse, source preservation and archive share native transfer', () => {
  const { store } = fixture();
  const source = sourceOf(document());
  const before = store.product.export().tables;
  const preview = prepareRisuPresetImport({ source });
  expect(preview.summary).toEqual({ blocks: 2, controls: 1, regex: 0 });
  expect(preview.findings.some((item) => item.level === 'unsupported')).toBe(false);
  expect(store.product.export().tables).toEqual(before);
  const models = modelWorkspace(store),
    workspace = promptWorkspace(store);
  const command = { source, digest: preview.digest, allowPartial: false, idempotencyKey: 'same' };
  const first = applyRisuPresetImport(store, command);
  const second = applyRisuPresetImport(store, command);
  expect(second.receipt).toEqual({ ...first.receipt, created: false });
  expect(modelWorkspace(store)).toEqual(models);
  expect(promptWorkspace(store)).toEqual(workspace);
  expect(nativeTransferOriginal(store, first.receipt.id).sourceFiles![0].base64).toBe(
    source.base64
  );
  const { store: restored } = fixture();
  restored.product.import(store.product.export());
  expect(nativeTransferOriginal(restored, first.receipt.id).sourceFiles).toEqual(
    nativeTransferOriginal(store, first.receipt.id).sourceFiles
  );
  const different = sourceOf({ ...document(), name: 'Different title' });
  expect(() => applyRisuPresetImport(store, { ...command, source: different })).toThrow(
    'RISU_IMPORT_DRAFT_CHANGED'
  );
});

test('unsupported prompt semantics and regex require explicit partial import without dropping original bytes', () => {
  const { store } = fixture();
  const source = sourceOf({
    ...document(),
    promptTemplate: [{ type: 'plain', role: 'system', text: '{{setvar::x::1}}' }],
    regex: [{ type: 'editoutput', in: 'x', out: 'y' }],
  });
  const preview = prepareRisuPresetImport({ source });
  const before = store.product.export().tables;
  const command = {
    source,
    digest: preview.digest,
    allowPartial: false,
    idempotencyKey: 'partial',
  };
  expect(() => applyRisuPresetImport(store, command)).toThrow('RISU_IMPORT_PARTIAL_REQUIRED');
  expect(store.product.export().tables).toEqual(before);
  const result = applyRisuPresetImport(store, { ...command, allowPartial: true });
  expect(result.preset.program.blocks[0].enabled).toBe(false);
  expect(nativeTransferOriginal(store, result.receipt.id).sourceFiles![0].base64).toBe(
    source.base64
  );
});

test('supported preset text stages import without partial consent and preserve original bytes', () => {
  const { store } = fixture();
  const source = sourceOf({
    ...document(),
    regex: [
      {
        type: 'editprocess',
        in: '^again$',
        out: '{{#if {{equal::{{chatindex}}::{{lastmessageid}}}}}}continue{{/if}}',
      },
      { type: 'editdisplay', in: '^again$', out: 'Continue scene' },
    ],
  });
  const preview = prepareRisuPresetImport({ source });
  expect(preview.findings.filter((finding) => finding.level === 'unsupported')).toEqual([]);
  const imported = applyRisuPresetImport(store, {
    source,
    digest: preview.digest,
    allowPartial: false,
    idempotencyKey: 'supported-regex',
  });
  expect(imported.preset.program.transforms?.map((rule) => rule.stage)).toEqual([
    'input',
    'display',
  ]);
  expect(imported.preset.program.transforms?.[0].replacementTemplate).toBeDefined();
  expect(nativeTransferOriginal(store, imported.receipt.id).sourceFiles![0].base64).toBe(
    source.base64
  );
});

test('imported options apply through existing workspace and actual chat preview APIs', async () => {
  const { store, app } = fixture();
  const chat = createFixtureChat(store, 'Synthetic chat');
  const source = sourceOf(document());
  const preview = await app.inject({
    method: 'POST',
    url: '/api/risu-preset-imports/prepare',
    payload: { source },
  });
  expect(preview.statusCode, preview.body).toBe(200);
  const imported = await app.inject({
    method: 'POST',
    url: '/api/risu-preset-imports/apply',
    payload: { source, digest: preview.json().digest, allowPartial: false, idempotencyKey: 'api' },
  });
  expect(imported.statusCode, imported.body).toBe(200);
  const applied = await app.inject({
    method: 'POST',
    url: '/api/prompt-workspace/apply',
    payload: {
      expectedRevision: promptWorkspace(store).revision,
      role: 'main',
      presetId: imported.json().preset.id,
    },
  });
  expect(applied.statusCode, applied.body).toBe(200);
  const current = promptWorkspace(store);
  const selected = await app.inject({
    method: 'PUT',
    url: '/api/prompt-workspace',
    payload: {
      expectedRevision: current.revision,
      main: { ...current.main, values: { tone: '1' } },
    },
  });
  expect(selected.statusCode, selected.body).toBe(200);
  const request = await app.inject({
    method: 'POST',
    url: `/api/chats/${chat.id}/prompt-preview`,
    payload: { request: 'CURRENT REQUEST' },
  });
  expect(request.statusCode, request.body).toBe(200);
  const messages = request
    .json()
    .compilation.messages.map((message: { content: { text: string }[] }) =>
      message.content.map((part) => part.text).join('')
    );
  expect(messages).toContain('BOLD');
  expect(messages).toContain('CURRENT REQUEST');
  expect(messages).not.toContain('QUIET');
  expect(store.db.prepare('SELECT count(*) AS n FROM attempts').get()!.n).toBe(0);
});
