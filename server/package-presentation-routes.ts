import { HttpError } from './request-validation.js';
import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import { successfulTranslation, validateTranslationArtifact } from './source-editing.js';
import { buildPackagePresentation } from './package-presentation.js';
import { hasSourceSegmentBoundaries } from '../core/source-segments.js';

export function packagePresentationRoutes(app: FastifyInstance, store: Store) {
  app.get<{ Params: { id: string; sourceId: string } }>(
    '/api/chats/:id/sources/:sourceId/presentation',
    async (request) => {
      store.chat(request.params.id);
      const source = store.source(request.params.sourceId);
      if (source.chatId !== request.params.id) throw new HttpError(404, 'Source not found');
      const snapshot = structuredClone(store.run(source.runId).snapshot);
      if (snapshot.chatId !== source.chatId) throw new HttpError(409, 'Source run mismatch');
      const job = successfulTranslation(store, source);
      let translation: { text: string; sourceRevision: string; sourceHash: string } | undefined;
      if (job?.status === 'completed' && job.sourceHash === source.hash) {
        validateTranslationArtifact(store, job, source);
        translation = {
          text: job.result!.text ?? '',
          sourceRevision: source.id,
          sourceHash: source.hash,
        };
      }
      const issues: string[] = [];
      if (
        snapshot.sourceSegments &&
        snapshot.profile?.packages?.some((p) => p.transforms.some((t) => t.target === 'source')) &&
        hasSourceSegmentBoundaries(
          { sourceRevision: source.id, sourceHash: source.hash, text: source.text },
          snapshot.sourceSegments
        )
      ) {
        // This source carries segment boundaries; a source transform could replace the markers the
        // reader uses for visibility. Translation transforms never touch them and stay applied.
        for (const pkg of snapshot.profile.packages)
          pkg.transforms = pkg.transforms.filter((t) => t.target !== 'source');
        issues.push(
          '이 장면의 원문에 구간 경계가 있어 원문 대상 패키지 정규식 표시는 적용하지 않았어요. 번역 대상 표시는 그대로 적용해요.'
        );
      }
      const detail = store.story.sourceDetail(source.id);
      const state =
        detail.status === 'ready' && detail.state?.sourceHash === source.hash
          ? { sourceRevision: source.id, sourceHash: source.hash, values: detail.state.values }
          : undefined;
      return {
        ...(await buildPackagePresentation(
          snapshot,
          { ...source, ...(translation ? { translation } : {}) },
          state
        )),
        translationId: translation ? job!.id : null,
        translationRevision: translation ? (job!.revision ?? 0) : null,
        issues,
      };
    }
  );
}
