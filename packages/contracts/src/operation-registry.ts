import { appearanceOperations } from './domains/appearance/operations.js';
import { deletionOperations } from './domains/deletion/operations.js';
import { libraryOperations } from './domains/library/operations.js';
import { personalWorkspaceOperations } from './domains/personal-workspace/operations.js';
import { promptOperations } from './domains/prompts/operations.js';
import { providerOperations } from './domains/providers/operations.js';
import { resourceEditorOperations } from './domains/resource-editors/operations.js';
import { selfHostOperations } from './domains/self-host/operations.js';
import { translationOperations } from './domains/translation/operations.js';

export const allOperations = {
  appearance: appearanceOperations,
  deletion: deletionOperations,
  library: libraryOperations,
  'personal-workspace': personalWorkspaceOperations,
  prompts: promptOperations,
  providers: providerOperations,
  resourceEditors: resourceEditorOperations,
  'self-host': selfHostOperations,
  translation: translationOperations,
};
