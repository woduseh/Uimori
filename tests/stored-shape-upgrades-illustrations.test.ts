import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { Store } from '../server/store.js';
import { defaultIllustrationSettings } from '../core/illustration.js';
import { illustrationReferences, illustrationSettings } from '../server/illustrations.js';
import { illustrationPresetCatalog } from '../server/illustration-presets.js';
import { chatWithSource } from './fixtures/illustration.js';

const owned: { store?: Store; path: string }[] = [];
afterEach(() => {
  for (const item of owned.splice(0)) {
    item.store?.close();
    const within = relative(tmpdir(), item.path);
    if (isAbsolute(within) || within.startsWith('..') || !within.startsWith('uimori-upgrade-'))
      throw new Error('Unsafe cleanup');
    rmSync(item.path, { recursive: true, force: true });
  }
});

const WORKFLOW = JSON.stringify({ '1': { class_type: 'SaveImage', inputs: {} } });

test('old illustration settings, presets, references and job inputs are completed once without revision changes', () => {
  const path = mkdtempSync(join(tmpdir(), 'uimori-upgrade-'));
  const file = join(path, 'story.sqlite');
  const item: { store?: Store; path: string } = { store: new Store(file), path };
  owned.push(item);
  const db = () => item.store!.db;
  const { chat, source } = chatWithSource(item.store!);
  const { chat: currentChat } = chatWithSource(item.store!, 'Current references');
  const defaults = defaultIllustrationSettings();

  db()
    .prepare('UPDATE illustration_settings SET body=? WHERE id=1')
    .run(
      JSON.stringify({
        revision: 7,
        generator: 'none',
        automatic: true,
        maxPerSource: 4,
        automaticMaxTargets: 3,
        maxAutoRetries: 2,
        codex: { model: { id: 'image-model' }, useReferences: false },
        comfyui: { baseUrl: 'http://127.0.0.1:8188', promptModel: null },
      })
    );
  const presetBody = (id: string, revision: number, workflow: string, extra = {}) =>
    JSON.stringify({
      id,
      revision,
      title: id,
      description: '',
      styleGuidance: '',
      comfyui: { workflow, negativeGuidance: '' },
      ...extra,
    });
  const insertPreset = db().prepare(
    "INSERT INTO versions(kind,id,revision,body) VALUES('illustration-preset',?,?,?)"
  );
  insertPreset.run('legacy-codex', 3, presetBody('legacy-codex', 3, ''));
  insertPreset.run('legacy-comfy', 5, presetBody('legacy-comfy', 5, WORKFLOW));
  const currentPreset = presetBody('current', 2, WORKFLOW, {
    generator: 'novelai',
    novelai: { negativeGuidance: 'blur' },
  });
  insertPreset.run('current', 2, currentPreset);
  db()
    .prepare("INSERT INTO library_hidden(kind,id) VALUES('illustration-preset','legacy-comfy')")
    .run();
  db()
    .prepare(
      "INSERT INTO resource_undo(kind,id,saved_revision,model) VALUES('illustration-preset','legacy-comfy',5,?)"
    )
    .run(
      JSON.stringify({
        title: 'before',
        description: '',
        styleGuidance: '',
        comfyui: { workflow: WORKFLOW, negativeGuidance: '' },
      })
    );
  const references = [{ ref: 'asset-1', role: 'character' }];
  const currentReferences = JSON.stringify({
    references: [],
    characterProfiles: [{ id: 'p1', name: 'Mira', appearance: 'Silver braid' }],
  });
  const insertReferences = db().prepare(
    'INSERT INTO illustration_references(chat_id,revision,body) VALUES(?,?,?)'
  );
  insertReferences.run(chat.id, 4, JSON.stringify(references));
  insertReferences.run(currentChat.id, 2, currentReferences);
  const codexModel = { id: 'image-model', title: 'Image', modelId: 'gpt-image' };
  const insertJob = db().prepare(
    `INSERT INTO illustration_jobs(id,chat_id,source_revision,source_hash,origin,status,input,created_at,updated_at)
     VALUES(?,?,?,?,'manual','completed',?,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z')`
  );
  insertJob.run(
    'legacy-job',
    chat.id,
    source.id,
    source.hash,
    JSON.stringify({ version: 1, generator: 'codex', codex: { model: codexModel, references: [] } })
  );
  const currentJob = JSON.stringify({
    version: 1,
    task: 'plan',
    generator: 'codex',
    codex: { model: codexModel, promptModel: { ...codexModel, id: 'text' }, references: [] },
  });
  insertJob.run('current-job', chat.id, source.id, source.hash, currentJob);
  const restoredJob = JSON.stringify({ version: 1, task: 'render', generator: 'none' });
  insertJob.run('restored-job', chat.id, source.id, source.hash, restoredJob);

  const snapshot = () => ({
    settings: db().prepare('SELECT body FROM illustration_settings').all(),
    presets: db()
      .prepare("SELECT id,revision,body FROM versions WHERE kind='illustration-preset' ORDER BY id")
      .all(),
    undo: db().prepare('SELECT id,saved_revision,model FROM resource_undo').all(),
    references: db()
      .prepare('SELECT chat_id,revision,body FROM illustration_references ORDER BY revision')
      .all(),
    jobs: db().prepare('SELECT id,input FROM illustration_jobs ORDER BY id').all(),
  });
  const reopen = () => {
    item.store!.close();
    item.store = undefined;
    item.store = new Store(file);
  };

  reopen();
  expect(illustrationSettings(item.store!)).toEqual({
    ...defaults,
    revision: 7,
    automatic: false,
    maxPerSource: 4,
    automaticCountMode: 'fixed',
    automaticMinTargets: 0,
    automaticMaxTargets: 3,
    maxAutoRetries: 2,
    codex: {
      ...defaults.codex,
      model: { id: 'image-model' },
      useReferences: false,
      promptModel: { id: 'image-model' },
    },
    comfyui: { ...defaults.comfyui, baseUrl: 'http://127.0.0.1:8188' },
  });
  const upgraded = snapshot();
  const presets = upgraded.presets.map((row) => ({
    id: row.id,
    revision: row.revision,
    body: JSON.parse(String(row.body)),
  }));
  expect(presets).toEqual([
    { id: 'current', revision: 2, body: JSON.parse(currentPreset) },
    {
      id: 'legacy-codex',
      revision: 3,
      body: expect.objectContaining({
        revision: 3,
        generator: 'codex',
        novelai: { negativeGuidance: '' },
      }),
    },
    {
      id: 'legacy-comfy',
      revision: 5,
      body: expect.objectContaining({
        revision: 5,
        generator: 'comfyui',
        novelai: { negativeGuidance: '' },
      }),
    },
  ]);
  expect(upgraded.presets[0].body).toBe(currentPreset);
  expect(illustrationPresetCatalog(item.store!).presets.map((preset) => preset.generator)).toEqual(
    expect.arrayContaining(['codex', 'novelai'])
  );
  expect(upgraded.undo).toEqual([
    {
      id: 'legacy-comfy',
      saved_revision: 5,
      model: expect.stringContaining('"generator":"comfyui"'),
    },
  ]);
  expect(JSON.parse(String(upgraded.undo[0].model)).novelai).toEqual({ negativeGuidance: '' });
  expect(upgraded.references).toEqual([
    {
      chat_id: currentChat.id,
      revision: 2,
      body: currentReferences,
    },
    {
      chat_id: chat.id,
      revision: 4,
      body: JSON.stringify({ references, characterProfiles: [] }),
    },
  ]);
  expect(illustrationReferences(item.store!, chat.id)).toMatchObject({
    revision: 4,
    references,
    chatCharacterProfiles: [],
  });
  const jobs = Object.fromEntries(upgraded.jobs.map((row) => [row.id, String(row.input)]));
  expect(JSON.parse(jobs['legacy-job'])).toEqual({
    version: 1,
    task: 'render',
    generator: 'codex',
    codex: { model: codexModel, references: [] },
  });
  expect(jobs['current-job']).toBe(currentJob);
  expect(jobs['restored-job']).toBe(restoredJob);

  reopen();
  expect(snapshot()).toEqual(upgraded);
});

test('a malformed illustration job row is left for its reader instead of stopping the store from opening', () => {
  const path = mkdtempSync(join(tmpdir(), 'uimori-upgrade-'));
  const file = join(path, 'story.sqlite');
  const item: { store?: Store; path: string } = { store: new Store(file), path };
  owned.push(item);
  const { chat, source } = chatWithSource(item.store!);
  const insertJob = item.store!.db.prepare(
    `INSERT INTO illustration_jobs(id,chat_id,source_revision,source_hash,origin,status,input,created_at,updated_at)
     VALUES(?,?,?,?,'manual','completed',?,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z')`
  );
  insertJob.run('malformed-job', chat.id, source.id, source.hash, '{"version":1,');
  insertJob.run('legacy-job', chat.id, source.id, source.hash, '{"version":1,"generator":"codex"}');
  item.store!.close();
  item.store = new Store(file);
  const inputs = Object.fromEntries(
    (
      item.store.db.prepare('SELECT id,input FROM illustration_jobs ORDER BY id').all() as {
        id: string;
        input: string;
      }[]
    ).map((row) => [row.id, row.input])
  );
  expect(inputs['malformed-job']).toBe('{"version":1,');
  expect(JSON.parse(inputs['legacy-job'])).toEqual({
    version: 1,
    generator: 'codex',
    task: 'render',
  });
});
