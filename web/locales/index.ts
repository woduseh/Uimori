import { messages as common } from './common.js';
import { messages as errors } from './errors.js';
import { messages as outside } from './outside.js';
import { messages as reader } from './reader.js';
import { messages as helpers } from './helpers.js';
import { messages as providers } from './providers.js';
import { messages as library } from './library.js';
import { messages as settings } from './settings.js';
import { messages as native } from './native.js';
import { messages as transfer } from './transfer.js';
import { messages as prompts } from './prompts.js';
import { messages as visuals } from './visuals.js';
import { messages as chatsettings } from './chatsettings.js';
import { messages as visualpanels } from './visualpanels.js';
import { messages as shared } from './shared.js';
import { messages as main } from './main.js';
import { messages as fonts } from './fonts.js';
import { messages as palettes } from './palettes.js';
import { messages as recent } from './recent.js';
import { messages as chatmanagement } from './chatmanagement.js';
import { messages as orphanmemory } from './orphanmemory.js';
import { messages as settingssummary } from './settingssummary.js';
export const messages: Record<string, { ko: string; en: string; ja: string; zh: string }> = {
  ...common,
  ...errors,
  ...outside,
  ...reader,
  ...helpers,
  ...providers,
  ...library,
  ...settings,
  ...settingssummary,
  ...native,
  ...transfer,
  ...prompts,
  ...visuals,
  ...chatsettings,
  ...visualpanels,
  ...shared,
  ...main,
  ...fonts,
  ...palettes,
  ...recent,
  ...chatmanagement,
  ...orphanmemory,
};
