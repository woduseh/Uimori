import { useI18n, translateMessage } from './i18n.js';
import { useRef, useState } from 'react';
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
      onBack={() => {
        setEditing(null);
        setError('');
        onClose();
      }}
    >
      <SettingsDetail
        open={!!editing}
        location={[sectionLabel, t('prompts.uiManageCombinations'), editing?.item.title ?? '']}
        backDisabled={busy}
        onBack={() => {
          setEditing(null);
          setError('');
        }}
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
    </SettingsDetail>
  );
}
