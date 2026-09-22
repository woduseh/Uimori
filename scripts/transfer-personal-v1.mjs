import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, link, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { readLegacy24 } from './legacy24-source.mjs';
import { Store } from '../dist/server/store.js';
import { convertTransferImages } from '../dist/server/transfer-images.js';
import { inspectBundle, importResourceBundle } from '../dist/server/resource-bundle.js';
import { restoreChatCopy } from '../dist/server/chat-copy.js';
import { VertexCredentialStore } from '../dist/server/vertex-credentials.js';
import { apiKey } from '../dist/server/credentials.js';

/** An explicit one-time copy to a new DB. It never upgrades or writes the source database. */
export async function transferPersonalV1({ source, target, environmentKeys = false }) {
  source = resolve(source);
  target = resolve(target);
  if (source === target || existsSync(target))
    throw new Error('Choose a NEW destination file; existing files are never overwritten.');
  const reader = new DatabaseSync(source, { readOnly: true });
  let legacy;
  try {
    reader.exec('BEGIN');
    legacy = readLegacy24(reader);
  } finally {
    reader.close();
  }
  await mkdir(dirname(target), { recursive: true });
  const staging = await mkdtemp(join(dirname(target), 'uimori-v1-transfer-'));
  const stagedPath = join(staging, 'app.sqlite');
  let store;
  const report = {
    source,
    target,
    resources: 0,
    chats: 0,
    models: 0,
    connections: 0,
    images: 0,
    notices: legacy.notices,
  };
  try {
    store = new Store(stagedPath);
    const connectionIds = new Map(),
      modelIds = new Map();
    const accounts = new VertexCredentialStore(store.db);
    for (const original of legacy.connections) {
      const value = {
        title: original.title,
        protocol: original.protocol,
        endpoint: original.endpoint,
        enabled: original.enabled,
      };
      const oldReference = original.credentialEnv;
      if (
        typeof oldReference === 'string' &&
        /^UIMORI_PROVIDER_VERTEX_FILE_[A-F0-9]{32}$/.test(oldReference)
      ) {
        const file = `${source}.vertex-credentials/${oldReference.slice('UIMORI_PROVIDER_VERTEX_FILE_'.length)}.json`;
        if (existsSync(file))
          value.credentialRef = accounts.upload(
            JSON.parse(readFileSync(file, 'utf8'))
          ).credentialRef;
        else
          report.notices.push(`프로바이더 “${original.title}”의 서비스 계정을 다시 등록해 주세요.`);
      } else if (oldReference && environmentKeys && process.env[oldReference]) {
        value.apiKey = process.env[oldReference];
      } else if (oldReference)
        report.notices.push(`프로바이더 “${original.title}”의 API 키를 앱에서 등록해 주세요.`);
      if (original.catalogCredentialEnv && environmentKeys)
        value.catalogApiKey = process.env[original.catalogCredentialEnv] ?? null;
      const saved = store.product.connection(value);
      connectionIds.set(original.id, saved.id);
      report.connections++;
    }
    for (const original of legacy.models) {
      const { id, revision: _revision, ...model } = original;
      model.connectionId = connectionIds.get(model.connectionId);
      if (!model.connectionId) {
        report.notices.push(`모델 “${model.title}”은 연결이 없어 생략했어요.`);
        continue;
      }
      const saved = store.product.save('model', model);
      modelIds.set(id, saved.id);
      report.models++;
    }
    const jevFile = `${source}.jev-credentials/connection.json`;
    const jevKey = existsSync(jevFile)
      ? JSON.parse(readFileSync(jevFile, 'utf8')).apiKey
      : environmentKeys
        ? process.env.TYPESAFE_API_KEY
        : null;
    if (jevKey) store.credentials.set('jev', apiKey(jevKey));
    const converted = await convertTransferImages(legacy.file);
    const file = converted.file;
    const normalizedHashes = new Map(
      [...converted.imagesBySourceHash].map(([hash, image]) => [hash, image.hash])
    );
    const replaceMedia = (text) =>
      String(text).replace(/\/api\/package-image-blobs\/([a-f0-9]{64})/gu, (url, hash) =>
        normalizedHashes.has(hash) ? `/api/package-image-blobs/${normalizedHashes.get(hash)}` : url
      );
    const preview = inspectBundle(file);
    const receipt = importResourceBundle(store, {
      file,
      digest: preview.digest,
      idempotencyKey: randomUUID(),
      modelBindings: preview.modelRequirements.map((requirement) =>
        modelIds.has(requirement.sourceModelId)
          ? {
              requirementKey: requirement.key,
              mode: 'local',
              model: { id: modelIds.get(requirement.sourceModelId) },
            }
          : { requirementKey: requirement.key, mode: 'inherit-main' }
      ),
    });
    report.resources = receipt.items.length;
    report.images = file.images.length;
    const saved = new Map(receipt.items.map((item) => [item.key, item]));
    const contentIds = new Map(
      file.contents.map((entry) => [entry.source.id, saved.get(entry.key)])
    );
    const promptIds = new Map(
      file.prompts.map((entry) => [entry.source.id, saved.get(entry.key).id])
    );
    const mapModel = (ref) => (ref && modelIds.has(ref.id) ? { id: modelIds.get(ref.id) } : null);
    if (legacy.workspace) {
      const workspace = structuredClone(legacy.workspace);
      workspace.revision = 1;
      workspace.mainJudgmentEnabled = false;
      for (const role of ['main', 'translation']) {
        const prompt = workspace[role];
        if (prompt?.presetId) prompt.presetId = promptIds.get(prompt.presetId);
        for (const agent of prompt?.program?.collaboration?.agents ?? [])
          agent.model = mapModel(agent.model);
      }
      workspace.modelRoutes = Object.fromEntries(
        ['main', 'translation', 'status'].map((role) => [
          role,
          mapModel(workspace.modelRoutes?.[role]),
        ])
      );
      for (const role of ['helperModel', 'titleModel', 'contextModel', 'scriptModel'])
        workspace[role] = mapModel(workspace[role]);
      store.db
        .prepare('UPDATE prompt_workspace SET body=? WHERE id=1')
        .run(JSON.stringify(workspace));
    }
    for (const entry of legacy.conversations) {
      const copy = structuredClone(entry.copy);
      copy.transcript.packageAttachments = copy.transcript.packageAttachments.flatMap((ref) => {
        const target = contentIds.get(ref.id);
        return target ? [{ id: target.id, revision: target.revision, role: ref.role }] : [];
      });
      copy.transcript.entries = copy.transcript.entries.map((entry) => ({
        ...entry,
        text: replaceMedia(entry.text),
        translation: entry.translation === null ? null : replaceMedia(entry.translation),
      }));
      const pinned = copy.state.profile.pinned;
      if (pinned) {
        if (pinned.mainPromptPresetId)
          pinned.mainPromptPresetId = promptIds.get(pinned.mainPromptPresetId);
        if (pinned.mainModel) pinned.mainModel = mapModel(pinned.mainModel) ?? undefined;
      }
      for (const image of copy.illustrations) {
        const hash = createHash('sha256').update(Buffer.from(image.base64, 'base64')).digest('hex');
        const normalized = converted.imagesBySourceHash.get(hash);
        if (!normalized) throw new Error('Illustration is missing its image payload.');
        image.mime = normalized.mime;
        image.base64 = normalized.base64;
      }
      restoreChatCopy(store, copy, `legacy-${randomUUID()}`);
      report.chats++;
    }
    if (store.db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('Destination has invalid references; source is unchanged.');
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    store.close();
    store = undefined;
    // Same-filesystem exclusive publication. A concurrent creator cannot be overwritten.
    await link(stagedPath, target);
    return report;
  } finally {
    store?.close();
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2),
      input = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--source' || args[i] === '--target') input[args[i].slice(2)] = args[++i];
      else if (args[i] === '--environment-keys') input.environmentKeys = true;
      else throw new Error(`Unknown argument: ${args[i]}`);
    }
    if (!input.source || !input.target)
      throw new Error(
        'Usage: npm run transfer:personal -- --source OLD.sqlite --target NEW.sqlite [--environment-keys]'
      );
    console.log(JSON.stringify(await transferPersonalV1(input), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
