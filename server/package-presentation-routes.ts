import { fields, HttpError, record } from './request-validation.js';
import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import { successfulTranslation, validateTranslationArtifact } from './translation-artifacts.js';
import { buildPackagePresentation } from './package-presentation.js';
import { nativeSourceSnapshot } from './risu-native-actions.js';
import { nativeImageDisplayText } from './risu-native-images.js';
import { readStoredRunSnapshot } from './run-projections.js';
import { executionSnapshot } from './execution-snapshot.js';
import { readDisplayViewport } from './display-viewport.js';

export function packagePresentationRoutes(app: FastifyInstance, store: Store) {
  app.get<{ Params: { id: string; sourceId: string }; Querystring: Record<string, unknown> }>(
    '/api/chats/:id/sources/:sourceId/presentation',
    async (request) => {
      fields(record(request.query), ['viewportWidth', 'viewportHeight']);
      const viewport = readDisplayViewport(request.query);
      store.chat(request.params.id);
      const source = store.source(request.params.sourceId);
      if (source.chatId !== request.params.id) throw new HttpError(404, 'Source not found');
      const stored = readStoredRunSnapshot(store, source.runId);
      // Settled runs need today's package/profile projection for display, but not a restored
      // model context. Native display constructs the live history below; preparing the old
      // history, resources and story here would immediately discard that work.
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
      if (snapshot.profile?.packages?.some((pkg) => pkg.nativeRisu)) {
        const live = nativeSourceSnapshot(store, source.chatId, source.id, snapshot);
        const own = snapshot;
        const first = own.packageStart?.mode === 'authored' || own.nativeRisuAuthored?.greeting;
        const messages = first
          ? [{ text: source.text, index: -1, role: 'assistant' as const, primary: true }]
          : (live.snapshot.logicalHistory ?? [])
              .filter((entry) => entry.sourceKind !== 'authored-start')
              .map((entry, index) => ({ ...entry, index }))
              .filter(
                (entry) =>
                  entry.sourceRevision === source.id &&
                  // The reader already displays the original request, including authored groups.
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
            nativeMessages: messages,
            ...(imageTranslation ? { nativeTranslationText: imageTranslation.text } : {}),
          }
        );
        const head = live.snapshot.parentRevision!;
        return {
          ...presentation,
          issues: [
            ...presentation.issues,
            ...imageView.issues,
            ...(imageTranslation?.issues ?? []),
          ],
          translationId: translation ? job!.id : null,
          translationRevision: translation ? (job!.revision ?? 0) : null,
          nativeAction: {
            expectedHeadRevision: head,
            expectedHeadHash: store.source(head).hash,
            expectedVariableRevision: live.variables.revision,
          },
        };
      }
      // Preserve the fallback's full context, including preset-only native rendering.
      const presentation = await buildPackagePresentation(executionSnapshot(store, stored), {
        ...source,
        ...(translation ? { translation } : {}),
      });
      return {
        ...presentation,
        translationId: translation ? job!.id : null,
        translationRevision: translation ? (job!.revision ?? 0) : null,
      };
    }
  );
}
