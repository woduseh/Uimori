import type { IllustrationPreset, IllustrationPresetDefinition } from './illustration-presets.js';
import type { Theme, ThemeDefinition } from './themes.js';
import type { Content, PromptPreset, PromptWorkspace } from './product.js';

export type ResourceKind =
  | 'content'
  | 'prompt-preset'
  | 'prompt-workspace'
  | 'theme'
  | 'illustration-preset';
export type ContentEditModel = Omit<Content, 'id' | 'revision' | 'coverImage' | 'hasPackage'>;
export type PromptEditModel = Pick<PromptPreset, 'title' | 'role' | 'program' | 'values'>;
export type WorkspaceEditModel = Pick<PromptWorkspace, 'main' | 'translation'>;
export type ResourceModel =
  | ContentEditModel
  | PromptEditModel
  | WorkspaceEditModel
  | ThemeDefinition
  | IllustrationPresetDefinition;
export type SavedResource = Content | PromptPreset | PromptWorkspace | Theme | IllustrationPreset;
export type EditorContext = {
  kind: ResourceKind;
  targetId: string | null;
  revision: number | null;
  title: string;
  model?: ResourceModel;
};
export type ResourceSaveResult = {
  saved: SavedResource;
  created: boolean;
  creationOrganizationRevision?: number;
};
export function editableResource(kind: ResourceKind, resource: SavedResource): ResourceModel {
  if (kind === 'theme' || kind === 'illustration-preset') {
    const { id: _id, revision: _revision, ...model } = resource as Theme | IllustrationPreset;
    return model;
  }
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

export function nativeExtensionPath(segments: string[], field: string): boolean {
  return (
    segments.length === 6 &&
    segments[0] === 'package' &&
    segments[1] === 'nativeRisu' &&
    ['card', 'module'].includes(segments[2]!) &&
    segments[3] === 'extensions' &&
    segments[4] === 'uimori' &&
    segments[5] === field
  );
}
export function resourceListKind(segments: string[]): 'lore' | 'terms' | 'prompt' | null {
  if (
    segments.length === 4 &&
    segments[0] === 'program' &&
    segments[1] === 'nativeRisuPreset' &&
    segments[2] === 'preset' &&
    segments[3] === 'promptTemplate'
  )
    return 'prompt';
  if (
    segments.length === 7 &&
    nativeExtensionPath(segments.slice(0, -1), 'translationGuide') &&
    segments[6] === 'terms'
  )
    return 'terms';
  if (
    segments.length === 4 &&
    segments[0] === 'package' &&
    segments[1] === 'nativeRisu' &&
    segments[2] === 'module' &&
    segments[3] === 'lorebook'
  )
    return 'lore';
  if (
    segments.length === 5 &&
    segments[0] === 'package' &&
    segments[1] === 'nativeRisu' &&
    segments[2] === 'card' &&
    segments[3] === 'character_book' &&
    segments[4] === 'entries'
  )
    return 'lore';
  return null;
}
