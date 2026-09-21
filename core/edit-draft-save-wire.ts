import type { DraftSaveResult, EditDraft, EditDraftModel } from './edit-drafts.js';
import type { Content, PromptPreset, PromptWorkspace } from './product.js';

/** The HTTP success contract for save and undo; the saved model crosses the wire once. */
export type DraftSaveWire = Omit<DraftSaveResult, 'draft'> & {
  draft: Omit<EditDraft, 'model' | 'baseModel'>;
};

export function encodeDraftSaveResult(result: DraftSaveResult): DraftSaveWire {
  const { model: _model, baseModel: _baseModel, ...draft } = result.draft;
  return { ...result, draft };
}

/** Build editor state from the single HTTP representation, not from historical wire formats. */
export function decodeDraftSaveResult(wire: DraftSaveWire): DraftSaveResult {
  const { draft, ...result } = wire;
  let model: EditDraftModel;
  if (draft.kind === 'prompt-workspace') {
    const workspace = result.saved as PromptWorkspace;
    model = { main: workspace.main, translation: workspace.translation };
  } else {
    const { id: _id, revision: _revision, ...editable } = result.saved as Content | PromptPreset;
    model = editable;
  }
  // Editing the current model must not mutate the saved result or the comparison baseline.
  return {
    ...result,
    draft: { ...draft, model: structuredClone(model), baseModel: structuredClone(model) },
  };
}
