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
  const [editing, setEditing] = useState<{
    item: SavedPromptCombination;
    sourceRevision: number;
  } | null>(null);
  const [title, setTitle] = useState('');
  const [values, setValues] = useState<Record<string, PromptValue>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const items = combinations.filter((item) =>
    ownsPromptCombination(item, combinationOwner(current, role), role)
  );
  return (
    <Dialog
      open={open}
      title="옵션 조합 관리"
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
            조합 이름
            <input
              aria-label="조합 이름"
              value={title}
              disabled={busy}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <p className="muted">
            유지할 수 있는 값은 보존했어요. 현재 옵션을 확인한 뒤 저장해 주세요.
          </p>
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
              취소
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
              {busy ? '저장 중…' : '조합 저장'}
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
                {!compatible && <small> · 적용 불가</small>}
              </span>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setEditing({ item, sourceRevision: current.presetRevision ?? workspaceRevision });
                  setTitle(item.title);
                  setError('');
                  setValues({
                    ...resolvePromptValues(current.program, current.defaultValues ?? {}),
                    ...repairPromptCombinationValues(item, current.program),
                  });
                }}
              >
                {compatible ? '수정' : '옵션 수정'}
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
        <p>저장한 조합이 없어요.</p>
      )}
      {error && <NoticeBanner tone="error">{error}</NoticeBanner>}
    </Dialog>
  );
}
