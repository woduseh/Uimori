import type { RunSnapshot } from '../core/types.js';
import type { Store } from './store.js';

/** Completed messages retain identity and display metadata, not a replay of every past prompt/body. */
export function settleSnapshot(snapshot: RunSnapshot): RunSnapshot {
  const profile = snapshot.profile;
  return {
    settled: true,
    mainJudgmentEnabled: snapshot.mainJudgmentEnabled,
    mainJudgmentThreshold: snapshot.mainJudgmentThreshold,
    displayModelTitle: snapshot.profile?.models.main?.title ?? snapshot.displayModelTitle,
    chatId: snapshot.chatId,
    branchId: snapshot.branchId,
    parentRevision: snapshot.parentRevision,
    request: snapshot.request,
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

/** An explicit full-context read reconstructs user data from messages and today's library. */
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
