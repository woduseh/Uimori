import type { Content, PromptPreset, PromptWorkspace } from './product.js';

export type ResourceKind = 'content' | 'prompt-preset' | 'prompt-workspace';
export type ContentEditModel = Omit<Content, 'id' | 'revision' | 'coverImage' | 'hasPackage'>;
export type PromptEditModel = Pick<PromptPreset, 'title' | 'role' | 'program' | 'values'>;
export type WorkspaceEditModel = Pick<PromptWorkspace, 'main' | 'translation'>;
export type ResourceModel = ContentEditModel | PromptEditModel | WorkspaceEditModel;
export type SavedResource = Content | PromptPreset | PromptWorkspace;
export type EditorContext = {
  kind: ResourceKind;
  targetId: string | null;
  revision: number | null;
  title: string;
  /** Optional current device input, not a persistent server draft. */
  model?: ResourceModel;
};
export type ResourceSaveResult = { saved: SavedResource; created: boolean };
export function editableResource(kind: ResourceKind, resource: SavedResource): ResourceModel {
  if (kind === 'prompt-workspace') {
    const workspace = resource as PromptWorkspace;
    return { main: workspace.main, translation: workspace.translation };
  }
  if (kind === 'content') {
    const {
      id: _id,
      revision: _revision,
      coverImage: _cover,
      hasPackage: _has,
      ...model
    } = resource as Content;
    return model;
  }
  const { id: _id, revision: _revision, ...model } = resource as PromptPreset;
  return model;
}
