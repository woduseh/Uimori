import { updateChatVariablesCommand } from './chat-variables.js';
import { updateStoryGuideCommand } from './story-guide.js';

export { updateChatVariablesCommand, updateStoryGuideCommand };

export const allCommands = {
  'chat-settings.writeVariables': updateChatVariablesCommand,
  'chat-settings.updateStoryGuide': updateStoryGuideCommand,
} as const;
