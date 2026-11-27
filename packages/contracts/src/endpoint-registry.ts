import { appearanceEndpoints } from './domains/appearance/endpoints.js';
import { deletionEndpoints } from './domains/deletion/endpoints.js';
import { libraryEndpoints } from './domains/library/endpoints.js';
import { personalWorkspaceEndpoints } from './domains/personal-workspace/endpoints.js';
import { promptEndpoints } from './domains/prompts/endpoints.js';
import { resourceEditorEndpoints } from './domains/resource-editors/endpoints.js';
import { selfHostEndpoints } from './domains/self-host/endpoints.js';
import { translationEndpoints } from './domains/translation/endpoints.js';

export const allEndpoints = {
  appearance: appearanceEndpoints,
  deletion: deletionEndpoints,
  library: libraryEndpoints,
  'personal-workspace': personalWorkspaceEndpoints,
  prompts: promptEndpoints,
  resourceEditors: resourceEditorEndpoints,
  'self-host': selfHostEndpoints,
  translation: translationEndpoints,
};
