import { applyRisuCommand } from './risu-import.js';
import { applyRisuPresetCommand } from './risu-preset-import.js';
import { updateChatVariablesCommand } from './chat-variables.js';
import { applyOutlineCommand, setOutlineFocusCommand } from './outline.js';
import { updateStoryGuideCommand } from './story-guide.js';

export {
  applyRisuCommand,
  applyRisuPresetCommand,
  applyOutlineCommand,
  setOutlineFocusCommand,
  updateChatVariablesCommand,
  updateStoryGuideCommand,
};

export const allCommands = {
  'risu.import.apply': applyRisuCommand,
  'risuPreset.import.apply': applyRisuPresetCommand,
  'chat-settings.writeVariables': updateChatVariablesCommand,
  'chat-settings.updateStoryGuide': updateStoryGuideCommand,
  'outline.setFocus': setOutlineFocusCommand,
  'outline.apply': applyOutlineCommand,
} as const;
