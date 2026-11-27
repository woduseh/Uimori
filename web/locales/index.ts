import { messages as common } from './common.js';
import { messages as errors } from './errors.js';
import { messages as outside } from './outside.js';
import { messages as reader } from './reader.js';
import { messages as helpers } from './helpers.js';
import { messages as helperworkspace } from './helperworkspace.js';
import { messages as helperNavigation } from './helper-navigation.js';
import { messages as helperConversationPolish } from './helperconversation-polish.js';
import { messages as workspace } from './workspace.js';
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
import { messages as helperattachments } from './helperattachments.js';
import { messages as storyUi } from './story-ui.js';
import { messages as themeAssets } from './theme-assets.js';
import { messages as shortcuts } from './shortcuts.js';
import { messages as helperRollback } from './helper-rollback.js';
import { messages as helperPlan } from './helper-plan.js';
import { messages as helperConfirmations } from './helper-confirmations.js';
import { messages as readerSelection } from './reader-selection.js';
import { messages as cbsReferences } from './cbs-references.js';
import { messages as draftPreview } from './draft-preview.js';
import { messages as taskTrace } from './task-trace.js';
import { messages as editorHelper } from './editor-helper.js';
import type { UiLocale } from '../../core/ui-locale.js';
const entries = {
  ...common,
  ...errors,
  ...outside,
  ...reader,
  ...helpers,
  ...helperworkspace,
  ...helperNavigation,
  ...helperConversationPolish,
  ...workspace,
  ...providers,
  ...library,
  ...settings,
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
  ...helperattachments,
  ...storyUi,
  ...themeAssets,
  ...shortcuts,
  ...helperRollback,
  ...helperPlan,
  ...helperConfirmations,
  ...readerSelection,
  ...cbsReferences,
  ...draftPreview,
  ...taskTrace,
  ...editorHelper,
} satisfies Record<string, Record<UiLocale, string>>;
export type MessageKey = keyof typeof entries;
export const messages: Record<string, Record<UiLocale, string>> = entries;
export const catalog = (locale: UiLocale): Record<string, string> =>
  Object.fromEntries(Object.entries(messages).map(([key, entry]) => [key, entry[locale]]));
