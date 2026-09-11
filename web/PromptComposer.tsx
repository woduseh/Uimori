import { Switch } from './BooleanControls.js';
import { parsePromptFile, type PromptFile } from '../core/prompt-file.js';
import { compileTranslationPreview } from '../core/translation-preview.js';
import { DismissibleError } from './DismissibleError.js';
import { PromptControlFields } from './PromptControlFields.js';
import { ActionMenu } from './ActionMenu.js';
import { IconButton } from './IconButton.js';
import {
  AddIcon,
  BackIcon,
  DeleteIcon,
  DownIcon,
  DownloadIcon,
  DragHandleIcon,
  ExpandIcon,
  SearchIcon,
  UndoIcon,
  UpIcon,
  UploadIcon,
  CodeIcon,
} from './ui-icons.js';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  EditorDraftFieldScope,
  useBufferedEditorState,
  useUnappliedEditorField,
} from './editor-workspace-context.js';
import {
  compilePromptProgram,
  validatePromptProgram,
  type ChatPromptControls,
  type PromptBlock,
  type PromptCompilation,
  type PromptControl,
  type PromptExpression,
  type PromptProgram,
  type PromptTemplate,
  type PromptValue,
} from '../core/prompt-program.js';
import { api, saveDownload } from './api.js';
import './prompt-composer.css';
import {
  DEFAULT_PROMPT_SLOTS,
  parsePromptTemplate,
  printPromptTemplate,
} from '../core/prompt-language.js';
type Props = {
  program: PromptProgram;
  onChange: (program: PromptProgram) => void;
  chatId?: string;
  branchId?: string;
  role?: 'main' | 'translation';
  controlState?: ChatPromptControls;
  title?: string;
  onImport?: (file: PromptFile) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onPendingDraftChange?: (dirty: boolean) => void;
  initialPreviewRequest?: string;
  onPreviewRequestChange?: (value: string) => void;
  initialControlDraft?: ChatPromptControls;
  onControlDraftChange?: (state: ChatPromptControls) => void;
  collaborationEditor?: ReactNode;
};
type EditorSection = 'blocks' | 'controls' | 'defaults' | 'collaboration' | 'preview' | 'json';
type Preview = {
  compilation: PromptCompilation;
  provider: {
    protocol: string;
    modelId: string;
    kind?: 'exact-request-body' | 'mapping-only';
    body?: unknown;
    messages?: unknown;
    system?: unknown;
    options?: unknown;
    diagnostics?: unknown;
  } | null;
  error?: string;
};
const emptyControls = (): ChatPromptControls => ({ values: {}, combinations: [] });
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const roleLabels = {
  system: 'system · 지침',
  user: 'user · 사용자',
  assistant: 'assistant · 응답',
};
const kindLabels = {
  message: '메시지',
  slot: '참조 자료',
  history: '대화 범위',
  current: '현재 입력',
  cache: '캐시 기준점',
};
const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

function freshBlock(
  kind: PromptBlock['kind'],
  id = newId('block'),
  title = '새 블록'
): PromptBlock {
  if (kind === 'message')
    return {
      id,
      title,
      kind,
      role: 'system',
      template: [{ kind: 'text', text: '' }],
      completion: 'complete',
    };
  if (kind === 'slot') return { id, title, kind, role: 'system', slot: 'description' };
  if (kind === 'history') return { id, title, kind, from: 0, to: 'end' };
  if (kind === 'cache') return { id, title, kind, depth: 1, role: 'all', policy: 'prefer' };
  return { id, title, kind };
}

/** Each JSON field owns its unaccepted text. Failed parsing never changes the applied value. */
function JsonDraft({
  fieldKey,
  label,
  value,
  onApply,
  onError,
  allowEmpty = false,
}: {
  fieldKey: string;
  label: string;
  value: unknown;
  onApply: (value: unknown) => void;
  onError: (message: string) => void;
  allowEmpty?: boolean;
}) {
  const serialized = value === undefined ? '' : pretty(value);
  const [draft, setDraft] = useBufferedEditorState(fieldKey, serialized);
  const [dirty, setDirty] = useBufferedEditorState(`${fieldKey}.pending`, false);
  useUnappliedEditorField(fieldKey, dirty);
  const [error, setError] = useState('');
  const original = useRef(serialized);
  useEffect(() => {
    if (!dirty) {
      setDraft(serialized);
      original.current = serialized;
    }
  }, [serialized, dirty, setDraft]);
  function apply() {
    try {
      const parsed = allowEmpty && !draft.trim() ? undefined : JSON.parse(draft);
      onApply(parsed);
      setDirty(false);
      setError('');
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      onError(message);
    }
  }
  return (
    <div className="pc-json">
      <label>
        {label}
        <textarea
          aria-label={label}
          spellCheck={false}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setDirty(true);
            setError('');
          }}
        />
      </label>
      {dirty && original.current !== serialized && (
        <p className="muted">적용된 값이 바뀌었어요. 아래 초안은 유지하고 있어요.</p>
      )}
      <div className="pc-actions">
        <button type="button" className="secondary" disabled={!dirty} onClick={apply}>
          JSON 적용
        </button>
        <button
          type="button"
          className="ghost"
          disabled={!dirty}
          onClick={() => {
            setDraft(serialized);
            original.current = serialized;
            setDirty(false);
            setError('');
          }}
        >
          적용된 값으로 되돌리기
        </button>
        {dirty && <small>미적용 초안</small>}
      </div>
      {error && (
        <p className="error" role="alert">
          {error} · 초안은 유지했어요.
        </p>
      )}
    </div>
  );
}
function FieldDraft({
  fieldKey,
  label,
  value,
  onApply,
  onError,
}: {
  fieldKey: string;
  label: string;
  value: string;
  onApply: (value: string) => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useBufferedEditorState(fieldKey, value);
  const [dirty, setDirty] = useBufferedEditorState(`${fieldKey}.pending`, false);
  useUnappliedEditorField(fieldKey, dirty);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!dirty) setDraft(value);
  }, [value, dirty, setDraft]);
  const apply = () => {
    if (!dirty) return;
    try {
      onApply(draft);
      setDirty(false);
      setError('');
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      onError(message);
    }
  };
  return (
    <label>
      {label}
      <input
        aria-label={label}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setDirty(true);
          setError('');
        }}
        onBlur={apply}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            apply();
          }
        }}
      />
      {dirty && <small>입력을 마치면 적용해요.</small>}
      {error && <small className="error">{error}</small>}
    </label>
  );
}
function TemplateEditor({
  fieldKey,
  template,
  onChange,
  onError,
  label,
  controlIds,
  slots,
  onPendingChange,
}: {
  fieldKey: string;
  template: PromptTemplate;
  onChange: (template: PromptTemplate) => void;
  onError: (message: string) => void;
  label: string;
  controlIds: string[];
  slots: string[];
  onPendingChange: (dirty: boolean) => void;
}) {
  const [mode, setMode] = useBufferedEditorState<'existing' | 'source'>(
    `${fieldKey}.mode`,
    'existing'
  );
  const [source, setSource] = useBufferedEditorState(`${fieldKey}.source`, '');
  const [pending, setPending] = useBufferedEditorState(`${fieldKey}.pending`, false);
  useUnappliedEditorField(fieldKey, pending);
  const pendingCallback = useRef(onPendingChange);
  pendingCallback.current = onPendingChange;
  useEffect(() => pendingCallback.current(pending), [pending]);
  const [error, setError] = useState('');
  const original = useRef('');
  useEffect(() => {
    if (mode === 'source' && !pending) {
      try {
        const printed = printPromptTemplate(template);
        setSource(printed);
        original.current = printed;
      } catch (caught) {
        setError(errorMessage(caught));
      }
    }
  }, [template, mode, pending, setSource]);
  const setPendingDraft = (value: boolean) => {
    setPending(value);
    onPendingChange(value);
  };
  const openSource = () => {
    try {
      const printed = printPromptTemplate(template);
      setSource(printed);
      original.current = printed;
      setMode('source');
      setError('');
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  const plain = template.every((node) => node.kind === 'text');
  const latestTemplate = useRef({ template, onChange, pending });
  latestTemplate.current = { template, onChange, pending };
  const importSequence = useRef(0);
  useEffect(
    () => () => {
      importSequence.current++;
    },
    []
  );
  async function importBody(file: File) {
    const turn = ++importSequence.current;
    const originalTemplate = pretty(template);
    const originalChange = onChange;
    try {
      if (!/\.(?:txt|md)$/iu.test(file.name) || file.size > 800_000)
        throw new Error('UTF-8 .txt 또는 .md 파일을 선택해 주세요.');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        await file.arrayBuffer()
      );
      if (text.length > 200_000) throw new Error('메시지 본문은 200,000자까지 불러올 수 있어요.');
      if (
        turn !== importSequence.current ||
        latestTemplate.current.pending ||
        latestTemplate.current.onChange !== originalChange ||
        pretty(latestTemplate.current.template) !== originalTemplate
      )
        return;
      latestTemplate.current.onChange([{ kind: 'text', text }]);
    } catch (caught) {
      if (turn === importSequence.current) onError(errorMessage(caught));
    }
  }
  return (
    <div className="pc-template">
      <div className="pc-actions">
        <button
          type="button"
          className="secondary"
          disabled={pending}
          aria-pressed={mode === 'existing'}
          onClick={() => setMode('existing')}
        >
          기존 본문 편집
        </button>
        <button
          type="button"
          className="secondary"
          aria-pressed={mode === 'source'}
          disabled={mode === 'source'}
          onClick={openSource}
        >
          템플릿 문법으로 편집 · 시험
        </button>
      </div>
      {mode === 'source' && (
        <div className="pc-json">
          <p className="muted">
            실험 기능이에요. 적용하면 저장할 프롬프트 구성이 바뀌어요. {'{{ options.id }}'} 값,{' '}
            {'{% if options.id %}...{% endif %}'} 조건을 사용해요. 현재 제어 ID:{' '}
            {controlIds.join(', ') || '없음'}.
          </p>
          <label>
            {label} 문법
            <textarea
              aria-label={`${label} 문법`}
              spellCheck={false}
              value={source}
              onChange={(event) => {
                setSource(event.target.value);
                setPendingDraft(event.target.value !== original.current);
                setError('');
              }}
            />
          </label>
          <div className="pc-actions">
            <button
              type="button"
              disabled={!pending}
              onClick={() => {
                try {
                  const parsed = parsePromptTemplate(source, controlIds, slots);
                  onChange(parsed);
                  original.current = source;
                  setPendingDraft(false);
                  setError('');
                } catch (caught) {
                  const message = errorMessage(caught);
                  setError(message);
                  onError(message);
                }
              }}
            >
              문법 초안 적용
            </button>
            <button
              type="button"
              className="ghost"
              disabled={!pending}
              onClick={() => {
                setSource(original.current);
                setPendingDraft(false);
                setError('');
              }}
            >
              문법 초안 되돌리기
            </button>
            {pending && <small>미적용 초안 · 적용한 뒤 프롬프트를 저장해요.</small>}
          </div>
        </div>
      )}
      <div hidden={mode !== 'existing'}>
        {plain ? (
          <label>
            {label}
            <textarea
              aria-label={label}
              value={template.map((node) => (node.kind === 'text' ? node.text : '')).join('')}
              onChange={(event) => {
                try {
                  onChange([{ kind: 'text', text: event.target.value }]);
                } catch (caught) {
                  onError(errorMessage(caught));
                }
              }}
            />
          </label>
        ) : (
          <p className="muted">
            조건·값·참조가 있는 템플릿이에요. 아래 JSON에서 구조를 그대로 편집해요.
          </p>
        )}
        {plain && (
          <label className="pc-file">
            본문 파일 불러오기
            <input
              type="file"
              aria-label={`${label} 파일 불러오기`}
              accept=".txt,.md,text/plain,text/markdown"
              disabled={pending}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void importBody(file);
              }}
            />
          </label>
        )}
        <details open={!plain}>
          <summary>
            <ExpandIcon className="pc-disclosure-icon" size={16} aria-hidden="true" />
            템플릿 JSON · 고급 편집
          </summary>
          <JsonDraft
            fieldKey={`${fieldKey}.json`}
            label={`${label} JSON`}
            value={template}
            onApply={(value) => onChange(value as PromptTemplate)}
            onError={onError}
          />
        </details>
      </div>
      {error && (
        <p className="error" role="alert">
          {error} · 초안은 유지했어요.
        </p>
      )}
    </div>
  );
}
function BlockEditor({
  block,
  onChange: commit,
  onError,
  controlIds,
  slots,
  onPendingChange,
}: {
  block: PromptBlock;
  onChange: (block: PromptBlock) => void;
  onError: (message: string) => void;
  controlIds: string[];
  slots: string[];
  onPendingChange: (dirty: boolean) => void;
}) {
  const onChange = (next: PromptBlock) => {
    try {
      commit(next);
    } catch (caught) {
      onError(errorMessage(caught));
    }
  };
  const [nextKind, setNextKind] = useState(block.kind);
  useEffect(() => {
    setNextKind(block.kind);
  }, [block.kind]);
  return (
    <div className="pc-block-fields">
      <div className="pc-grid">
        <label>
          블록 이름
          <input
            value={block.title}
            maxLength={200}
            onChange={(event) => onChange({ ...block, title: event.target.value })}
          />
        </label>
        <label>
          종류
          <select
            value={nextKind}
            onChange={(event) => setNextKind(event.target.value as PromptBlock['kind'])}
          >
            {Object.entries(kindLabels).map(([kind, label]) => (
              <option key={kind} value={kind}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {nextKind !== block.kind && (
        <button
          type="button"
          className="secondary"
          onClick={() =>
            onChange({
              ...freshBlock(nextKind, block.id, block.title),
              ...(block.enabled === undefined ? {} : { enabled: block.enabled }),
              ...(block.when === undefined ? {} : { when: block.when }),
            })
          }
        >
          선택한 종류의 새 설정으로 바꾸기
        </button>
      )}
      <label className="pc-checkbox">
        <Switch
          checked={block.enabled !== false}
          onChange={(event) => onChange({ ...block, enabled: event.target.checked })}
        />
        이 블록 사용
      </label>
      {(block.kind === 'message' || block.kind === 'slot') && (
        <label>
          메시지 역할
          <select
            value={block.role}
            onChange={(event) =>
              onChange({
                ...block,
                role: event.target.value as 'system' | 'user' | 'assistant',
                ...(block.kind === 'message' && event.target.value !== 'assistant'
                  ? { completion: 'complete' as const }
                  : {}),
              })
            }
          >
            {Object.entries(roleLabels).map(([role, label]) => (
              <option key={role} value={role}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      {block.kind === 'message' && (
        <>
          {block.role === 'assistant' && (
            <label>
              응답 메시지 형식
              <select
                value={block.completion ?? 'complete'}
                onChange={(event) =>
                  onChange({ ...block, completion: event.target.value as 'complete' | 'prefill' })
                }
              >
                <option value="complete">완결된 assistant 메시지</option>
                <option value="prefill">미완성 assistant prefill · 마지막 메시지</option>
              </select>
            </label>
          )}
          <TemplateEditor
            fieldKey={`blocks.${block.id}.template`}
            label={`${block.title || block.id} 본문`}
            template={block.template}
            onChange={(template) => commit({ ...block, template })}
            onError={onError}
            controlIds={controlIds}
            slots={slots}
            onPendingChange={onPendingChange}
          />
        </>
      )}
      {block.kind === 'slot' && (
        <>
          <label>
            참조 이름
            <input
              value={block.slot}
              list="pc-slot-names"
              onChange={(event) => onChange({ ...block, slot: event.target.value })}
            />
          </label>
          <p className="muted">참조가 비어 있으면 블록 전체를 생략해요.</p>
          {block.template ? (
            <TemplateEditor
              fieldKey={`blocks.${block.id}.wrapper`}
              label={`${block.title || block.id} 감싸는 템플릿`}
              template={block.template}
              onChange={(template) => commit({ ...block, template })}
              onError={onError}
              controlIds={controlIds}
              slots={slots}
              onPendingChange={onPendingChange}
            />
          ) : (
            <button
              type="button"
              className="secondary"
              onClick={() => onChange({ ...block, template: [{ kind: 'slot', name: block.slot }] })}
            >
              감싸는 템플릿 추가
            </button>
          )}
        </>
      )}
      {block.kind === 'history' && (
        <>
          <div className="pc-grid">
            <FieldDraft
              fieldKey={`blocks.${block.id}.from`}
              label="시작 위치"
              value={String(block.from)}
              onError={onError}
              onApply={(value) => {
                if (!/^-?\d+$/u.test(value)) throw new Error('시작 위치는 정수로 입력해 주세요.');
                commit({ ...block, from: Number(value) });
              }}
            />
            <FieldDraft
              fieldKey={`blocks.${block.id}.to`}
              label="끝 위치"
              value={String(block.to)}
              onError={onError}
              onApply={(value) => {
                if (value !== 'end' && !/^-?\d+$/u.test(value))
                  throw new Error('끝 위치는 정수 또는 end로 입력해 주세요.');
                commit({ ...block, to: value === 'end' ? 'end' : Number(value) });
              }}
            />
          </div>
          <p className="muted">
            0부터 세고 끝 위치는 포함하지 않아요. 음수는 뒤에서 세며 end는 마지막까지예요. 현재
            입력도 대화에 포함돼요.
          </p>
        </>
      )}
      {block.kind === 'current' && (
        <p className="muted">
          현재 입력 한 개를 넣어요. 다른 대화 범위에 같은 입력이 있으면 미리보기에서 중복 오류를
          표시해요.
        </p>
      )}
      {block.kind === 'cache' && (
        <div className="pc-grid">
          <FieldDraft
            fieldKey={`blocks.${block.id}.depth`}
            label="앞에서 찾을 메시지 수"
            value={String(block.depth)}
            onError={onError}
            onApply={(value) => {
              if (!/^[1-4]$/u.test(value))
                throw new Error('캐시 대상 수는 1부터 4까지 입력해 주세요.');
              commit({ ...block, depth: Number(value) });
            }}
          />
          <label>
            대상 역할
            <select
              value={block.role}
              onChange={(event) =>
                onChange({ ...block, role: event.target.value as 'all' | 'user' | 'assistant' })
              }
            >
              <option value="all">모든 역할</option>
              <option value="user">user</option>
              <option value="assistant">assistant</option>
            </select>
          </label>
          <label>
            지원 조건
            <select
              value={block.policy}
              onChange={(event) =>
                onChange({ ...block, policy: event.target.value as 'prefer' | 'require' })
              }
            >
              <option value="prefer">지원하면 적용</option>
              <option value="require">지원 필수</option>
            </select>
          </label>
        </div>
      )}
      <details>
        <summary>
          <ExpandIcon className="pc-disclosure-icon" size={16} aria-hidden="true" />
          블록 적용 조건
        </summary>
        <p className="muted">비워두면 항상 적용해요. 예: {'{"control":"control-id"}'}</p>
        <JsonDraft
          fieldKey={`blocks.${block.id}.when`}
          label={`${block.title || block.id} 조건 JSON`}
          value={block.when}
          allowEmpty
          onApply={(value) => {
            const next = { ...block };
            if (value === undefined) delete next.when;
            else next.when = value as PromptExpression;
            commit(next);
          }}
          onError={onError}
        />
      </details>
      <small className="pc-id">ID: {block.id}</small>
    </div>
  );
}
function ControlEditor({
  control,
  onChange: commit,
  onError,
}: {
  control: PromptControl;
  onChange: (control: PromptControl) => void;
  onError: (message: string) => void;
}) {
  const onChange = (next: PromptControl) => {
    try {
      commit(next);
    } catch (caught) {
      onError(errorMessage(caught));
    }
  };
  return (
    <div className="pc-control-fields">
      <div className="pc-grid">
        <label>
          제어 이름
          <input
            value={control.label}
            onChange={(event) => onChange({ ...control, label: event.target.value })}
          />
        </label>
        <label>
          값 종류
          <select
            value={control.type}
            onChange={(event) => {
              const type = event.target.value as PromptControl['type'];
              onChange({
                id: control.id,
                label: control.label,
                type,
                default: type === 'boolean' ? false : null,
                ...(control.description ? { description: control.description } : {}),
                ...(type === 'select' ? { options: [{ label: '기본 선택', value: '0' }] } : {}),
              });
            }}
          >
            <option value="select">선택 목록</option>
            <option value="boolean">켜기 / 끄기</option>
            <option value="text">텍스트</option>
            <option value="number">숫자</option>
          </select>
        </label>
      </div>
      {control.type === 'select' && (
        <JsonDraft
          fieldKey={`controls.${control.id}.options`}
          label={`${control.label} 선택지 JSON`}
          value={control.options ?? []}
          onApply={(value) => commit({ ...control, options: value as PromptControl['options'] })}
          onError={onError}
        />
      )}
      {control.type === 'number' && (
        <div className="pc-grid">
          {(['min', 'max'] as const).map((key) => (
            <label key={key}>
              {key === 'min' ? '최솟값' : '최댓값'}
              <input
                type="number"
                value={control[key] ?? ''}
                onChange={(event) => {
                  const next = { ...control };
                  if (event.target.value === '') delete next[key];
                  else next[key] = Number(event.target.value);
                  onChange(next);
                }}
              />
            </label>
          ))}
        </div>
      )}
      <label>
        설명
        <textarea
          rows={2}
          value={control.description ?? ''}
          maxLength={4000}
          onChange={(event) => onChange({ ...control, description: event.target.value })}
        />
      </label>
      <details>
        <summary>
          <ExpandIcon className="pc-disclosure-icon" size={16} aria-hidden="true" />
          제어 정의 JSON
        </summary>
        <JsonDraft
          fieldKey={`controls.${control.id}.definition`}
          label={`${control.label} 정의 JSON`}
          value={control}
          onApply={(value) => commit(value as PromptControl)}
          onError={onError}
        />
      </details>
      <small className="pc-id">ID: {control.id}</small>
    </div>
  );
}

export function PromptComposer({
  program,
  onChange,
  chatId,
  branchId,
  role = 'main',
  controlState,
  title,
  onImport,
  onDirtyChange,
  onPendingDraftChange,
  initialPreviewRequest,
  onPreviewRequestChange,
  initialControlDraft,
  onControlDraftChange,
  collaborationEditor,
}: Props) {
  const sectionId = useId();
  const [section, setSection] = useState<EditorSection>('blocks');
  const [blockQuery, setBlockQuery] = useState('');
  const [controlQuery, setControlQuery] = useState('');
  const [selectedBlock, setSelectedBlock] = useState(program.blocks[0]?.id ?? '');
  const [selectedControl, setSelectedControl] = useState(program.controls[0]?.id ?? '');
  const [itemDetail, setItemDetail] = useState(false);
  const activeBlock = program.blocks.some((block) => block.id === selectedBlock)
    ? selectedBlock
    : program.blocks[0]?.id;
  const activeControl = program.controls.some((control) => control.id === selectedControl)
    ? selectedControl
    : program.controls[0]?.id;
  const sections: { id: EditorSection; title: string }[] = [
    { id: 'blocks', title: '블록' },
    { id: 'controls', title: '옵션 정의' },
    { id: 'defaults', title: '기본 옵션' },
    ...(collaborationEditor ? [{ id: 'collaboration' as const, title: '에이전트 협업' }] : []),
    { id: 'preview', title: '미리보기' },
  ];
  const sectionProps = (id: EditorSection) => ({
    id: `${sectionId}-${id}-panel`,
    role: 'tabpanel',
    'aria-labelledby': `${sectionId}-${id}-tab`,
    hidden: section !== id,
  });
  const [pendingTemplates, setPendingTemplates] = useState<Record<string, boolean>>({});
  const pendingTemplate = Object.values(pendingTemplates).some(Boolean);
  const slotNames = new Set<string>([
    ...DEFAULT_PROMPT_SLOTS,
    'char',
    'globalNote',
    'references',
    'source',
    'context',
    'outputSchema',
    'catalog',
  ]);
  const collectSlots = (nodes: PromptTemplate) => {
    for (const node of nodes) {
      if (node.kind === 'slot') slotNames.add(node.name);
      if (node.kind === 'if') {
        collectSlots(node.then);
        if (node.else) collectSlots(node.else);
      }
      if (node.kind === 'each' || node.kind === 'let') {
        collectSlots(node.body);
        if (node.kind === 'each' && node.else) collectSlots(node.else);
      }
    }
  };
  for (const block of program.blocks) {
    if (block.kind === 'slot') slotNames.add(block.slot);
    if ((block.kind === 'message' || block.kind === 'slot') && block.template)
      collectSlots(block.template);
  }
  const scope = role;
  const [drafts, setDrafts] = useState<Record<string, ChatPromptControls>>({});
  const controls = drafts[scope] ?? initialControlDraft ?? controlState ?? emptyControls();
  const savedControls = pretty(controlState ?? emptyControls());
  const controlsDirty = pretty(controls) !== savedControls;
  useEffect(() => {
    onPendingDraftChange?.(pendingTemplate);
  }, [pendingTemplate, onPendingDraftChange]);
  const knownControls = new Set(program.controls.map((control) => control.id));
  const hasRemovedValues = [
    controls.values,
    ...controls.combinations.map((combination) => combination.values),
  ].some((values) => Object.keys(values).some((id) => !knownControls.has(id)));
  const [requests, setRequests] = useState({
    main:
      role === 'main'
        ? (initialPreviewRequest ?? '다음 장면을 이어 써 주세요.')
        : '다음 장면을 이어 써 주세요.',
    translation:
      role === 'translation'
        ? (initialPreviewRequest ?? 'The traveler returned home before sunset.')
        : 'The traveler returned home before sunset.',
  });
  const request = requests[role];
  const setRequest = (value: string) => setRequests((previous) => ({ ...previous, [role]: value }));
  const [preview, setPreview] = useState<{
    value: Preview;
    fingerprint: string;
    synthetic: boolean;
    blockNames: Record<string, string>;
  } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  useEffect(() => {
    onDirtyChange?.(controlsDirty || pendingTemplate);
  }, [controlsDirty, pendingTemplate, onDirtyChange]);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [undo, setUndo] = useState<{ program: PromptProgram; controls?: ChatPromptControls }[]>([]);
  const root = useRef<HTMLElement>(null);
  const draggingBlock = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const clearDrag = () => {
    draggingBlock.current = null;
    setDropTarget(null);
  };
  const lastBlockAction = useRef<string | undefined>(undefined);
  const lastCollaboration = useRef(program.collaboration);
  useEffect(() => {
    // The separate advisor editor owns these edits. An older body undo must not erase them.
    if (lastCollaboration.current !== program.collaboration) setUndo([]);
    lastCollaboration.current = program.collaboration;
  }, [program.collaboration]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A prompt scope switch clears its undo history.
  useEffect(() => {
    setUndo([]);
    setError('');
    setStatus('');
  }, [scope]);
  const sequence = useRef(0);
  const fingerprint = pretty({ program, values: controls.values, request, scope });
  const latest = useRef({ fingerprint, scope });
  latest.current = { fingerprint, scope };
  useEffect(
    () => () => {
      sequence.current++;
    },
    []
  );
  const report = (message: string) => {
    setError(message);
  };
  const change = (next: PromptProgram) => {
    // Incomplete advisor fields remain an unsaved draft while the body stays editable.
    // Save, preview, and JSON import still validate the complete program.
    const { collaboration, ...body } = next;
    const validated = {
      ...validatePromptProgram(body),
      ...(collaboration !== undefined ? { collaboration } : {}),
    };
    setUndo((current) => [...current.slice(-19), { program: structuredClone(program) }]);
    lastCollaboration.current = collaboration;
    onChange(validated);
    setError('');
    setStatus('프롬프트 초안을 바꿨어요. 상위 편집기에서 저장할 수 있어요.');
  };
  const edit = (next: PromptProgram) => {
    try {
      change(next);
    } catch (caught) {
      report(errorMessage(caught));
    }
  };
  const changeBlock = (index: number, block: PromptBlock) =>
    change({ ...program, blocks: program.blocks.map((item, i) => (i === index ? block : item)) });
  const editBlock = (index: number, block: PromptBlock) => {
    try {
      changeBlock(index, block);
    } catch (caught) {
      report(errorMessage(caught));
      throw caught;
    }
  };
  const editControls = (next: ChatPromptControls) => {
    onControlDraftChange?.(next);
    setDrafts((current) => ({ ...current, [scope]: next }));
    setStatus('기본 창작 옵션을 바꿨어요. 편집기 아래 저장 버튼으로 함께 저장해요.');
    setError('');
  };
  const safe = (work: () => void) => {
    try {
      work();
    } catch (caught) {
      report(errorMessage(caught));
    }
  };
  function focusBlock(id: string, direction?: number) {
    setSelectedBlock(id);
    setItemDetail(true);
    setSection('blocks');
    requestAnimationFrame(() => {
      const block = root.current?.querySelector<HTMLElement>(`#prompt-block-${CSS.escape(id)}`);
      const button =
        direction === undefined
          ? null
          : block?.querySelector<HTMLButtonElement>(`[data-block-move="${direction}"]`);
      const target =
        button && !button.disabled
          ? button
          : block?.querySelector<HTMLElement>('.pc-block-heading');
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: 'nearest' });
    });
  }
  function move(index: number, direction: number) {
    const blocks = [...program.blocks];
    const target = index + direction;
    if (target < 0 || target >= blocks.length) return;
    [blocks[index], blocks[target]] = [blocks[target]!, blocks[index]!];
    lastBlockAction.current = program.blocks[index].id;
    edit({ ...program, blocks });
    focusBlock(program.blocks[index].id, direction);
  }
  function removeBlock(index: number) {
    if (pendingTemplate) return;
    lastBlockAction.current = program.blocks[index].id;
    const remaining = program.blocks.filter((_, i) => i !== index);
    edit({ ...program, blocks: remaining });
    const next = remaining[Math.min(index, remaining.length - 1)];
    if (next) focusBlock(next.id);
    else
      requestAnimationFrame(() =>
        root.current?.querySelector<HTMLButtonElement>('[data-add-block]')?.focus()
      );
  }
  function undoEdit() {
    if (pendingTemplate) return;
    const previous = undo.at(-1);
    if (!previous) return;
    setUndo((current) => current.slice(0, -1));
    lastCollaboration.current = previous.program.collaboration;
    onChange(previous.program);
    if (previous.controls) editControls(previous.controls);
    setStatus('이전 프롬프트 초안으로 되돌렸어요.');
    const target = previous.program.blocks.find((block) => block.id === lastBlockAction.current);
    if (target) focusBlock(target.id);
  }
  async function runPreview() {
    const turn = ++sequence.current;
    const sourceFingerprint = fingerprint;
    setPreviewBusy(true);
    setError('');
    try {
      let result: Preview;
      if (chatId)
        result = await api<Preview>(`/chats/${encodeURIComponent(chatId)}/prompt-preview`, {
          program,
          request,
          values: controls.values,
          ...(branchId ? { branchId } : {}),
          role,
        });
      else if (role === 'translation') {
        result = {
          compilation: await compileTranslationPreview(program, request, controls.values),
          provider: null,
        };
      } else {
        const slots: Record<string, string> = { char: '합성 인물' };
        const walk = (nodes: PromptTemplate) => {
          for (const node of nodes) {
            if (node.kind === 'slot') slots[node.name] ??= `합성 ${node.name} 자료`;
            if (node.kind === 'if') {
              walk(node.then);
              if (node.else) walk(node.else);
            }
            if (node.kind === 'each' || node.kind === 'let') {
              walk(node.body);
              if (node.kind === 'each' && node.else) walk(node.else);
            }
          }
        };
        for (const block of program.blocks) {
          if (block.kind === 'slot') {
            slots[block.slot] ??= `합성 ${block.slot} 자료`;
            if (block.template) walk(block.template);
          }
          if (block.kind === 'message') walk(block.template);
        }
        result = {
          compilation: compilePromptProgram(program, {
            values: controls.values,
            slots,
            history: [
              { id: 'preview-user-1', role: 'user', text: '합성 이전 입력' },
              { id: 'preview-assistant-1', role: 'assistant', text: '합성 이전 응답' },
              { id: 'preview-current', role: 'user', text: request, current: true },
            ],
          }),
          provider: null,
        };
      }
      if (turn === sequence.current && sourceFingerprint === latest.current.fingerprint) {
        setPreview({
          value: result,
          fingerprint: sourceFingerprint,
          synthetic: !chatId,
          blockNames: Object.fromEntries(
            program.blocks.map((block, index) => [
              block.id,
              `${index + 1}. ${block.title.trim() || kindLabels[block.kind]}`,
            ])
          ),
        });
        setStatus('미리보기를 갱신했어요.');
      }
    } catch (caught) {
      if (turn === sequence.current && sourceFingerprint === latest.current.fingerprint)
        report(errorMessage(caught));
    } finally {
      if (turn === sequence.current) setPreviewBusy(false);
    }
  }
  async function importFile(file: File) {
    const activeScope = scope;
    const turn = ++sequence.current;
    const sourceFingerprint = fingerprint;
    try {
      if (file.size > 1_500_000) throw new Error('JSON 파일은 1.5 MB 이하여야 해요.');
      const parsed = JSON.parse(await file.text()) as unknown;
      if (
        latest.current.scope !== activeScope ||
        turn !== sequence.current ||
        latest.current.fingerprint !== sourceFingerprint
      )
        return;
      const imported = parsePromptFile(parsed);
      if (onImport) onImport(imported);
      else onChange(imported.program);
      if (!imported.role || imported.role === role) {
        // Imports replace both the structure and option values. Undo must restore them together.
        setUndo((current) => [...current.slice(-19), structuredClone({ program, controls })]);
        lastCollaboration.current = imported.program.collaboration;
        editControls({ values: imported.values, combinations: [] });
      }
      setStatus('JSON을 편집 초안으로 불러왔어요.');
      // File inputs do not pass through ActionMenu's button-choice handler. Finish a successful
      // import by dismissing its sheet so the imported blocks and undo action are reachable.
      const menu = root.current?.querySelector<HTMLDetailsElement>('.pc-program-menu');
      if (menu?.open) {
        menu.open = false;
        menu.querySelector('summary')?.focus();
      }
    } catch (caught) {
      report(errorMessage(caught));
    }
  }
  return (
    <EditorDraftFieldScope prefix={`prompt.${role}`}>
      <section
        ref={root}
        className="prompt-composer"
        aria-label="프롬프트 구성"
        data-testid="prompt-composer"
      >
        <div className="pc-editor-workspace">
          <div
            className="pc-section-tabs"
            role="tablist"
            aria-label="프롬프트 편집 섹션"
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const current = sections.findIndex((item) => item.id === section);
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? sections.length - 1
                    : (current + (event.key === 'ArrowRight' ? 1 : -1) + sections.length) %
                      sections.length;
              setSection(sections[next].id);
              event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
            }}
          >
            {sections.map((item) => (
              <button
                type="button"
                role="tab"
                key={item.id}
                id={`${sectionId}-${item.id}-tab`}
                aria-controls={`${sectionId}-${item.id}-panel`}
                aria-selected={section === item.id}
                tabIndex={section === item.id ? 0 : -1}
                onClick={() => {
                  setSection(item.id);
                  setItemDetail(false);
                }}
              >
                {item.title}
              </button>
            ))}
          </div>
          <label className="pc-section-select">
            <span className="sr-only">프롬프트 편집 섹션</span>
            <select
              aria-label="프롬프트 편집 섹션"
              value={section}
              onChange={(event) => {
                setSection(event.target.value as EditorSection);
                setItemDetail(false);
              }}
            >
              {sections.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
              {section === 'json' && <option value="json">JSON 편집</option>}
            </select>
          </label>
          <div className="pc-composer-content">
            <div className="pc-composer-tools">
              <IconButton
                label="이전 편집으로"
                icon={UndoIcon}
                disabled={pendingTemplate || !undo.length}
                onClick={undoEdit}
              />
              <ActionMenu label="프롬프트 구성 도구" className="pc-program-menu">
                <button type="button" onClick={() => setSection('json')}>
                  <CodeIcon size={18} aria-hidden="true" />
                  JSON 편집
                </button>
                <label className="pc-file">
                  <UploadIcon size={18} aria-hidden="true" /> JSON 불러오기
                  <input
                    aria-label="프롬프트 구성 JSON 불러오기"
                    type="file"
                    disabled={pendingTemplate}
                    accept=".json,application/json"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file) void importFile(file);
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    safe(() =>
                      saveDownload(
                        'uimori-prompt.json',
                        parsePromptFile({ title, role, program, values: controls.values })
                      )
                    )
                  }
                >
                  <DownloadIcon size={18} aria-hidden="true" /> JSON 내보내기
                </button>
              </ActionMenu>
            </div>
            <div className="pc-structure-editor">
              <datalist id="pc-slot-names">
                {[
                  'description',
                  'persona',
                  'lorebook',
                  'references',
                  'notes',
                  'authorNote',
                  'globalNote',
                  'postEverything',
                  'char',
                  'source',
                  'context',
                  'outputSchema',
                  'catalog',
                ].map((name) => (
                  <option key={name} value={name}>
                    {name === 'references' ? '기본 자료 (출처 포함)' : name}
                  </option>
                ))}
              </datalist>
              <section className="pc-section pc-blocks-section" {...sectionProps('blocks')}>
                <div className="pc-item-workspace" data-detail={itemDetail}>
                  <aside className="pc-item-navigation" aria-label="블록 목록">
                    <label className="pc-item-search">
                      <SearchIcon size={18} aria-hidden="true" />
                      <input
                        type="search"
                        aria-label="블록 찾기"
                        placeholder="블록 찾기"
                        value={blockQuery}
                        onChange={(event) => setBlockQuery(event.target.value)}
                      />
                    </label>
                    <div className="pc-blocks-heading">
                      <span>블록 · {program.blocks.length}개</span>
                      <IconButton
                        icon={AddIcon}
                        label="블록 추가"
                        className="pc-add-block"
                        data-add-block
                        disabled={program.blocks.length >= 300}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          const section = event.currentTarget.closest('details');
                          if (section) section.open = true;
                          const block = freshBlock('message');
                          edit({ ...program, blocks: [...program.blocks, block] });
                          setSelectedBlock(block.id);
                          setItemDetail(true);
                          setBlockQuery('');
                          requestAnimationFrame(() => {
                            const added = root.current?.querySelector<HTMLElement>(
                              `#prompt-block-${CSS.escape(block.id)}`
                            );
                            if (!added) return;
                            const input = added.querySelector<HTMLInputElement>('input');
                            input?.focus({ preventScroll: true });
                            input?.scrollIntoView({ block: 'nearest' });
                          });
                        }}
                      />
                    </div>
                    <div className="pc-item-links">
                      {program.blocks.map((block, index) => (
                        <button
                          type="button"
                          key={block.id}
                          aria-label={`${block.title || block.id} 블록 선택`}
                          hidden={
                            !!blockQuery &&
                            !`${block.title} ${block.id}`
                              .toLocaleLowerCase()
                              .includes(blockQuery.toLocaleLowerCase())
                          }
                          aria-current={activeBlock === block.id ? 'true' : undefined}
                          onClick={() => {
                            setSelectedBlock(block.id);
                            setItemDetail(true);
                          }}
                          draggable
                          onDragStart={(event) => {
                            draggingBlock.current = block.id;
                            event.dataTransfer.effectAllowed = 'move';
                            event.dataTransfer.setData('text/plain', block.id);
                          }}
                          onDragEnd={clearDrag}
                          onDragOver={(event) => {
                            event.preventDefault();
                            event.dataTransfer.dropEffect = 'move';
                            setDropTarget({
                              id: block.id,
                              after:
                                event.clientY >
                                event.currentTarget.getBoundingClientRect().top +
                                  event.currentTarget.offsetHeight / 2,
                            });
                          }}
                          data-drop-position={
                            dropTarget?.id === block.id
                              ? dropTarget.after
                                ? 'after'
                                : 'before'
                              : undefined
                          }
                          onDrop={(event) => {
                            event.preventDefault();
                            const sourceId = draggingBlock.current;
                            const after = dropTarget?.after ?? false;
                            clearDrag();
                            if (!sourceId || sourceId === block.id) return;
                            const source = program.blocks.find((item) => item.id === sourceId);
                            if (!source) return;
                            const blocks = program.blocks.filter((item) => item.id !== sourceId);
                            const target = blocks.findIndex((item) => item.id === block.id);
                            blocks.splice(target + (after ? 1 : 0), 0, source);
                            lastBlockAction.current = sourceId;
                            edit({ ...program, blocks });
                            focusBlock(sourceId);
                          }}
                        >
                          <strong>
                            {index + 1}. {block.title || block.id}
                          </strong>
                          <small>
                            {'role' in block ? `${block.role} · ` : ''}
                            {kindLabels[block.kind]}
                            {block.enabled === false ? ' · 사용 안 함' : ''}
                          </small>
                        </button>
                      ))}
                      {!!blockQuery &&
                        !program.blocks.some((block) =>
                          `${block.title} ${block.id}`
                            .toLocaleLowerCase()
                            .includes(blockQuery.toLocaleLowerCase())
                        ) && <p className="muted">일치하는 블록이 없어요.</p>}
                    </div>
                  </aside>
                  <div className="pc-item-detail">
                    <button
                      type="button"
                      className="secondary pc-item-back"
                      onClick={() => setItemDetail(false)}
                    >
                      <BackIcon size={18} aria-hidden="true" />
                      블록 목록
                    </button>
                    {!program.blocks.length && (
                      <p className="muted">블록을 추가해 프롬프트를 구성해요.</p>
                    )}
                    <div className="pc-block-list">
                      {program.blocks.map((block, index) => (
                        <section
                          className={`pc-block${block.enabled === false ? ' pc-disabled' : ''}`}
                          hidden={activeBlock !== block.id}
                          data-drop-position={
                            dropTarget?.id === block.id
                              ? dropTarget.after
                                ? 'after'
                                : 'before'
                              : undefined
                          }
                          onDragOver={(event) => {
                            if (!draggingBlock.current) return;
                            event.preventDefault();
                            event.dataTransfer.dropEffect = 'move';
                            const bounds = event.currentTarget.getBoundingClientRect();
                            setDropTarget({
                              id: block.id,
                              after: event.clientY >= bounds.top + bounds.height / 2,
                            });
                          }}
                          onDragLeave={(event) => {
                            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                              setDropTarget(null);
                          }}
                          onDrop={(event) => {
                            const sourceId = draggingBlock.current;
                            if (!sourceId) return;
                            event.preventDefault();
                            event.stopPropagation();
                            const bounds = event.currentTarget.getBoundingClientRect();
                            const after = event.clientY >= bounds.top + bounds.height / 2;
                            clearDrag();
                            if (sourceId === block.id) return;
                            const source = program.blocks.find((item) => item.id === sourceId);
                            if (!source) return;
                            const blocks = program.blocks.filter((item) => item.id !== sourceId);
                            const target = blocks.findIndex((item) => item.id === block.id);
                            if (target < 0) return;
                            blocks.splice(target + (after ? 1 : 0), 0, source);
                            if (
                              blocks.every(
                                (item, position) => item.id === program.blocks[position].id
                              )
                            )
                              return;
                            lastBlockAction.current = sourceId;
                            edit({ ...program, blocks });
                            focusBlock(sourceId);
                          }}
                          key={block.id}
                          id={`prompt-block-${block.id}`}
                        >
                          <div className="pc-block-heading" tabIndex={-1}>
                            <button
                              type="button"
                              className="pc-drag-handle"
                              draggable
                              aria-label={`${block.title || block.id} 블록 드래그`}
                              title="드래그하여 순서 변경 · 키보드는 블록 안의 위/아래 이동 사용"
                              onClick={(event) => event.preventDefault()}
                              onDragStart={(event) => {
                                draggingBlock.current = block.id;
                                event.dataTransfer.effectAllowed = 'move';
                                event.dataTransfer.setData('text/plain', block.id);
                              }}
                              onDragEnd={clearDrag}
                            >
                              <DragHandleIcon size={18} aria-hidden="true" />
                            </button>
                            <span className="pc-order">{index + 1}</span>
                            <span className="pc-block-title">
                              {block.title || block.id}
                              <small>
                                {kindLabels[block.kind]}
                                {'role' in block ? ` · ${block.role}` : ''}
                                {block.when !== undefined ? ' · 조건 있음' : ''}
                                {block.enabled === false ? ' · 사용 안 함' : ''}
                              </small>
                            </span>
                          </div>
                          <div className="pc-block-body">
                            <div className="pc-block-tools">
                              <IconButton
                                label={`${block.title} 위로`}
                                icon={UpIcon}
                                data-block-move={-1}
                                disabled={index === 0}
                                onClick={() => move(index, -1)}
                              />
                              <IconButton
                                label={`${block.title} 아래로`}
                                icon={DownIcon}
                                data-block-move={1}
                                disabled={index === program.blocks.length - 1}
                                onClick={() => move(index, 1)}
                              />
                              <ActionMenu label={`${block.title || block.id} 블록 메뉴`}>
                                <button
                                  type="button"
                                  className="secondary"
                                  disabled={pendingTemplate}
                                  onClick={() => removeBlock(index)}
                                >
                                  <DeleteIcon size={18} aria-hidden="true" /> 블록 삭제
                                </button>
                              </ActionMenu>
                            </div>
                            <BlockEditor
                              block={block}
                              onChange={(next) => {
                                if (pendingTemplate && next.kind !== block.kind)
                                  throw new Error('문법 초안을 먼저 적용하거나 되돌려 주세요.');
                                editBlock(index, next);
                              }}
                              onError={report}
                              controlIds={program.controls.map((control) => control.id)}
                              slots={[...slotNames]}
                              onPendingChange={(dirty) =>
                                setPendingTemplates((current) => ({
                                  ...current,
                                  [block.id]: dirty,
                                }))
                              }
                            />
                          </div>
                        </section>
                      ))}
                    </div>
                  </div>
                </div>
              </section>
              <section className="pc-section" {...sectionProps('controls')}>
                <div className="pc-item-workspace" data-detail={itemDetail}>
                  <aside className="pc-item-navigation" aria-label="옵션 정의 목록">
                    <label className="pc-item-search">
                      <SearchIcon size={18} aria-hidden="true" />
                      <input
                        type="search"
                        aria-label="옵션 정의 찾기"
                        placeholder="옵션 정의 찾기"
                        value={controlQuery}
                        onChange={(event) => setControlQuery(event.target.value)}
                      />
                    </label>
                    <div className="pc-blocks-heading">
                      <span>옵션 정의 · {program.controls.length}개</span>
                      <IconButton
                        label="제어 추가"
                        icon={AddIcon}
                        disabled={program.controls.length >= 150}
                        onClick={() => {
                          const control: PromptControl = {
                            id: newId('control'),
                            label: '새 제어',
                            type: 'boolean',
                            default: false,
                          };
                          edit({ ...program, controls: [...program.controls, control] });
                          setSelectedControl(control.id);
                          setItemDetail(true);
                          setControlQuery('');
                        }}
                      />
                    </div>
                    <div className="pc-item-links">
                      {program.controls.map((control) => (
                        <button
                          type="button"
                          key={control.id}
                          hidden={
                            !!controlQuery &&
                            !`${control.label} ${control.id}`
                              .toLocaleLowerCase()
                              .includes(controlQuery.toLocaleLowerCase())
                          }
                          aria-current={activeControl === control.id ? 'true' : undefined}
                          onClick={() => {
                            setSelectedControl(control.id);
                            setItemDetail(true);
                          }}
                        >
                          <strong>{control.label}</strong>
                          <small>{control.type}</small>
                        </button>
                      ))}
                      {!!controlQuery &&
                        !program.controls.some((control) =>
                          `${control.label} ${control.id}`
                            .toLocaleLowerCase()
                            .includes(controlQuery.toLocaleLowerCase())
                        ) && <p className="muted">일치하는 옵션이 없어요.</p>}
                    </div>
                  </aside>
                  <div className="pc-item-detail">
                    <button
                      type="button"
                      className="secondary pc-item-back"
                      onClick={() => setItemDetail(false)}
                    >
                      <BackIcon size={18} aria-hidden="true" />
                      옵션 정의 목록
                    </button>
                    {!program.controls.length && (
                      <p className="muted">
                        옵션 정의를 추가하면 기본 옵션에서 값을 설정할 수 있어요.
                      </p>
                    )}
                    {program.controls.map((control, index) => (
                      <section
                        className="pc-control"
                        key={control.id}
                        hidden={activeControl !== control.id}
                      >
                        <h3>{control.label}</h3>
                        <ControlEditor
                          control={control}
                          onError={report}
                          onChange={(next) =>
                            change({
                              ...program,
                              controls: program.controls.map((item, i) =>
                                i === index ? next : item
                              ),
                            })
                          }
                        />
                        <button
                          type="button"
                          className="ghost"
                          onClick={() =>
                            edit({
                              ...program,
                              controls: program.controls.filter((_, i) => i !== index),
                            })
                          }
                        >
                          제어 삭제
                        </button>
                      </section>
                    ))}
                  </div>
                </div>
              </section>
            </div>
            <section className="pc-section pc-defaults" {...sectionProps('defaults')}>
              <h3>기본 창작 옵션</h3>
              <div className="pc-stack">
                <p className="muted">
                  이 프롬프트의 기본값이에요. 프리셋을 저장할 때 함께 저장해요.
                </p>
                <PromptControlFields
                  program={program}
                  values={controls.values}
                  onChange={(id, value) =>
                    editControls({
                      ...controls,
                      values: { ...controls.values, [id]: value },
                      selectedCombinationId: undefined,
                    })
                  }
                />
                {hasRemovedValues && (
                  <div className="pc-stack">
                    <p className="muted">현재 프롬프트에 없는 제어의 선택값이 남아 있어요.</p>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        const keep = (values: Record<string, PromptValue>) =>
                          Object.fromEntries(
                            Object.entries(values).filter(([id]) => knownControls.has(id))
                          );
                        editControls({
                          ...controls,
                          values: keep(controls.values),
                          combinations: controls.combinations.map((combination) => ({
                            ...combination,
                            values: keep(combination.values),
                          })),
                        });
                      }}
                    >
                      정의가 없는 선택값만 정리
                    </button>
                  </div>
                )}
              </div>
            </section>
            {collaborationEditor && (
              <section className="pc-section" {...sectionProps('collaboration')}>
                {collaborationEditor}
              </section>
            )}
            <section
              className="pc-section"
              hidden={section !== 'json'}
              aria-label="전체 구성 JSON 편집"
            >
              <button type="button" className="secondary" onClick={() => setSection('blocks')}>
                <BackIcon size={18} aria-hidden="true" />
                블록 편집으로
              </button>
              <h3>전체 구성 JSON</h3>
              <JsonDraft
                fieldKey={`program.${role}`}
                label="전체 프롬프트 구성 JSON"
                value={program}
                onApply={(value) => {
                  if (pendingTemplate)
                    throw new Error('문법 초안을 먼저 적용하거나 되돌려 주세요.');
                  change(validatePromptProgram(value));
                }}
                onError={report}
              />
            </section>
            <section className="pc-section pc-preview" {...sectionProps('preview')}>
              <h3>전송 미리보기</h3>
              <label>
                {role === 'translation' ? '미리보기 원문' : '현재 요청'}
                <textarea
                  aria-label={role === 'translation' ? '미리보기 원문' : '미리보기 현재 요청'}
                  value={request}
                  onChange={(event) => {
                    setRequest(event.target.value);
                    onPreviewRequestChange?.(event.target.value);
                  }}
                />
              </label>
              <div className="pc-actions">
                <button
                  type="button"
                  disabled={previewBusy || !request.trim()}
                  onClick={() => void runPreview()}
                >
                  {previewBusy ? '구성 중…' : '미리보기 갱신'}
                </button>
                <small>
                  {chatId
                    ? '이 이야기의 자료와 대화를 사용해요. 모델을 호출하지 않아요.'
                    : '합성 자료와 대화로 구성 순서를 확인해요.'}
                </small>
              </div>
              {preview && (
                <div className="pc-preview-result">
                  {preview.fingerprint !== fingerprint && (
                    <p className="pc-stale" role="status">
                      설정이나 요청이 바뀌었어요. 아래는 이전 미리보기예요.
                    </p>
                  )}
                  <p className="muted">
                    {preview.synthetic ? '합성 미리보기' : '이야기 미리보기'} · 메시지{' '}
                    {preview.value.compilation.messages.length}개 · 캐시 기준{' '}
                    {preview.value.compilation.cachePlan.length}개
                  </p>
                  <ol className="pc-message-list">
                    {preview.value.compilation.messages.map((message, index) => (
                      <li key={message.id}>
                        <details>
                          <summary>
                            <ExpandIcon
                              className="pc-disclosure-icon"
                              size={16}
                              aria-hidden="true"
                            />
                            {index + 1}. {message.role} · {message.completion}
                            <small>
                              {preview.blockNames[message.provenance.blockId] ??
                                (message.provenance.blockId === '__host_background_lore__'
                                  ? '공통 배경 자료'
                                  : '추가 실행 문맥')}{' '}
                              · {message.provenance.origin}
                            </small>
                          </summary>
                          <pre>{message.content.map((part) => part.text).join('\n')}</pre>
                        </details>
                      </li>
                    ))}
                  </ol>
                  <details>
                    <summary>
                      <ExpandIcon className="pc-disclosure-icon" size={16} aria-hidden="true" />
                      블록별 조건과 포함 결과
                    </summary>
                    <div className="pc-table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>블록</th>
                            <th>결과</th>
                            <th>메시지 수</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.value.compilation.trace.map((trace) => (
                            <tr key={trace.blockId}>
                              <td>{preview.blockNames[trace.blockId] ?? '이름 없는 블록'}</td>
                              <td>
                                {trace.included
                                  ? '적용'
                                  : trace.reason === 'disabled'
                                    ? '사용 안 함'
                                    : '조건 불일치'}
                              </td>
                              <td>{trace.messageIds.length}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                  <details>
                    <summary>
                      <ExpandIcon className="pc-disclosure-icon" size={16} aria-hidden="true" />
                      캐시 기준과 지원 제한
                    </summary>
                    <pre>
                      {pretty({
                        cachePlan: preview.value.compilation.cachePlan,
                        warnings: preview.value.compilation.warnings,
                        providerDiagnostics: preview.value.provider?.diagnostics ?? null,
                      })}
                    </pre>
                  </details>
                  {preview.value.error && (
                    <p className="error" role="alert">
                      {preview.value.error}
                    </p>
                  )}
                  {preview.value.provider ? (
                    <details>
                      <summary>
                        <ExpandIcon className="pc-disclosure-icon" size={16} aria-hidden="true" />
                        공급자 전송 구성 · {preview.value.provider.protocol} ·{' '}
                        {preview.value.provider.modelId}
                      </summary>
                      <p className="muted">
                        {preview.value.provider.kind === 'exact-request-body'
                          ? '현재 미리보기 스냅샷의 인코더 본문이에요. 실제 실행에서는 실행 ID와 무작위 선택, 최신 설정이 달라질 수 있어요. 인증 정보는 없고, 전송이나 과금은 발생하지 않아요.'
                          : '역할 변환만 확인하는 미리보기예요. 실행 시 보호된 번역 구간·도구·출력 형식이 추가되므로 실제 요청 본문과 달라요.'}
                      </p>
                      <pre>{pretty(preview.value.provider)}</pre>
                    </details>
                  ) : (
                    <p className="muted">공급자별 전송 구성은 표시되지 않았어요.</p>
                  )}
                </div>
              )}
            </section>
          </div>
        </div>
        <DismissibleError message={error} onDismiss={() => setError('')} />
        <p className="pc-status" role="status">
          {status}
        </p>
      </section>
    </EditorDraftFieldScope>
  );
}
