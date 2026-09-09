import { SelectionCheckbox } from './BooleanControls.js';
import { LoreEditor } from './LoreEditor.js';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { Content } from '../core/product.js';
import type { ContentPackage, PackageRole } from '../core/content-package.js';
import './package.css';
import './package-authoring.css';
import { PackageControlsEditor } from './PackageControlsEditor.js';
import { PackageInstructionsEditor } from './PackageInstructionsEditor.js';
import { PackageImagesEditor } from './PackageImagesEditor.js';
import { PackageStartsEditor } from './PackageStartsEditor.js';
import { PackageFeaturesEditor } from './PackageFeaturesEditor.js';
import { IconButton } from './IconButton.js';
import { SectionNavigation } from './SectionNavigation.js';
import { useCompactLayout } from './useCompactLayout.js';
import {
  BackIcon,
  BehaviorIcon,
  DisplayIcon,
  ImagesIcon,
  LoreIcon,
  ModuleIcon,
  OptionsIcon,
  PersonaIcon,
  PromptIcon,
  StartIcon,
} from './ui-icons.js';
import {
  behaviorActionTriggers,
  validateBehaviorValue,
  validatePackageBehavior,
  type BehaviorAction,
  type PackageBehavior,
} from '../core/package-behavior.js';

export function blankPackage(): ContentPackage {
  return {
    version: 1,
    id: 'draft',
    revision: 1,
    title: '',
    description: '',
    lore: [],
    instructions: [],
    controls: [],
    transforms: [],
  };
}
export function packageFromContent(
  item: Pick<Content, 'title' | 'description' | 'text'>
): ContentPackage {
  return { ...blankPackage(), title: item.title, description: item.description, body: item.text };
}
const uid = () => crypto.randomUUID();
const roles: PackageRole[] = ['bot', 'persona', 'module'];
const labels = {
  bot: '봇으로 사용할 때',
  persona: '페르소나로 사용할 때',
  module: '모듈로 사용할 때',
};
const packageSections = [
  { id: 'lore', title: '로어', icon: LoreIcon, description: '세계와 인물의 참고 자료' },
  { id: 'images', title: '이미지', icon: ImagesIcon, description: '자료에서 사용할 이미지' },
  { id: 'starts', title: '시작', icon: StartIcon, description: '첫 장면과 시작 선택지' },
  { id: 'instructions', title: '지침', icon: PromptIcon, description: '모델에게 전할 요청과 조건' },
  { id: 'options', title: '옵션', icon: OptionsIcon, description: '대화마다 고르는 설정' },
  { id: 'features', title: '연결과 기능', icon: ModuleIcon, description: '공유 모듈과 도구 연결' },
  { id: 'display', title: '표현', icon: DisplayIcon, description: '표시 변환과 상태창' },
  {
    id: 'roles',
    title: '역할별 지침',
    icon: PersonaIcon,
    description: '봇·페르소나·모듈의 사용 지침',
  },
  { id: 'behavior', title: '상태와 행동', icon: BehaviorIcon, description: '상태값과 실행할 행동' },
] as const;
type PackageSection = (typeof packageSections)[number]['id'];
type SectionPosition = {
  focused: HTMLElement | undefined;
  selection: { start: number; end: number; direction: 'forward' | 'backward' | 'none' } | null;
  scroller: HTMLElement | null;
  top: number;
  left: number;
  inside: { element: HTMLElement; top: number; left: number }[];
};
function editorScroller(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement)
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
  return document.scrollingElement as HTMLElement | null;
}

/** Package structure has ordinary fields; raw schema editing is an optional author tool. */
export function PackageFields({
  value,
  onChange,
  onBehaviorDraftChange,
}: {
  value: ContentPackage;
  onChange: (v: ContentPackage) => void;
  onBehaviorDraftChange?: (dirty: boolean) => void;
}) {
  const compact = useCompactLayout();
  const idPrefix = useId();
  const root = useRef<HTMLElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const positions = useRef(new Map<PackageSection, SectionPosition>());
  const lastFocused = useRef(new Map<PackageSection, HTMLElement>());
  const lastRootFocus = useRef<HTMLElement | null>(null);
  const pendingPosition = useRef<'detail' | 'list' | 'desktop' | null>(null);
  const previousCompact = useRef(compact);
  const [tab, setTab] = useState<PackageSection>('lore');
  const [detailOpen, setDetailOpen] = useState(!compact);
  const showingDetail = !compact || detailOpen;
  const currentSection = packageSections.find((item) => item.id === tab)!;
  const visiblePanel = (id: PackageSection) => ({
    id: `${idPrefix}-${id}-panel`,
    role: compact ? 'region' : 'tabpanel',
    'aria-labelledby': `${idPrefix}-${id}-tab`,
    'data-package-section': id,
    hidden: tab !== id,
  });
  function rememberPosition() {
    const container = root.current;
    const panel = container?.querySelector<HTMLElement>(`[data-package-section="${tab}"]`);
    if (!container || !panel?.checkVisibility()) return;
    const focused = lastFocused.current.get(tab);
    const input =
      focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
        ? focused
        : null;
    const scroller = editorScroller(container);
    positions.current.set(tab, {
      focused,
      selection:
        input?.selectionStart !== null && input?.selectionStart !== undefined
          ? {
              start: input.selectionStart,
              end: input.selectionEnd ?? input.selectionStart,
              direction: input.selectionDirection ?? 'none',
            }
          : null,
      scroller,
      top: scroller?.scrollTop ?? 0,
      left: scroller?.scrollLeft ?? 0,
      inside: [...panel.querySelectorAll<HTMLElement>('*')]
        .filter((element) => element.scrollTop || element.scrollLeft)
        .map((element) => ({ element, top: element.scrollTop, left: element.scrollLeft })),
    });
  }
  function selectSection(next: PackageSection) {
    if (!compact && next === tab) return;
    rememberPosition();
    pendingPosition.current = compact ? 'detail' : 'desktop';
    setTab(next);
    setDetailOpen(true);
  }
  useLayoutEffect(() => {
    const container = root.current;
    const resized = compact !== previousCompact.current;
    previousCompact.current = compact;
    if (!container?.checkVisibility()) return;
    const pending = pendingPosition.current;
    pendingPosition.current = null;
    if (pending === 'list') {
      const choice = document.getElementById(`${idPrefix}-${tab}-tab`);
      choice?.focus({ preventScroll: true });
      choice?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (pending === 'detail' || pending === 'desktop') {
      const position = positions.current.get(tab);
      if (position?.scroller?.isConnected) {
        position.scroller.scrollTop = position.top;
        position.scroller.scrollLeft = position.left;
      }
      for (const entry of position?.inside ?? []) {
        entry.element.scrollTop = entry.top;
        entry.element.scrollLeft = entry.left;
      }
      const focused = position?.focused;
      if (pending === 'detail') {
        if (focused?.isConnected && focused.checkVisibility()) {
          focused.focus({ preventScroll: true });
          if (
            position?.selection &&
            (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement)
          )
            focused.setSelectionRange(
              position.selection.start,
              position.selection.end,
              position.selection.direction
            );
          focused.scrollIntoView({ block: 'nearest' });
        } else {
          detailHeading.current?.focus({ preventScroll: true });
          detailHeading.current?.scrollIntoView({ block: 'nearest' });
        }
      }
      return;
    }
    if (resized) {
      const active = document.activeElement;
      const displaced =
        active instanceof HTMLElement && container.contains(active)
          ? active
          : active === document.body
            ? lastRootFocus.current
            : null;
      if (displaced && container.contains(displaced) && !displaced.checkVisibility()) {
        const target = showingDetail
          ? detailHeading.current
          : document.getElementById(`${idPrefix}-${tab}-tab`);
        target?.focus({ preventScroll: true });
        target?.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [compact, showingDetail, idPrefix, tab]);
  // A replaced package owns new editor instances; old DOM and caret references must not carry over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a new package identity invalidates saved editing positions.
  useEffect(() => {
    positions.current.clear();
    lastFocused.current.clear();
    lastRootFocus.current = null;
  }, [value.id]);
  const [behaviorDirty, setBehaviorDirty] = useState(false),
    [controlsDirty, setControlsDirty] = useState(false),
    [instructionsDirty, setInstructionsDirty] = useState(false);
  const [imagesDirty, setImagesDirty] = useState(false),
    [startsDirty, setStartsDirty] = useState(false),
    [featuresDirty, setFeaturesDirty] = useState(false),
    [loreDirty, setLoreDirty] = useState(false);
  useEffect(() => {
    onBehaviorDraftChange?.(
      behaviorDirty ||
        controlsDirty ||
        instructionsDirty ||
        imagesDirty ||
        startsDirty ||
        featuresDirty ||
        loreDirty
    );
  }, [
    behaviorDirty,
    controlsDirty,
    instructionsDirty,
    imagesDirty,
    startsDirty,
    featuresDirty,
    loreDirty,
    onBehaviorDraftChange,
  ]);
  const update = (part: Partial<ContentPackage>) => onChange({ ...value, ...part });
  return (
    <section
      ref={root}
      className="package-fields full"
      aria-label="패키지 구성"
      data-testid="package-fields"
      onFocusCapture={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        lastRootFocus.current = target;
        const panel = target.closest<HTMLElement>('[data-package-section]');
        if (panel && event.currentTarget.contains(panel)) {
          lastFocused.current.set(panel.dataset.packageSection as PackageSection, target);
          if (!detailOpen) setDetailOpen(true);
        }
      }}
      onBlurCapture={(event) => {
        if (event.target instanceof HTMLElement && event.target.closest('[data-package-section]'))
          rememberPosition();
        if (
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          lastRootFocus.current = null;
      }}
    >
      <div className="package-editor-layout" data-compact={compact}>
        <SectionNavigation
          label="패키지 편집 분류"
          items={packageSections}
          value={tab}
          onSelect={selectSection}
          compact={compact}
          idPrefix={idPrefix}
          hidden={compact && detailOpen}
        />
        <div className="package-section-content" hidden={!showingDetail}>
          <header className="package-section-heading">
            {compact && (
              <IconButton
                label="패키지 분야 목록"
                icon={BackIcon}
                onClick={() => {
                  rememberPosition();
                  pendingPosition.current = 'list';
                  setDetailOpen(false);
                }}
              />
            )}
            <h3 ref={detailHeading} tabIndex={-1}>
              {currentSection.title}
            </h3>
          </header>
          <div {...visiblePanel('images')}>
            <PackageImagesEditor
              key={value.id}
              value={value}
              onChange={onChange}
              onDirtyChange={setImagesDirty}
            />
          </div>
          <div {...visiblePanel('starts')}>
            <PackageStartsEditor
              key={value.id}
              value={value}
              onChange={onChange}
              onDraftChange={setStartsDirty}
            />
          </div>
          <div {...visiblePanel('features')}>
            <PackageFeaturesEditor
              key={value.id}
              value={value}
              onChange={onChange}
              onDirtyChange={setFeaturesDirty}
            />
          </div>
          <div {...visiblePanel('behavior')}>
            <BehaviorEditor
              key={value.id}
              value={(value as ContentPackage & { behavior?: PackageBehavior }).behavior}
              onChange={(behavior) => update({ behavior } as Partial<ContentPackage>)}
              onDirtyChange={setBehaviorDirty}
            />
          </div>
          <div {...visiblePanel('lore')}>
            <LoreEditor
              key={value.id}
              value={value}
              onChange={update}
              onDraftChange={setLoreDirty}
            />
          </div>
          <div {...visiblePanel('instructions')}>
            <PackageInstructionsEditor
              key={value.id}
              value={value}
              onChange={(instructions) => update({ instructions })}
              onDirtyChange={setInstructionsDirty}
            />
          </div>
          <div {...visiblePanel('options')}>
            <PackageControlsEditor
              key={value.id}
              value={value}
              onChange={(controls) => update({ controls })}
              onDirtyChange={setControlsDirty}
            />
          </div>
          <div {...visiblePanel('roles')}>
            <div className="package-stack">
              <p className="muted">
                같은 자료를 다른 역할로 사용할 때 필요한 지침이에요. 비워두면 공통 본문과 지침을
                사용해요.
              </p>
              {roles.map((role) => (
                <label key={role}>
                  {labels[role]}
                  <textarea
                    rows={4}
                    value={value.roleBindings?.[role] ?? ''}
                    onChange={(e) =>
                      update({ roleBindings: { ...value.roleBindings, [role]: e.target.value } })
                    }
                  />
                </label>
              ))}
            </div>
          </div>
          <div {...visiblePanel('display')}>
            <div className="package-stack">
              <p className="muted">
                정규식은 읽기 화면의 표현에만 적용해요. 저장된 원문과 번역은 그대로 남아요.
              </p>
              {value.transforms.map((rule, index) => (
                <fieldset className="package-entry" key={rule.id}>
                  <legend>표시 변환 {index + 1}</legend>
                  <label>
                    대상
                    <select
                      value={rule.target}
                      onChange={(e) =>
                        update({
                          transforms: value.transforms.map((x) =>
                            x.id === rule.id
                              ? { ...x, target: e.target.value as 'source' | 'translation' }
                              : x
                          ),
                        })
                      }
                    >
                      <option value="source">원문 표시</option>
                      <option value="translation">번역 표시</option>
                    </select>
                  </label>
                  <label>
                    찾을 정규식
                    <input
                      aria-label={`표시 변환 ${index + 1} 패턴`}
                      value={rule.pattern}
                      onChange={(e) =>
                        update({
                          transforms: value.transforms.map((x) =>
                            x.id === rule.id ? { ...x, pattern: e.target.value } : x
                          ),
                        })
                      }
                    />
                  </label>
                  <label>
                    플래그
                    <input
                      value={rule.flags}
                      onChange={(e) =>
                        update({
                          transforms: value.transforms.map((x) =>
                            x.id === rule.id ? { ...x, flags: e.target.value } : x
                          ),
                        })
                      }
                    />
                  </label>
                  <label>
                    바꿀 내용
                    <textarea
                      rows={3}
                      value={rule.replacement}
                      onChange={(e) =>
                        update({
                          transforms: value.transforms.map((x) =>
                            x.id === rule.id ? { ...x, replacement: e.target.value } : x
                          ),
                        })
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() =>
                      update({ transforms: value.transforms.filter((x) => x.id !== rule.id) })
                    }
                  >
                    변환 삭제
                  </button>
                </fieldset>
              ))}
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  update({
                    transforms: [
                      ...value.transforms,
                      {
                        id: uid(),
                        target: 'source',
                        pattern: '\\[note\\]([\\s\\S]*?)\\[/note\\]',
                        flags: 'g',
                        replacement: '> $1',
                      },
                    ],
                  })
                }
              >
                정규식 표시 변환 추가
              </button>
              <details>
                <summary>상태창 표시 필드</summary>
                <label>
                  상태창 제목
                  <input
                    value={value.stateView?.title ?? ''}
                    onChange={(e) =>
                      update({
                        stateView: { title: e.target.value, fields: value.stateView?.fields ?? [] },
                      })
                    }
                  />
                </label>
                {value.stateView?.fields.map((field, index) => (
                  <div className="package-state-row" key={index}>
                    <label>
                      상태 키
                      <input
                        value={field.key}
                        onChange={(e) =>
                          update({
                            stateView: {
                              ...value.stateView!,
                              fields: value.stateView!.fields.map((x, i) =>
                                i === index ? { ...x, key: e.target.value } : x
                              ),
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      표시 이름
                      <input
                        value={field.label}
                        onChange={(e) =>
                          update({
                            stateView: {
                              ...value.stateView!,
                              fields: value.stateView!.fields.map((x, i) =>
                                i === index ? { ...x, label: e.target.value } : x
                              ),
                            },
                          })
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() =>
                        update({
                          stateView: {
                            ...value.stateView!,
                            fields: value.stateView!.fields.filter((_, i) => i !== index),
                          },
                        })
                      }
                    >
                      필드 삭제
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    update({
                      stateView: {
                        title: value.stateView?.title ?? '현재 상태',
                        fields: [
                          ...(value.stateView?.fields ?? []),
                          {
                            key: `field_${(value.stateView?.fields.length ?? 0) + 1}`,
                            label: '상태',
                          },
                        ],
                      },
                    })
                  }
                >
                  상태 표시 필드 추가
                </button>
                <small>
                  채팅의 상태 계산 결과에 있는 키를 연결해요. 값이 없으면 미확인으로 표시해요.
                </small>
              </details>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

const neutralBehavior: PackageBehavior = {
  revision: 1,
  schemaVersion: 1,
  stateSchema: {
    type: 'record',
    properties: { count: { type: 'number', min: 0, max: 100, integer: true } },
  },
  initialState: { count: 0 },
  actions: [
    {
      id: 'set_count',
      label: '횟수 기록',
      description: '입력한 횟수를 이 채팅에 기록해요.',
      inputSchema: {
        type: 'record',
        properties: { value: { type: 'number', min: 0, max: 100, integer: true } },
      },
      effects: [{ path: ['count'], value: { context: ['input', 'value'] } }],
    },
  ],
  outputParsers: [],
};
const actionMethods = [
  { id: 'user', label: '사용자 버튼', description: '채팅에서 사용자가 입력하고 실행해요.' },
  {
    id: 'before-turn',
    label: '생성 전 자동 실행',
    description: '새 장면을 생성하기 전에 정해 둔 입력으로 실행해요.',
  },
  {
    id: 'model',
    label: '모델이 필요할 때 요청',
    description: '이야기 문맥에 따라 모델이 입력을 정하고 요청해요.',
  },
] as const;
// Invocation inputs may be incomplete while the creator edits them. Validate the
// remaining definition so these controls stay usable until explicit application.
function editableBehaviorDraft(draft: string): PackageBehavior | undefined {
  try {
    const parsed = JSON.parse(draft) as PackageBehavior;
    if (!Array.isArray(parsed.actions)) return;
    validatePackageBehavior({
      ...parsed,
      actions: parsed.actions.map(({ triggers, automaticInput, ...action }) => action),
    });
    if (
      parsed.actions.some(
        (action) =>
          action.triggers !== undefined &&
          (!Array.isArray(action.triggers) ||
            action.triggers.some(
              (trigger) => !actionMethods.some((method) => method.id === trigger)
            ))
      )
    )
      return;
    return parsed;
  } catch {
    return;
  }
}
function automaticInputHelp(action: BehaviorAction, text: string): string {
  try {
    validateBehaviorValue(action.inputSchema, JSON.parse(text));
    return '자동 실행 때마다 이 입력을 사용해요.';
  } catch {
    return '이 행동에 필요한 입력을 JSON으로 채워 주세요. 입력이 없는 행동은 {}를 사용해요.';
  }
}
function BehaviorEditor({
  value,
  onChange,
  onDirtyChange,
}: {
  value: PackageBehavior | undefined;
  onChange: (value: PackageBehavior | undefined) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const serialized = value ? JSON.stringify(value, null, 2) : '';
  const [draft, setDraft] = useState(serialized),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [automaticDrafts, setAutomaticDrafts] = useState<Record<string, string>>({});
  const previous = useRef(serialized);
  useEffect(() => {
    if (serialized !== previous.current) {
      const prior = previous.current;
      setDraft((current) => (current === prior ? serialized : current));
      previous.current = serialized;
    }
  }, [serialized]);
  const dirty = draft !== serialized || Object.keys(automaticDrafts).length > 0;
  const editable = editableBehaviorDraft(draft);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  function updateAction(index: number, part: Partial<BehaviorAction>) {
    if (!editable) return;
    setDraft(
      JSON.stringify(
        {
          ...editable,
          actions: editable.actions.map((action, i) =>
            i === index ? { ...action, ...part } : action
          ),
        },
        null,
        2
      )
    );
    setError('');
    setNotice('');
  }
  function toggleMethod(
    index: number,
    action: BehaviorAction,
    method: (typeof actionMethods)[number]['id'],
    checked: boolean
  ) {
    const triggers = actionMethods
      .filter((item) =>
        item.id === method ? checked : behaviorActionTriggers(action).includes(item.id)
      )
      .map((item) => item.id);
    if (method === 'before-turn' && !checked) {
      setAutomaticDrafts((current) => ({
        ...current,
        [action.id]: current[action.id] ?? JSON.stringify(action.automaticInput ?? {}, null, 2),
      }));
      updateAction(index, { triggers, automaticInput: undefined });
    } else updateAction(index, { triggers });
  }
  function editAutomaticInput(index: number, action: BehaviorAction, text: string) {
    setAutomaticDrafts((current) => ({ ...current, [action.id]: text }));
    setError('');
    setNotice('');
    try {
      updateAction(index, { automaticInput: JSON.parse(text) });
    } catch {
      /* Keep incomplete JSON as its exact field draft. */
    }
  }
  function apply() {
    try {
      const candidate = JSON.parse(draft) as PackageBehavior;
      if (Array.isArray(candidate.actions))
        candidate.actions = candidate.actions.map((action) =>
          behaviorActionTriggers(action).includes('before-turn') &&
          Object.hasOwn(automaticDrafts, action.id)
            ? { ...action, automaticInput: JSON.parse(automaticDrafts[action.id]) }
            : action
        );
      const parsed = validatePackageBehavior(candidate);
      onChange(parsed);
      setDraft(JSON.stringify(parsed, null, 2));
      setAutomaticDrafts({});
      setError('');
      setNotice('편집 내용을 적용했어요. 자료 저장으로 새 버전을 남겨 주세요.');
    } catch (e) {
      setError(
        `형식을 확인해 주세요. 마지막으로 적용한 동작과 JSON 초안은 유지돼요. (${(e as Error).message})`
      );
      setNotice('');
    }
  }
  return (
    <div className="package-stack behavior-editor">
      <p>이 패키지가 채팅마다 기억할 상태와 행동을 정의하고, 각 행동을 언제 실행할지 골라요.</p>
      {value ? (
        <p>
          {
            Object.keys(value.stateSchema.type === 'record' ? value.stateSchema.properties : {})
              .length
          }
          개 상태 · {value.actions.length}개 행동 · {value.outputParsers.length}개 출력 해석 규칙
        </p>
      ) : (
        <p className="muted">아직 상태와 행동을 정의하지 않았어요.</p>
      )}
      {!value && !draft && (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            const example = structuredClone(neutralBehavior);
            setDraft(JSON.stringify(example, null, 2));
            setNotice(
              '횟수 0에서 시작해 버튼으로 입력한 횟수를 기록하는 예제예요. 검증 후 적용해 주세요.'
            );
          }}
        >
          중립 시작 예제 넣기
        </button>
      )}
      {editable && editable.actions.length > 0 && (
        <section className="package-stack" aria-label="행동 호출 방법">
          <p className="muted">
            한 행동에 여러 방법을 허용할 수 있어요. 모두 끄면 실행하지 않아요.
          </p>
          {editable.actions.map((action, index) => {
            const triggers = behaviorActionTriggers(action),
              title = action.label || action.id;
            const automaticText =
              automaticDrafts[action.id] ?? JSON.stringify(action.automaticInput ?? {}, null, 2);
            return (
              <fieldset className="package-entry behavior-method-editor" key={action.id}>
                <legend>{title} 호출 방법</legend>
                {action.description && <p className="muted">{action.description}</p>}
                {actionMethods.map((method) => (
                  <label className="check behavior-method-choice" key={method.id}>
                    <SelectionCheckbox
                      checked={triggers.includes(method.id)}
                      onChange={(e) => toggleMethod(index, action, method.id, e.target.checked)}
                    />
                    <span>
                      {method.label}
                      <small>{method.description}</small>
                    </span>
                  </label>
                ))}
                {triggers.includes('before-turn') && (
                  <label>
                    자동 실행 입력 · JSON
                    <textarea
                      aria-label={`${title} 자동 실행 입력 JSON`}
                      rows={4}
                      spellCheck={false}
                      value={automaticText}
                      onChange={(e) => editAutomaticInput(index, action, e.target.value)}
                    />
                    <small>{automaticInputHelp(action, automaticText)}</small>
                  </label>
                )}
                {triggers.some((trigger) => trigger !== 'user') && (
                  <small>
                    같은 장면의 행동 결과는 한 번 정해요. 원문 생성이 끝나면 상태에 반영하고,
                    취소하면 반영하지 않아요.
                  </small>
                )}
              </fieldset>
            );
          })}
        </section>
      )}
      {draft.trim() && !editable && (
        <p className="muted">
          동작 정의 JSON의 형식을 바로잡으면 행동별 호출 방법을 선택할 수 있어요.
        </p>
      )}
      <details>
        <summary>제작자용 동작 JSON 편집</summary>
        <p className="muted">
          Lua나 HTML을 실행하지 않아요. 지원되는 상태 형식과 식만 사용할 수 있어요. 다른 형식을 바꿔
          넣으면 원래 동작이 손실될 수 있으므로 원본을 보관해 주세요.
        </p>
        <label>
          동작 정의 JSON
          <textarea
            aria-label="동작 정의 JSON"
            rows={18}
            spellCheck={false}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setAutomaticDrafts({});
              setError('');
              setNotice('');
            }}
          />
        </label>
        {value && (
          <small>
            현재 동작 revision {value.revision} · schema {value.schemaVersion}. 상태 구조를 바꿀
            때는 기존 채팅의 상태를 어떻게 옮길지 먼저 확인해 주세요.
          </small>
        )}
      </details>
      {dirty && (
        <p role="status">
          아직 적용하지 않은 초안이에요. 검증 후 적용하면 자료를 저장할 수 있어요.
        </p>
      )}
      <button
        className="secondary"
        type="button"
        disabled={!draft.trim() || !dirty}
        onClick={apply}
      >
        동작 검증 후 적용
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
