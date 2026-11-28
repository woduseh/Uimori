import { applyRisuCommand } from './risu-import.js';
import { applyRisuPresetCommand } from './risu-preset-import.js';
import { updateChatVariablesCommand } from './chat-variables.js';
import { updateStoryGuideCommand } from './story-guide.js';

export {
  applyRisuCommand,
  applyRisuPresetCommand,
  updateChatVariablesCommand,
  updateStoryGuideCommand,
};

export const allCommands = {
  'risu.import.apply': applyRisuCommand,
  'risuPreset.import.apply': applyRisuPresetCommand,
  'chat-settings.writeVariables': updateChatVariablesCommand,
  'chat-settings.updateStoryGuide': updateStoryGuideCommand,
} as const;
