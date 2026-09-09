import type { Content, PromptPreset, PromptWorkspace } from './product.js';

export type EditDraftKind = 'content' | 'prompt-preset' | 'prompt-workspace';
export type ContentDraftModel = Omit<Content, 'id' | 'revision' | 'coverImage' | 'hasPackage'>;
export type PromptDraftModel = Pick<PromptPreset, 'title' | 'role' | 'program' | 'values'>;
export type WorkspaceDraftModel = Pick<PromptWorkspace, 'main' | 'translation'>;
export type EditDraftModel = ContentDraftModel | PromptDraftModel | WorkspaceDraftModel;
export type EditDraft = {
  id: string;
  revision: number;
  editorKey: string;
  kind: EditDraftKind;
  targetId: string | null;
  baseRevision: number | null;
  baseHash: string;
  baseModel: EditDraftModel;
  model: EditDraftModel;
  /** Exact editor buffers; they may contain incomplete JSON or authoring syntax. */
  rawFields: Record<string, string>;
  unappliedFields: string[];
  status: 'active' | 'discarded';
  createdAt: string;
  updatedAt: string;
};
export type DraftProposal = {
  id: string;
  draftId: string;
  expectedRevision: number;
  actualRevision: number;
  model: EditDraftModel;
  rawFields: Record<string, string>;
  unappliedFields: string[];
  createdAt: string;
};
export type DraftPatchResult =
  | { status: 'applied'; draft: EditDraft }
  | { status: 'conflict'; draft: EditDraft; proposal: DraftProposal };
export type DraftValidation = { valid: boolean; errors: string[] };
export type DraftChange = { path: string; before: unknown; after: unknown };
export type DraftImpact = {
  targetId: string | null;
  scope: 'new-item' | 'shared-content' | 'saved-preset' | 'all-chats';
  contents: { id: string; title: string; indirect: boolean }[];
  chats: { id: string; title: string; roles: string[] }[];
  applies: 'next-request';
};
export type DraftSaveResult = {
  status: 'saved';
  draft: EditDraft;
  saved: Content | PromptPreset | PromptWorkspace;
  operationId: string;
  created: boolean;
  changes: DraftChange[];
};
export type DraftSavedOperation = {
  operationId: string;
  createdAt: string;
  savedRevision: number;
  created: boolean;
  changes: DraftChange[];
  undoChanges: DraftChange[];
};
