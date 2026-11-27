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

import { saveImportReceipt, savedOrDraftChanged } from '../server/import-operations.js';
import { promptWorkspace, promptWorkspaceRoutes } from '../server/prompt-workspace.js';
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

test('supported preset text stages and regex import without partial consent and preserve original bytes', () => {
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
  expect(imported.preset.program).not.toHaveProperty('transforms');
  expect(imported.preset.program.nativeRisuPreset?.preset.regex).toEqual(
    JSON.parse(Buffer.from(source.base64, 'base64').toString()).regex
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

test('a saved import whose response was lost answers its receipt even when the preview digest changed since', () => {
  const { store } = fixture();
  const source = sourceOf({
    ...document(),
    promptTemplate: [...document().promptTemplate, { type: 'memory' }],
  });
  const preview = prepareRisuPresetImport({ source });
  const command = {
    source,
    digest: preview.digest,
    allowPartial: true,
    idempotencyKey: 'lost-response',
  };
  const before = store.product.all('prompt-preset').length;
  const first = applyRisuPresetImport(store, command);
  const retry = applyRisuPresetImport(store, { ...command, digest: 'digest-before-upgrade' });
  expect(retry.receipt).toEqual({ ...first.receipt, created: false });
  expect(retry.preset.id).toBe(first.preset.id);
  expect(store.product.all('prompt-preset')).toHaveLength(before + 1);
  expect(() =>
    applyRisuPresetImport(store, { ...command, digest: 'stale', idempotencyKey: 'never-saved' })
  ).toThrow(expect.objectContaining({ statusCode: 409, code: 'RISU_IMPORT_DRAFT_CHANGED' }));
});

test('a lost-response retry finds its preset receipt after hundreds of other imports', () => {
  const { store } = fixture();
  const source = sourceOf(document());
  const preview = prepareRisuPresetImport({ source });
  const command = {
    source,
    digest: preview.digest,
    allowPartial: false,
    idempotencyKey: 'outlived',
  };
  const first = applyRisuPresetImport(store, command);
  for (let index = 0; index < 260; index++)
    saveImportReceipt(store, `unrelated-import-${index}`, 'digest', { index });
  const retry = applyRisuPresetImport(store, { ...command, digest: 'digest-before-upgrade' });
  expect(retry.preset.id).toBe(first.preset.id);
  // @ts-expect-error a definite 409 needs a receipt key that is never trimmed
  expect(savedOrDraftChanged('risu-trimmed:key', () => 1)).toBe(1);
});
