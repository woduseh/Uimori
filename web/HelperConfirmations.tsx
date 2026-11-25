import { useState } from 'react';
import { Check, ShieldAlert, X } from 'lucide-react';
import { HELPER_DECLINED_CALLS_LIMIT, type HelperConfirmation } from '../core/helper.js';
import { t } from './i18n.js';
import { readOptionalStorage } from './optional-storage.js';
import { localKeysStartingWith, storageKeys, writeRecentStorage } from './storage-keys.js';

export type HelperConfirmationTarget = HelperConfirmation['targets'][number];
export type HelperConfirmationGrant = { id: string; operation: string; text: string };

export const HELPER_CONFIRMATION_OPERATION_LABELS: Record<string, string> = {
  'resource.delete': 'helperConfirm.resourceDelete',
  'resource.patchMany': 'helperConfirm.resourcePatchMany',
  'scene.request': 'helperConfirm.sceneRequest',
  'scene.translate': 'helperConfirm.sceneTranslate',
  'illustration.cut.delete': 'helperConfirm.illustrationCutDelete',
  'font.delete': 'helperConfirm.fontDelete',
  'palette.delete': 'helperConfirm.paletteDelete',
  'model.delete': 'helperConfirm.modelDelete',
  'chat.delete': 'helperConfirm.chatDelete',
  'prompt.combination.delete': 'helperConfirm.promptCombinationDelete',
  'chat.lore': 'helperConfirm.chatLoreRemove',
  'illustration.generate': 'helperConfirm.illustrationGenerate',
  'illustration.cut.redraw': 'helperConfirm.illustrationRedraw',
  'illustration.cut.revise': 'helperConfirm.illustrationRevise',
  'task.retry': 'helperConfirm.taskRetry',
};
const reasons: Partial<Record<HelperConfirmation['reason'], string>> = {
  delete: 'helperConfirm.reasonDelete',
  paid: 'helperConfirm.reasonPaid',
};
const declinedKey = ({ taskId, id }: Pick<HelperConfirmation, 'taskId' | 'id'>) =>
  storageKeys.helperConfirmationDeclined(taskId, id);

export function declinedHelperConfirmations(taskId: string): string[] {
  const prefix = storageKeys.helperConfirmationDeclined(taskId, '');
  return localKeysStartingWith(prefix)
    .map((key) => key.slice(prefix.length))
    .filter(Boolean)
    .slice(0, HELPER_DECLINED_CALLS_LIMIT);
}

export const confirmationOperation = (confirmation: Pick<HelperConfirmation, 'operation'>) =>
  HELPER_CONFIRMATION_OPERATION_LABELS[confirmation.operation]
    ? t(HELPER_CONFIRMATION_OPERATION_LABELS[confirmation.operation]!)
    : confirmation.operation;

export function HelperConfirmations({
  confirmations,
  nameTarget,
  pending,
  onConfirm,
}: {
  confirmations: readonly HelperConfirmation[];
  nameTarget: (target: HelperConfirmationTarget) => string;
  pending: readonly string[];
  onConfirm?: (grant: HelperConfirmationGrant) => void;
}) {
  const [declined, setDeclined] = useState<readonly string[]>([]);
  const shown = confirmations.filter(
    (confirmation) =>
      !declined.includes(declinedKey(confirmation)) &&
      !(confirmation.grantable && readOptionalStorage('local', declinedKey(confirmation)))
  );
  if (!shown.length) return null;
  return (
    <ul className="helper-confirmations" aria-label={t('helperConfirm.title')}>
      {shown.map((confirmation) => {
        const operation = confirmationOperation(confirmation);
        const targets = [
          ...confirmation.targets.map((target) => target.title ?? nameTarget(target)),
          ...(confirmation.count === undefined
            ? []
            : [t('helperConfirm.pictures', { count: confirmation.count })]),
        ];
        const waiting = pending.includes(confirmation.id);
        const open = confirmation.grantable && !confirmation.grantedBy && !waiting;
        const reason = reasons[confirmation.reason];
        const note = confirmation.grantedBy
          ? t('helperConfirm.granted')
          : waiting
            ? t('helperConfirm.pending')
            : confirmation.grantable
              ? reason && t(reason)
              : t('helperConfirm.expired');
        return (
          <li
            key={confirmation.id}
            className="helper-confirmation"
            data-state={
              confirmation.grantedBy
                ? 'granted'
                : waiting
                  ? 'pending'
                  : confirmation.grantable
                    ? 'open'
                    : 'expired'
            }
          >
            <p className="helper-confirmation-title">
              <ShieldAlert size={16} aria-hidden="true" />
              <strong>{operation}</strong>
            </p>
            {targets.length > 0 && (
              <ul className="helper-confirmation-targets">
                {targets.map((name, index) => {
                  const target = confirmation.targets[index];
                  return (
                    <li key={target ? `${target.kind}:${target.id}` : `count:${index}`}>{name}</li>
                  );
                })}
              </ul>
            )}
            {note && <p className="helper-result-note">{note}</p>}
            {open && onConfirm && (
              <div className="helper-confirmation-actions">
                <button
                  type="button"
                  className="secondary"
                  aria-label={t('helperConfirm.declineLabel', { operation })}
                  onClick={() => {
                    writeRecentStorage(declinedKey(confirmation), '1');
                    setDeclined((old) => [...old, declinedKey(confirmation)]);
                  }}
                >
                  <X size={16} aria-hidden="true" />
                  {t('helperConfirm.decline')}
                </button>
                <button
                  type="button"
                  className="primary"
                  aria-label={t('helperConfirm.confirmLabel', { operation })}
                  onClick={() =>
                    onConfirm({
                      id: confirmation.id,
                      operation,
                      text: t('helperConfirm.request', {
                        operation,
                        targets: targets.join(', ') || operation,
                      }),
                    })
                  }
                >
                  <Check size={16} aria-hidden="true" />
                  {t('helperConfirm.confirm')}
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
