import { useState } from 'react';
import { Check, ShieldAlert, X } from 'lucide-react';
import type { HelperConfirmation } from '../core/helper.js';
import { t } from './i18n.js';
import { readOptionalStorage, writeOptionalStorage } from './optional-storage.js';

export type HelperConfirmationTarget = HelperConfirmation['targets'][number];
export type HelperConfirmationGrant = { id: string; operation: string; text: string };

const operations: Record<string, string> = {
  'resource.delete': 'helperConfirm.resourceDelete',
  'resource.patchMany': 'helperConfirm.resourcePatchMany',
  'scene.request': 'helperConfirm.sceneRequest',
  'scene.translate': 'helperConfirm.sceneTranslate',
};
const reasons: Record<HelperConfirmation['reason'], string> = {
  delete: 'helperConfirm.reasonDelete',
  bulk: 'helperConfirm.reasonBulk',
  paid: 'helperConfirm.reasonPaid',
};
const declinedKey = ({ taskId, id }: Pick<HelperConfirmation, 'taskId' | 'id'>) =>
  `uimori:helper-confirmation-declined:${taskId}:${id}`;

export const confirmationOperation = (confirmation: Pick<HelperConfirmation, 'operation'>) =>
  operations[confirmation.operation]
    ? t(operations[confirmation.operation]!)
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
        const targets = confirmation.targets.map(nameTarget);
        const waiting = pending.includes(confirmation.id);
        const open = confirmation.grantable && !confirmation.grantedBy && !waiting;
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
                {targets.map((name, index) => (
                  <li
                    key={`${confirmation.targets[index]!.kind}:${confirmation.targets[index]!.id}`}
                  >
                    {name}
                  </li>
                ))}
              </ul>
            )}
            <p className="helper-result-note">
              {confirmation.grantedBy
                ? t('helperConfirm.granted')
                : waiting
                  ? t('helperConfirm.pending')
                  : confirmation.grantable
                    ? t(reasons[confirmation.reason])
                    : t('helperConfirm.expired')}
            </p>
            {open && onConfirm && (
              <div className="helper-confirmation-actions">
                <button
                  type="button"
                  className="secondary"
                  aria-label={t('helperConfirm.declineLabel', { operation })}
                  onClick={() => {
                    writeOptionalStorage('local', declinedKey(confirmation), '1');
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
