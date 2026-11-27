import type { RisuImportFinding, RisuImportFindingCode } from '../core/risu-import.js';
import type { RisuPresetFinding, RisuPresetFindingCode } from '../core/risu-preset.js';
import type { MessageKey } from './locales/index.js';
import { uiMessage, type UiMessage } from './ui-message.js';

export const IMPORT_FINDING_MESSAGES = {
  'asset-unavailable': 'transfer.finding.asset-unavailable',
  'asset-invalid': 'transfer.finding.asset-invalid',
  'asset-format': 'transfer.finding.asset-format',
  'asset-role': 'transfer.finding.asset-role',
  'creator-notes-truncated': 'transfer.finding.creator-notes-truncated',
  'disabled-lore': 'transfer.finding.disabled-lore',
  'lore-not-activated': 'transfer.finding.lore-not-activated',
  'lore-inline-directive': 'transfer.finding.lore-decorator-position',
  'lore-decorator-placement': 'transfer.finding.decoratorPosition',
  'lore-decorator-activation': 'transfer.finding.decoratorActivation',
  'lore-decorator-unknown': 'transfer.finding.decoratorUnknown',
  'native-model-calls': 'transfer.finding.native-model-calls',
  'native-variable-projection': 'transfer.finding.native-variable-projection',
} satisfies Record<RisuImportFindingCode, MessageKey>;

export function importFindingMessage(finding: RisuImportFinding): UiMessage {
  return uiMessage(IMPORT_FINDING_MESSAGES[finding.code], finding.params);
}

export const PRESET_FINDING_MESSAGES = {
  RISU_PRESET_UNSUPPORTED_BLOCK: 'transfer.finding.unsupportedBlock',
  RISU_PRESET_HOST_SETTING: 'transfer.finding.hostSetting',
  RISU_PRESET_HOST_MEMORY: 'transfer.finding.RISU_PRESET_HOST_MEMORY',
} satisfies Record<RisuPresetFindingCode, MessageKey>;

export function presetFindingMessage(finding: RisuPresetFinding): UiMessage {
  return uiMessage(PRESET_FINDING_MESSAGES[finding.code], finding.params);
}
