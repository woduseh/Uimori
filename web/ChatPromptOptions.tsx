import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Library, PromptWorkspace } from '../core/product.js';
import { resolvePromptValues, reconcilePromptValues } from '../core/prompt-program.js';
import { combinationOwner, matchesPromptCombination } from '../core/prompt-combinations.js';
import { booleanPromptDraft } from './prompt-boolean-draft.js';
import { api } from './api.js';
import { PromptControlFields } from './PromptControlFields.js';
import './chat-prompt-options.css';
type Props = {
  open: boolean;
  workspace: PromptWorkspace | null;
  library: Library | null;
  disabled: boolean;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
};
export function ChatPromptOptions(props: Props) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (props.open) closeButton.current?.focus();
  }, [props.open]);
  useEffect(() => {
    if (!props.open) return;
    const media = matchMedia('(max-width:1100px)');
    const background = [
      ...document.querySelectorAll<HTMLElement>(
        '.app-shell > .sidebar, .app-shell > .story-workspace'
      ),
    ];
    const update = () => {
      for (const node of background) node.inert = media.matches;
    };
    update();
    media.addEventListener('change', update);
    return () => {
      media.removeEventListener('change', update);
      for (const node of background) node.inert = false;
    };
  }, [props.open]);
  return (
    <aside
      id="chat-prompt-options"
      className="chat-prompt-options"
      hidden={!props.open}
      role="region"
      aria-label="창작 옵션 패널"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          props.onClose();
        }
        if (event.key === 'Tab' && matchMedia('(max-width:1100px)').matches) {
          const nodes = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              'button,input,textarea,select,summary'
            ),
          ].filter((node) => !node.matches(':disabled') && node.checkVisibility());
          const first = nodes[0],
            last = nodes.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <header className="chat-options-header">
        <div>
          <h2>창작 옵션</h2>
          <small>모든 채팅 · 다음 생성부터 적용</small>
        </div>
        <button
          ref={closeButton}
          type="button"
          className="icon-button"
          aria-label="창작 옵션 닫기"
          onClick={props.onClose}
        >
          <X size={20} />
        </button>
      </header>
      {props.workspace ? (
        <OptionsEditor {...props} workspace={props.workspace} />
      ) : (
        <p role="status">현재 프롬프트를 불러오는 중이에요…</p>
      )}
    </aside>
  );
}

function OptionsEditor({ workspace, ...props }: Props & { workspace: PromptWorkspace }) {
  const [base, setBase] = useState(workspace);
  const [values, setValues] = useState(workspace.main.values);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const lock = useRef(false);
  const dirty = JSON.stringify(values) !== JSON.stringify(base.main.values);
  const conflict = workspace.revision > base.revision;
  const combinations =
    props.library?.promptCombinations?.filter((item) =>
      matchesPromptCombination(item, combinationOwner(base.main, 'main'), 'main', base.main.program)
    ) ?? [];
  useEffect(() => {
    if (!dirty && !busy) {
      setBase(workspace);
      setValues(workspace.main.values);
    }
  }, [workspace, dirty, busy]);
  useEffect(() => {
    props.onDirtyChange(dirty);
    return () => props.onDirtyChange(false);
  }, [dirty, props.onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [dirty]);
  async function save() {
    if (lock.current || props.disabled || conflict) return;
    lock.current = true;
    setBusy(true);
    props.onBusyChange(true);
    setError('');
    try {
      const accepted = await api<PromptWorkspace>(
        '/prompt-workspace',
        {
          expectedRevision: base.revision,
          main: { ...base.main, ...booleanPromptDraft(base.main.program, values) },
        },
        'PUT'
      );
      setBase(accepted);
      setValues(accepted.main.values);
    } catch (caught) {
      setError(`${(caught as Error).message} 입력한 옵션은 유지했어요.`);
    } finally {
      lock.current = false;
      setBusy(false);
      props.onBusyChange(false);
    }
  }
  return (
    <>
      <div className="chat-options-body">
        <h3>{base.main.title}</h3>
        <fieldset disabled={busy || props.disabled} className="chat-options-fields">
          <label>
            이 프롬프트의 옵션 조합
            <select
              aria-label="이 프롬프트의 옵션 조합"
              value=""
              onChange={(event) => {
                const preset = combinations.find((item) => item.id === event.target.value);
                if (preset) {
                  setValues(resolvePromptValues(base.main.program, preset.values));
                  setMessage('이 프롬프트의 옵션 조합을 불러왔어요. 저장하면 적용돼요.');
                }
              }}
            >
              <option value="">현재 옵션에 불러오기</option>
              {combinations.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <PromptControlFields
            program={base.main.program}
            values={values}
            onChange={(id, value) => setValues((current) => ({ ...current, [id]: value }))}
          />
          <button type="button" className="secondary" onClick={() => setValues({})}>
            프롬프트 기본값으로
          </button>
        </fieldset>
        {conflict && dirty && (
          <p role="alert">
            다른 곳에서 현재 프롬프트가 바뀌었어요. 초안은 유지했어요. 최신 설정을 다시 불러온 뒤
            적용해 주세요.
          </p>
        )}
        {message && <p role="status">{message}</p>}
        {error && <p role="alert">{error}</p>}
        {(error || conflict) && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void api<PromptWorkspace>('/prompt-workspace')
                .then((latest) => {
                  setBase(latest);
                  setValues(reconcilePromptValues(latest.main.program, values).values);
                  setError('');
                })
                .catch((caught) => setError(caught.message))
            }
          >
            최신 설정에 내 옵션 유지
          </button>
        )}
      </div>
      <footer className="chat-options-footer">
        <small>
          {dirty ? '저장하지 않은 변경이 있어요.' : '현재 옵션은 모든 채팅의 다음 요청에 사용해요.'}
        </small>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBase(workspace);
            setValues(workspace.main.values);
            setError('');
          }}
        >
          최신 설정 다시 불러오기
        </button>
        <button
          type="button"
          disabled={!dirty || busy || props.disabled || conflict}
          onClick={() => void save()}
        >
          {busy ? '적용 중…' : '현재 옵션 적용'}
        </button>
      </footer>
    </>
  );
}
