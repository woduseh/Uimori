import { HttpError } from './request-validation.js';
import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import { successfulTranslation, validateTranslationArtifact } from './source-editing.js';
import { buildPackagePresentation } from './package-presentation.js';
import { hasSourceSegmentBoundaries } from '../core/source-segments.js';
import { preparedBehaviorSnapshot } from './package-behavior-run.js';
import { projectAfterResponseDisplayEdit } from './package-after-response.js';
import { nativeSourceSnapshot } from './risu-native-actions.js';
import { nativeImageDisplayText } from './risu-native-images.js';

export function packagePresentationRoutes(app: FastifyInstance, store: Store) {
  app.get<{ Params: { id: string; sourceId: string }; Querystring: { branchId?: string } }>(
    '/api/chats/:id/sources/:sourceId/presentation',
    async (request) => {
      store.chat(request.params.id);
      const source = store.source(request.params.sourceId);
      if (source.chatId !== request.params.id) throw new HttpError(404, 'Source not found');
      // Read the same execution projection the model input used, so the reader compares the
      // stored request with the text actually sent instead of the reserved copy.
      const snapshot = structuredClone(
        preparedBehaviorSnapshot(store, source.runId, store.run(source.runId).snapshot)
      );
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
      if (snapshot.profile?.packages?.some((pkg) => pkg.nativeRisu)) {
        const live = nativeSourceSnapshot(store, source.chatId, source.id, request.query.branchId);
        const own = store.run(source.runId).snapshot;
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
            ? await nativeImageDisplayText(store, live.snapshot, source.id)
            : { text: primary?.text ?? '', issues: [] };
        if (primary) primary.text = imageView.text;
        const imageTranslation = translation
          ? await nativeImageDisplayText(store, live.snapshot, source.id, 'translation')
          : undefined;
        const presentation = await buildPackagePresentation(
          live.snapshot,
          { ...source, ...(translation ? { translation } : {}) },
          undefined,
          {
            nativeMessages: messages,
            ...(imageTranslation?.text ? { nativeTranslationText: imageTranslation.text } : {}),
          }
        );
        const head = live.branch.headRevision!;
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
            branchId: live.branch.id,
            expectedHeadRevision: head,
            expectedHeadHash: store.source(head).hash,
            expectedVariableRevision: live.variables.revision,
          },
        };
      }
      const issues: string[] = [];
      let skipSourceTransforms = false;
      if (
        snapshot.sourceSegments &&
        (snapshot.profile?.packages?.some((p) => p.transforms.some((t) => t.target === 'source')) ||
          snapshot.profile?.promptPresets?.main?.program.transforms?.some(
            (t) => t.enabled !== false && t.stage === 'display' && t.role !== 'user'
          )) &&
        hasSourceSegmentBoundaries(
          { sourceRevision: source.id, sourceHash: source.hash, text: source.text },
          snapshot.sourceSegments
        )
      ) {
        // This source carries segment boundaries; a source transform could replace the markers the
        // reader uses for visibility. Translation transforms never touch them and stay applied.
        skipSourceTransforms = true;
        for (const pkg of snapshot.profile?.packages ?? [])
          pkg.transforms = pkg.transforms.filter((t) => t.target !== 'source');
        issues.push(
          '이 장면의 원문에 구간 경계가 있어 원문 대상 정규식 표시는 적용하지 않았어요. 요청과 번역 대상 표시는 그대로 적용해요.'
        );
      }
      const detail = store.story.sourceDetail(source.id);
      const state =
        detail.status === 'ready' && detail.state?.sourceHash === source.hash
          ? { sourceRevision: source.id, sourceHash: source.hash, values: detail.state.values }
          : undefined;
      const displayEdit = projectAfterResponseDisplayEdit(store, source.runId, source.hash);
      if (displayEdit && skipSourceTransforms)
        issues.push(
          '이 장면의 원문에 구간 경계가 있어 가져온 자료의 표시 편집도 적용하지 않았어요.'
        );
      const presentation = await buildPackagePresentation(
        snapshot,
        { ...source, ...(translation ? { translation } : {}) },
        state,
        { skipSourceTransforms, ...(displayEdit ? { displayEdit } : {}) }
      );
      return {
        ...presentation,
        translationId: translation ? job!.id : null,
        translationRevision: translation ? (job!.revision ?? 0) : null,
        issues: [...issues, ...presentation.issues],
      };
    }
  );
}
