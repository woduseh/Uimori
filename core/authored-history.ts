import type { RunSnapshot } from './types.js';

/** No model request existed for this imported source. Its parent link owns ancestry. */
export function isSourceOnlyTranscript(snapshot: RunSnapshot): boolean {
  return snapshot.transcriptImport?.storage === 'source-only-v1';
}

export function validateSourceOnlyTranscript(snapshot: RunSnapshot): void {
  if (!isSourceOnlyTranscript(snapshot)) return;
  if (
    !Number.isSafeInteger(snapshot.transcriptImport?.index) ||
    snapshot.transcriptImport!.index < 0 ||
    !Array.isArray(snapshot.history) ||
    snapshot.history.length !== 0 ||
    Object.keys(snapshot).some(
      (key) =>
        ![
          'chatId',
          'parentRevision',
          'settingsRevision',
          'settings',
          'request',
          'history',
          'resources',
          'profile',
          'sourceSegments',
          'branchId',
          'executionClock',
          'transcriptImport',
          'forkedFrom',
        ].includes(key)
    )
  )
    throw new Error('CHAT_TRANSCRIPT_INVALID_SOURCE_SNAPSHOT');
}
