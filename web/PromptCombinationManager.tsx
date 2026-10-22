import { useI18n, translateMessage } from './i18n.js';
import { useState } from 'react';
import type { CurrentPrompt, PromptRole, SavedPromptCombination } from '../core/product.js';
import {
  combinationOwner,
  matchesPromptCombination,
  ownsPromptCombination,
  repairPromptCombinationValues,
} from '../core/prompt-combinations.js';
import { resolvePromptValues, type PromptValue } from '../core/risu-prompt.js';
import { api } from './api.js';
import { DeleteButton } from './DeleteButton.js';
import { Dialog } from './Dialog.js';
import { NoticeBanner } from './NoticeBanner.js';
import { PromptControlFields } from './PromptControlFields.js';

export function PromptCombinationManager({
  open,
  onClose,
  current,
  role,
  workspaceRevision,
  combinations,
  reload,
}: {
  open: boolean;
  onClose: () => void;
  current: CurrentPrompt;
  role: PromptRole;
  workspaceRevision: number;
  combinations: SavedPromptCombination[];
  reload?: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<{
    item: SavedPromptCombination;
    sourceRevision: number;
  } | null>(null);
  const [title, setTitle] = useState('');
  const [values, setValues] = useState<Record<string, PromptValue>>({});
  const [repaired, setRepaired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const items = combinations.filter((item) =>
    ownsPromptCombination(item, combinationOwner(current, role), role)
  );
  return (
    <Dialog
      open={open}
      title={t('prompts.uiManageCombinations')}
      onClose={() => {
        if (!busy) {
          setEditing(null);
          setError('');
          onClose();
        }
      }}
    >
      {editing ? (
        <>
          <label>
            {t('prompts.uiCombinationName')}
            <input
              aria-label={t('prompts.uiCombinationName')}
              value={title}
              disabled={busy}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          {repaired && (
            <p className="muted">
              {t('prompts.uiCompatibleValuesWerePreservedCheckTheOptionsBeforeSaving')}
            </p>
          )}
          <fieldset disabled={busy}>
            <PromptControlFields
              program={current.program}
              values={values}
              onChange={(id, value) => setValues((previous) => ({ ...previous, [id]: value }))}
            />
          </fieldset>
          <div className="form-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setEditing(null);
                setError('');
              }}
            >
              {t('prompts.uiCancel')}
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || !title.trim()}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await api(
                    `/prompt-combinations/${editing.item.id}`,
                    {
                      expectedRevision: editing.item.revision,
                      sourceRevision: editing.sourceRevision,
                      title: title.trim(),
                      values,
                    },
                    'PUT'
                  );
                  await reload?.();
                  setEditing(null);
                } catch (caught) {
                  setError((caught as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? t('prompts.uiSaving') : t('prompts.uiSaveCombination')}
            </button>
          </div>
        </>
      ) : items.length ? (
        items.map((item) => {
          const compatible = matchesPromptCombination(
            item,
            combinationOwner(current, role),
            role,
            current.program
          );
          return (
            <div key={item.id} className="prompt-combination-toolbar">
              <span>
                {item.title}
                {!compatible && <small>{t('prompts.uiUnavailable')}</small>}
              </span>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setEditing({ item, sourceRevision: current.presetRevision ?? workspaceRevision });
                  setTitle(item.title);
                  setError('');
                  const repairedValues = repairPromptCombinationValues(item, current.program);
                  setRepaired(
                    Object.entries(item.values).some(([id, value]) => repairedValues[id] !== value)
                  );
                  setValues({
                    ...resolvePromptValues(current.program, current.defaultValues ?? {}),
                    ...repairedValues,
                  });
                }}
              >
                {compatible ? t('prompts.uiEdit') : t('prompts.uiEditOptions')}
              </button>
              <DeleteButton
                path={`/prompt-combinations/${item.id}`}
                revision={item.revision}
                title={item.title}
                onDeleted={async () => {
                  await reload?.();
                }}
              />
            </div>
          );
        })
      ) : (
        <p>{t('prompts.uiNoSavedCombinations')}</p>
      )}
      {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
    </Dialog>
  );
}
