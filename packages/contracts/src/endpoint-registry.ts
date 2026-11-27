import { appearanceEndpoints } from './domains/appearance/endpoints.js';
import { chatEndpoints } from './domains/chat/endpoints.js';
import { chatSettingsEndpoints } from './domains/chat-settings/endpoints.js';
import { deletionEndpoints } from './domains/deletion/endpoints.js';
import { libraryEndpoints } from './domains/library/endpoints.js';
import { personalWorkspaceEndpoints } from './domains/personal-workspace/endpoints.js';
import { promptEndpoints } from './domains/prompts/endpoints.js';
import { providerEndpoints } from './domains/providers/endpoints.js';
import { readerEndpoints } from './domains/reader/endpoints.js';
import { resourceEditorEndpoints } from './domains/resource-editors/endpoints.js';
import { selfHostEndpoints } from './domains/self-host/endpoints.js';
import { transferEndpoints } from './domains/transfer/endpoints.js';
import { translationEndpoints } from './domains/translation/endpoints.js';

export const allEndpoints = {
  appearance: appearanceEndpoints,
  chat: chatEndpoints,
  'chat-settings': chatSettingsEndpoints,
  deletion: deletionEndpoints,
  library: libraryEndpoints,
  'personal-workspace': personalWorkspaceEndpoints,
  prompts: promptEndpoints,
  providers: providerEndpoints,
  reader: readerEndpoints,
  resourceEditors: resourceEditorEndpoints,
  'self-host': selfHostEndpoints,
  transfer: transferEndpoints,
  translation: translationEndpoints,
};
