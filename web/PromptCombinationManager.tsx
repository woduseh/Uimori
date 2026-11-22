import { useI18n, translateMessage } from './i18n.js';
import { useEffect, useRef, useState } from 'react';
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
import { SettingsDetail } from './SettingsDetail.js';
import { NoticeBanner } from './NoticeBanner.js';
import { SaveButton } from './SaveButton.js';
import { PromptControlFields } from './PromptControlFields.js';
import { Dialog } from './Dialog.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';

export function CombinationLeaveDialog({
  proceed,
  onContinue,
}: {
  proceed: (() => void) | null;
  onContinue: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      open={!!proceed}
      title={t('prompts.combinationLeaveTitle')}
      variant="confirmation"
      role="alertdialog"
      onClose={onContinue}
    >
      <p>{t('prompts.combinationLeaveMessage')}</p>
      <DraftDiscardActions
        open={!!proceed}
        onContinue={onContinue}
        onDiscard={() => {
          onContinue();
          proceed?.();
        }}
        discardLabel={t('prompts.combinationLeaveDiscard')}
      />
    </Dialog>
  );
}

export function PromptCombinationManager({
  open,
  sectionLabel,
  returnFocus,
  onClose,
  current,
  role,
  workspaceRevision,
  combinations,
  reload,
  onDirtyChange,
}: {
  open: boolean;
  sectionLabel: string;
  returnFocus: () => HTMLElement | null | undefined;
  onClose: () => void;
  current: CurrentPrompt;
  role: PromptRole;
  workspaceRevision: number;
  combinations: SavedPromptCombination[];
  reload?: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
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
  const [opened, setOpened] = useState({ title: '', values: '' });
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const changed = !!editing && (title !== opened.title || JSON.stringify(values) !== opened.values);
  useEffect(() => {
    onDirtyChange?.(changed);
  }, [changed, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const closeEditor = () => {
    setEditing(null);
    setError('');
  };
  const guard = (proceed: () => void) => {
    if (changed) setLeave(() => proceed);
    else proceed();
  };
  const list = useRef<HTMLDivElement>(null);
  const items = combinations.filter((item) =>
    ownsPromptCombination(item, combinationOwner(current, role), role)
  );
  return (
    <SettingsDetail
      open={open}
      location={[sectionLabel, t('prompts.uiManageCombinations')]}
      backDisabled={busy}
      returnFocus={returnFocus}
      onBack={() =>
        guard(() => {
          closeEditor();
          onClose();
        })
      }
    >
      <SettingsDetail
        open={!!editing}
        location={[sectionLabel, t('prompts.uiManageCombinations'), editing?.item.title ?? '']}
        backDisabled={busy}
        onBack={() => guard(closeEditor)}
      >
        {editing && (
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
              <button type="button" className="secondary" disabled={busy} onClick={closeEditor}>
                {t('prompts.uiCancel')}
              </button>
              <SaveButton
                type="button"
                className="primary"
                label={t('prompts.uiSaveCombination')}
                aria-busy={busy}
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
              />
            </div>
          </>
        )}
      </SettingsDetail>
      <div className="prompt-combination-list" ref={list} hidden={!!editing}>
        {items.length ? (
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
                    setEditing({
                      item,
                      sourceRevision: current.presetRevision ?? workspaceRevision,
                    });
                    setTitle(item.title);
                    setError('');
                    const repairedValues = repairPromptCombinationValues(item, current.program);
                    setRepaired(
                      Object.entries(item.values).some(
                        ([id, value]) => repairedValues[id] !== value
                      )
                    );
                    const initialValues = {
                      ...resolvePromptValues(current.program, current.defaultValues ?? {}),
                      ...repairedValues,
                    };
                    setValues(initialValues);
                    setOpened({ title: item.title, values: JSON.stringify(initialValues) });
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
                    list.current?.closest<HTMLElement>('[data-settings-detail]')?.focus();
                  }}
                />
              </div>
            );
          })
        ) : (
          <p>{t('prompts.uiNoSavedCombinations')}</p>
        )}
      </div>
      {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
      <CombinationLeaveDialog proceed={leave} onContinue={() => setLeave(null)} />
    </SettingsDetail>
  );
}
