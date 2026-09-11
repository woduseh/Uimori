import { useEffect, useRef, useState } from 'react';
import type { PromptPreset, PromptRole } from '../core/product.js';
import { api } from './api.js';
import { Dialog } from './Dialog.js';
import { AddIcon } from './ui-icons.js';
import './prompt-templates.css';

type PromptTemplateSummary = {
  id: string;
  title: string;
  role: PromptRole;
  description: string;
};
export type PromptTemplate = PromptTemplateSummary & Pick<PromptPreset, 'program' | 'values'>;

export function PromptTemplatesDialog({
  open,
  busy,
  onClose,
  onAdd,
  onAdded,
  onError,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onAdd: (id: string) => Promise<PromptPreset | null>;
  onAdded: (preset: PromptPreset) => void;
  onError: (message: string) => void;
}) {
  const [templates, setTemplates] = useState<PromptTemplateSummary[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [adding, setAdding] = useState<PromptTemplateSummary | null>(null);
  const [failure, setFailure] = useState<{
    template: PromptTemplateSummary;
    message: string;
  } | null>(null);
  const lock = useRef(false);
  const current = useRef({ open, onAdded, onError });
  current.current = { open, onAdded, onError };
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit retry refreshes the same catalog while the dialog stays open.
  useEffect(() => {
    if (!open) return;
    let active = true;
    setTemplates(null);
    setLoadError('');
    setFailure(null);
    void api<PromptTemplateSummary[]>('/prompt-templates')
      .then((items) => {
        if (active) setTemplates(items);
      })
      .catch((error: Error) => {
        if (active) setLoadError(error.message);
      });
    return () => {
      active = false;
    };
  }, [open, loadAttempt]);
  async function add(template: PromptTemplateSummary) {
    if (lock.current || busy) return;
    lock.current = true;
    setAdding(template);
    setFailure(null);
    try {
      const preset = await onAdd(template.id);
      // Closing this picker does not cancel a save already requested, or replace another editor.
      if (preset && current.current.open) current.current.onAdded(preset);
    } catch (error) {
      const message = (error as Error).message;
      if (current.current.open) setFailure({ template, message });
      else current.current.onError(message);
    } finally {
      lock.current = false;
      setAdding(null);
    }
  }
  const pending = busy || adding !== null;
  return (
    <Dialog open={open} title="기본 프롬프트" className="prompt-templates-dialog" onClose={onClose}>
      <p className="muted prompt-templates-description">
        프리셋으로 추가해 자유롭게 편집하고, 현재 프롬프트 설정에서 불러와 사용할 수 있어요.
      </p>
      {loadError ? (
        <div className="prompt-templates-error">
          <p role="alert">기본 프롬프트를 불러오지 못했어요. {loadError}</p>
          <button type="button" className="secondary" onClick={() => setLoadAttempt((n) => n + 1)}>
            다시 불러오기
          </button>
        </div>
      ) : templates === null ? (
        <p role="status">기본 프롬프트를 불러오는 중이에요…</p>
      ) : (
        <ul className="prompt-template-list" aria-label="기본 프롬프트 목록">
          {templates.map((template) => (
            <li key={template.id} className="prompt-template-row">
              <div className="prompt-template-copy">
                <h3>{template.title}</h3>
                <span className="muted">{template.role === 'translation' ? '번역' : '작문'}</span>
                <p>{template.description}</p>
              </div>
              <button
                type="button"
                className="secondary"
                aria-label={`${template.title} 추가`}
                disabled={pending}
                onClick={() => void add(template)}
              >
                <AddIcon size={18} aria-hidden="true" />
                추가
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding && <p role="status">{adding.title} 프리셋을 추가하는 중이에요…</p>}
      {failure && (
        <div className="prompt-templates-error">
          <p role="alert">프롬프트를 추가하지 못했어요. {failure.message}</p>
          <button
            type="button"
            className="secondary"
            disabled={pending}
            aria-label={`${failure.template.title} 다시 추가`}
            onClick={() => void add(failure.template)}
          >
            다시 시도
          </button>
        </div>
      )}
    </Dialog>
  );
}
