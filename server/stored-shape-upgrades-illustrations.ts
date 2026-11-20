import type { DatabaseSync } from 'node:sqlite';
import { defaultIllustrationSettings } from '../core/illustration.js';

type StoredObject = Record<string, unknown>;

const tableExists = (db: DatabaseSync, name: string) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

const isObject = (value: unknown): value is StoredObject =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : isObject(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])])
        )
      : value;

function upgradeSettings(body: StoredObject): StoredObject {
  const defaults = defaultIllustrationSettings();
  const { generator, ...saved } = body;
  const codex = isObject(saved.codex) ? saved.codex : {};
  const countMode = saved.automaticCountMode
    ? {}
    : {
        automaticCountMode: 'fixed',
        automaticMinTargets: 0,
        automaticMaxTargets: saved.automaticMaxTargets ?? 1,
      };
  return {
    ...defaults,
    ...saved,
    ...countMode,
    ...(generator === 'fixture' ? { generator } : {}),
    ...(generator === 'none' ? { automatic: false } : {}),
    codex: {
      ...defaults.codex,
      ...codex,
      ...(Object.hasOwn(codex, 'promptModel') ? {} : { promptModel: codex.model ?? null }),
    },
    comfyui: { ...defaults.comfyui, ...(isObject(saved.comfyui) ? saved.comfyui : {}) },
    novelai: { ...defaults.novelai, ...(isObject(saved.novelai) ? saved.novelai : {}) },
  };
}

function upgradePreset(preset: StoredObject): StoredObject {
  const comfyui = isObject(preset.comfyui) ? preset.comfyui : {};
  const workflow = typeof comfyui.workflow === 'string' ? comfyui.workflow : '';
  return {
    ...preset,
    ...(preset.generator === undefined ? { generator: workflow.trim() ? 'comfyui' : 'codex' } : {}),
    ...(preset.novelai === undefined ? { novelai: { negativeGuidance: '' } } : {}),
  };
}

function upgradeReferences(body: unknown): unknown {
  if (Array.isArray(body)) return { references: body, characterProfiles: [] };
  if (isObject(body) && !Object.hasOwn(body, 'characterProfiles'))
    return { ...body, characterProfiles: [] };
  return body;
}

function upgradeJobInput(input: StoredObject): StoredObject {
  return Object.hasOwn(input, 'task') ? input : { ...input, task: 'render' };
}

const presetNeedsUpgrade = (column: string) =>
  `json_valid(${column}) AND json_type(${column})='object' AND (json_type(${column},'$.generator') IS NULL OR json_type(${column},'$.novelai') IS NULL)`;

function rewriteJsonColumn(
  db: DatabaseSync,
  select: string,
  update: string,
  upgrade: (value: unknown) => unknown
) {
  const write = db.prepare(update);
  for (const row of db.prepare(select).all() as { key: unknown; value: string }[]) {
    const saved = JSON.parse(row.value);
    const next = upgrade(saved);
    if (JSON.stringify(canonical(next)) !== JSON.stringify(canonical(saved)))
      write.run(JSON.stringify(next), row.key as string);
  }
}

export function upgradeIllustrationStoredShapes(db: DatabaseSync): void {
  if (tableExists(db, 'illustration_settings'))
    rewriteJsonColumn(
      db,
      'SELECT id AS key,body AS value FROM illustration_settings WHERE json_valid(body)',
      'UPDATE illustration_settings SET body=? WHERE id=?',
      (body) => (isObject(body) ? upgradeSettings(body) : body)
    );
  const preset = (value: unknown) => (isObject(value) ? upgradePreset(value) : value);
  rewriteJsonColumn(
    db,
    `SELECT id AS key,body AS value FROM versions WHERE kind='illustration-preset' AND ${presetNeedsUpgrade('body')}`,
    "UPDATE versions SET body=? WHERE kind='illustration-preset' AND id=?",
    preset
  );
  rewriteJsonColumn(
    db,
    `SELECT id AS key,model AS value FROM resource_undo WHERE kind='illustration-preset' AND ${presetNeedsUpgrade('model')}`,
    "UPDATE resource_undo SET model=? WHERE kind='illustration-preset' AND id=?",
    preset
  );
  if (tableExists(db, 'illustration_references'))
    rewriteJsonColumn(
      db,
      `SELECT chat_id AS key,body AS value FROM illustration_references WHERE json_valid(body)
        AND (json_type(body)='array' OR (json_type(body)='object' AND json_type(body,'$.characterProfiles') IS NULL))`,
      'UPDATE illustration_references SET body=? WHERE chat_id=?',
      upgradeReferences
    );
  if (tableExists(db, 'illustration_jobs'))
    rewriteJsonColumn(
      db,
      `SELECT id AS key,input AS value FROM illustration_jobs WHERE json_valid(input)
        AND json_type(input)='object' AND json_type(input,'$.task') IS NULL`,
      'UPDATE illustration_jobs SET input=? WHERE id=?',
      (input) => (isObject(input) ? upgradeJobInput(input) : input)
    );
}
