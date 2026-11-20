import type { RunSnapshot } from '../core/types.js';
import type { Store } from './store.js';

export function settleSnapshot(snapshot: RunSnapshot): RunSnapshot {
  const profile = snapshot.profile;
  return {
    settled: true,
    mainJudgmentEnabled: snapshot.mainJudgmentEnabled,
    mainJudgmentThreshold: snapshot.mainJudgmentThreshold,
    displayModelTitle: snapshot.profile?.models.main?.title ?? snapshot.displayModelTitle,
    ...(snapshot.storyGuide?.config.enabled
      ? {
          storyGuideReceipt: {
            ...(snapshot.storyGuide.brief ? { brief: snapshot.storyGuide.brief } : {}),
            ...(snapshot.storyGuide.error ? { error: snapshot.storyGuide.error } : {}),
          },
        }
      : snapshot.storyGuideReceipt
        ? { storyGuideReceipt: snapshot.storyGuideReceipt }
        : {}),
    chatId: snapshot.chatId,
    parentRevision: snapshot.parentRevision,
    ...(snapshot.replacement ? { replacement: snapshot.replacement } : {}),
    request: snapshot.request,
    ...(snapshot.storyUiAction ? { storyUiAction: snapshot.storyUiAction } : {}),
    ...(snapshot.requestImages?.length ? { requestImages: snapshot.requestImages } : {}),
    settingsRevision: snapshot.settingsRevision,
    settings: snapshot.settings,
    history: [],
    resources: [],
    ...(snapshot.executionClock ? { executionClock: snapshot.executionClock } : {}),
    ...(snapshot.transcriptImport ? { transcriptImport: snapshot.transcriptImport } : {}),
    ...(snapshot.packageStart ? { packageStart: snapshot.packageStart } : {}),
    ...(snapshot.nativeRisuAuthored ? { nativeRisuAuthored: snapshot.nativeRisuAuthored } : {}),
    ...(profile
      ? {
          profile: {
            chatId: profile.chatId,
            revision: profile.revision,
            routes: profile.routes,
            image: profile.image,
            imageTranslation: profile.imageTranslation,
            pinned: profile.pinned,
            packageAttachments: profile.packageAttachments,
            loreContext: profile.loreContext,
            models: {},
          },
        }
      : {}),
  };
}

export function releaseEndedSnapshot(snapshot: RunSnapshot): RunSnapshot {
  return {
    ...settleSnapshot(snapshot),
    ...(snapshot.history.length
      ? { capturedSources: snapshot.history.map((source) => source.revision) }
      : {}),
    ...(snapshot.mainJudgment ? { mainJudgment: snapshot.mainJudgment } : {}),
    ...(snapshot.contextBase ? { contextBase: snapshot.contextBase } : {}),
    ...(snapshot.contextPlan ? { contextPlan: snapshot.contextPlan } : {}),
    ...(snapshot.loreContextReset ? { loreContextReset: true } : {}),
    ...(snapshot.invalidatedBySceneDeletion ? { invalidatedBySceneDeletion: true } : {}),
  };
}

export function executionSnapshot(store: Store, snapshot: RunSnapshot): RunSnapshot {
  if (!snapshot.settled) return snapshot;
  const { settled: _settled, ...saved } = snapshot;
  const profile = store.product.snapshot(snapshot.chatId, 'inspect', snapshot.parentRevision);
  const restored = {
    ...saved,
    profile,
    history: store.history(snapshot.parentRevision),
    resources: store.product.resources(snapshot.chatId, profile),
  };
  const story = store.story.prepare(restored);
  return story ? { ...restored, story } : restored;
}
