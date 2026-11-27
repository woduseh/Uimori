import { createHash, randomUUID } from 'node:crypto';
import { fields, HttpError, record } from './request-validation.js';
import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import { successfulTranslation, validateTranslationArtifact } from './translation-artifacts.js';
import {
  buildPackagePresentation,
  clearPackagePresentationRenderCache,
  PACKAGE_PRESENTATION_RENDERER_VERSION,
} from './package-presentation.js';
import { nativeSourceIdentity, nativeSourceSnapshot } from './risu-native-actions.js';
import { nativeRisuSessionKey } from './risu-native-context.js';
import { nativeImageDisplayText } from './risu-native-images.js';
import { readStoredRunSnapshot } from './run-projections.js';
import { executionSnapshot } from './execution-snapshot.js';
import { readDisplayViewport } from './display-viewport.js';
import { latestImageJob } from './package-images.js';
import { ByteBoundedCache } from './byte-bounded-cache.js';
import { trackNativeRisuEntropy } from './risu-native-entropy.js';
import type { NativeRisuCbsContext } from './risu-native-cbs.js';
import { withRisuFailureCode } from './risu-failure-code.js';

type Viewport = NativeRisuCbsContext['viewport'];
type Presentation = { key: string; compute: () => Promise<unknown> };
type Rendered = { body: string; cacheable: boolean };

const bootId = randomUUID();
const presentations = new ByteBoundedCache<string>({
  maxBytes: 64 * 1024 * 1024,
  maxEntries: 1000,
});
const inFlight = new Map<string, Promise<Rendered>>();
const digest = (value: unknown) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('base64url');

function preparePresentation(
  store: Store,
  chatId: string,
  sourceId: string,
  viewport: Viewport
): Presentation {
  store.chat(chatId);
  const source = store.source(sourceId);
  if (source.chatId !== chatId) throw new HttpError(404, 'Source not found');
  const { phaseSpans: _phaseSpans, ...stored } = readStoredRunSnapshot(store, source.runId);
  const { settled, ...saved } = stored;
  const snapshot = settled
    ? {
        ...saved,
        profile: store.product.snapshot(stored.chatId, 'inspect', stored.parentRevision),
      }
    : stored;
  if (snapshot.profile) snapshot.profile.image = store.product.profile(source.chatId).image;
  if (snapshot.chatId !== source.chatId) throw new HttpError(409, 'Source run mismatch');
  const job = successfulTranslation(store, source);
  let translation: { text: string; sourceRevision: string; sourceHash: string } | undefined;
  if (job?.status === 'completed' && job.sourceHash === source.hash) {
    validateTranslationArtifact(job, source);
    translation = {
      text: job.result!.text ?? '',
      sourceRevision: source.id,
      sourceHash: source.hash,
    };
  }
  const translationIdentity = translation
    ? { id: job!.id, revision: job!.revision ?? 0, text: digest(translation.text) }
    : null;
  const keyOf = (inputs: Record<string, unknown>) =>
    digest({
      version: PACKAGE_PRESENTATION_RENDERER_VERSION,
      chatId,
      source: { id: source.id, hash: source.hash },
      translation: translationIdentity,
      viewport: viewport ?? null,
      ...inputs,
    });
  if (snapshot.profile?.packages?.some((pkg) => pkg.nativeRisu)) {
    const live = nativeSourceSnapshot(store, source.chatId, source.id, snapshot, {
      sharedHistory: true,
    });
    const own = snapshot;
    const head = live.snapshot.parentRevision!;
    const nativeAction = {
      program: nativeRisuSessionKey(live.snapshot),
      sourceIdentity: nativeSourceIdentity(source.id, stored),
      expectedHeadRevision: head,
      expectedHeadHash: store.source(head).hash,
      expectedVariableRevision: live.variables.revision,
    };
    const { history: _history, logicalHistory: _logical, ...rest } = live.snapshot;
    const snapshotDigest = digest([digest(rest), live.historyDigest]);
    const key = keyOf({
      snapshot: snapshotDigest,
      nativeAction,
      images: live.snapshot.profile?.image
        ? digest({
            original: latestImageJob(store, source.id, 'original'),
            translation: latestImageJob(store, source.id, 'translation'),
            assets: store.product.assets(source.chatId),
          })
        : null,
    });
    return {
      key,
      compute: async () => {
        const first = own.packageStart?.mode === 'authored' || own.nativeRisuAuthored?.greeting;
        const messages = first
          ? [{ text: source.text, index: -1, role: 'assistant' as const, primary: true }]
          : (live.snapshot.logicalHistory ?? [])
              .filter((entry) => entry.sourceKind !== 'authored-start')
              .map((entry, index) => ({ ...entry, index }))
              .filter(
                (entry) =>
                  entry.sourceRevision === source.id &&
                  entry.id !== `request:${source.id}` &&
                  !(own.nativeRisuAuthored && entry.role === 'user')
              )
              .map((entry) => ({
                text: entry.text,
                index: entry.index,
                role: entry.role,
                primary: own.nativeRisuAuthored
                  ? entry.role === 'assistant'
                  : entry.id === `source:${source.id}`,
              }));
        const primary = messages.find((message) => message.primary);
        const imageView =
          primary?.text === source.text
            ? await nativeImageDisplayText(store, live.snapshot, source.id, 'original', viewport)
            : { text: primary?.text ?? '', issues: [] };
        if (primary) primary.text = imageView.text;
        const imageTranslation = translation
          ? await nativeImageDisplayText(store, live.snapshot, source.id, 'translation', viewport)
          : undefined;
        const presentation = await buildPackagePresentation(
          live.snapshot,
          { ...source, ...(translation ? { translation } : {}) },
          {
            viewport,
            snapshotDigest,
            nativeMessages: messages,
            ...(imageTranslation ? { nativeTranslationText: imageTranslation.text } : {}),
          }
        );
        return {
          ...presentation,
          issues: [
            ...presentation.issues,
            ...imageView.issues,
            ...(imageTranslation?.issues ?? []),
          ],
          translationId: translationIdentity?.id ?? null,
          translationRevision: translationIdentity?.revision ?? null,
          nativeAction,
        };
      },
    };
  }
  const restored = executionSnapshot(store, stored);
  return {
    key: keyOf({ snapshot: digest(restored) }),
    compute: async () => {
      const presentation = await buildPackagePresentation(restored, {
        ...source,
        ...(translation ? { translation } : {}),
      });
      return {
        ...presentation,
        translationId: translationIdentity?.id ?? null,
        translationRevision: translationIdentity?.revision ?? null,
      };
    },
  };
}

function renderPresentation(presentation: Presentation): Promise<Rendered> {
  const cached = presentations.get(presentation.key);
  if (cached !== undefined) return Promise.resolve({ body: cached, cacheable: true });
  const running = inFlight.get(presentation.key);
  if (running) return running;
  const work = trackNativeRisuEntropy(presentation.compute)
    .then(({ value, entropyUsed }) => {
      const body = JSON.stringify(value);
      if (!entropyUsed) presentations.set(presentation.key, body, body.length * 2);
      return { body, cacheable: !entropyUsed };
    })
    .finally(() => inFlight.delete(presentation.key));
  inFlight.set(presentation.key, work);
  return work;
}

const entityTag = (key: string) => `W/"${bootId}.${key}"`;

function matchesEntityTag(header: string | string[] | undefined, etag: string) {
  if (header === undefined) return false;
  const opaque = etag.slice(2);
  return String(header)
    .split(',')
    .some((candidate) => candidate.trim().replace(/^W\//u, '') === opaque);
}

let interactive = 0;
const lastViewports = new Map<string, NonNullable<Viewport>>();
const recentSources = new Map<string, string[]>();
const precomputeQueue = new Map<string, { store: Store; sourceId: string }>();
const PRECOMPUTE_QUEUE_MAX = 32;
const RECENT_SOURCES_PER_CHAT = 6;
const REMEMBERED_CHATS = 32;
let precomputing = false;
let canPrecompute: () => boolean = () => false;
let trackPrecompute: (work: Promise<void>) => void = () => {};

function remember<Value>(map: Map<string, Value>, key: string, value: Value) {
  map.delete(key);
  map.set(key, value);
  for (const oldest of map.keys()) {
    if (map.size <= REMEMBERED_CHATS) break;
    map.delete(oldest);
  }
}

function pumpPrecompute() {
  if (precomputing || interactive > 0) return;
  const next = precomputeQueue.entries().next().value;
  if (!next) return;
  const [queued, { store, sourceId }] = next;
  precomputeQueue.delete(queued);
  if (!canPrecompute()) {
    precomputeQueue.clear();
    return;
  }
  precomputing = true;
  trackPrecompute(
    (async () => {
      try {
        const chatId = store.source(sourceId).chatId;
        const viewport = lastViewports.get(chatId);
        if (viewport)
          await renderPresentation(preparePresentation(store, chatId, sourceId, viewport));
      } catch {
        return;
      } finally {
        precomputing = false;
        pumpPrecompute();
      }
    })()
  );
}

export function precomputePackagePresentation(
  store: Store,
  sourceId: string,
  canStart: () => boolean,
  track: (work: Promise<void>) => void
): void {
  canPrecompute = canStart;
  trackPrecompute = track;
  let chatId: string;
  try {
    chatId = store.source(sourceId).chatId;
  } catch {
    return;
  }
  if (!lastViewports.has(chatId)) return;
  for (const id of [sourceId, ...(recentSources.get(chatId) ?? [])]) {
    const key = `${chatId}\0${id}`;
    precomputeQueue.delete(key);
    precomputeQueue.set(key, { store, sourceId: id });
  }
  for (const oldest of precomputeQueue.keys()) {
    if (precomputeQueue.size <= PRECOMPUTE_QUEUE_MAX) break;
    precomputeQueue.delete(oldest);
  }
  pumpPrecompute();
}

export function clearPackagePresentationCaches() {
  presentations.clear();
  clearPackagePresentationRenderCache();
  lastViewports.clear();
  recentSources.clear();
  precomputeQueue.clear();
}

export function packagePresentationRoutes(app: FastifyInstance, store: Store) {
  app.get<{ Params: { id: string; sourceId: string }; Querystring: Record<string, unknown> }>(
    '/api/chats/:id/sources/:sourceId/presentation',
    async (request, reply) => {
      interactive++;
      try {
        return await withRisuFailureCode(async () => {
          fields(record(request.query), ['viewportWidth', 'viewportHeight']);
          const viewport = readDisplayViewport(request.query);
          const { id: chatId, sourceId } = request.params;
          const presentation = preparePresentation(store, chatId, sourceId, viewport);
          if (viewport) remember(lastViewports, chatId, viewport);
          remember(recentSources, chatId, [
            sourceId,
            ...(recentSources.get(chatId) ?? [])
              .filter((id) => id !== sourceId)
              .slice(0, RECENT_SOURCES_PER_CHAT - 1),
          ]);
          const etag = entityTag(presentation.key);
          if (matchesEntityTag(request.headers['if-none-match'], etag))
            return reply
              .code(304)
              .header('ETag', etag)
              .header('Cache-Control', 'private, no-cache')
              .send();
          const rendered = await renderPresentation(presentation);
          if (rendered.cacheable)
            reply.header('ETag', etag).header('Cache-Control', 'private, no-cache');
          return reply.type('application/json; charset=utf-8').send(rendered.body);
        });
      } finally {
        interactive--;
        pumpPrecompute();
      }
    }
  );
}
