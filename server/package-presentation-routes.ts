import { HttpError } from './request-validation.js';
import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import { latestTranslation, validateTranslationArtifact } from './source-editing.js';
import { buildPackagePresentation } from './package-presentation.js';

export function packagePresentationRoutes(app: FastifyInstance, store: Store) {
  app.get<{ Params: { id: string; sourceId: string } }>(
    '/api/chats/:id/sources/:sourceId/presentation',
    async (request) => {
      store.chat(request.params.id);
      const source = store.source(request.params.sourceId);
      if (source.chatId !== request.params.id) throw new HttpError(404, 'Source not found');
      const snapshot = structuredClone(store.run(source.runId).snapshot);
      if (snapshot.chatId !== source.chatId) throw new HttpError(409, 'Source run mismatch');
      const job = latestTranslation(store, source.id);
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
      if (snapshot.sourceSegments && snapshot.profile?.packages?.some((p) => p.transforms.length)) {
        // Never allow replacement of the markers that the reader uses for visibility controls.
        for (const pkg of snapshot.profile.packages) pkg.transforms = [];
        issues.push(
          '원문 구간 경계를 보존하기 위해 이 장면의 패키지 정규식 표시는 적용하지 않았어요.'
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
