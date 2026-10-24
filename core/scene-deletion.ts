export type SceneDeletionImpact = {
  sourceId: string;
  onlyCount: number;
  followingCount: number;
  orphanNoteCount: { only: number; following: number };
  request: {
    expectedHeadRevision: string | null;
    expectedSettingsRevision: number;
    expectedSourceHash: string;
    expectedHistoryHash: string;
    expectedVariablesRevision: number;
  };
};
export type SceneDeletionResult = {
  deleted: true;
  chatId: string;
  sourceIds: string[];
  headRevision: string | null;
  settingsRevision: number;
};
