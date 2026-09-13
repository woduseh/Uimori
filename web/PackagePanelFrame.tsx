import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { RenderedPackagePanel } from '../core/package-panels.js';
import {
  PACKAGE_PANEL_MAX_HEIGHT,
  PACKAGE_PANEL_MESSAGE_LIMIT,
  PACKAGE_PANEL_MIN_HEIGHT,
  preparePackagePanel,
  type PreparedPackagePanel,
} from './package-panel-frame.js';
import './package-panels.css';

const channel = 'uimori-package-panel-v1';

type Props = {
  panel: RenderedPackagePanel;
  disabled: boolean;
  onAction: (actionId: string, input: unknown) => Promise<void>;
};

type FrameMessage = {
  channel?: unknown;
  token?: unknown;
  kind?: unknown;
  actionId?: unknown;
  input?: unknown;
  height?: unknown;
  code?: unknown;
  formAction?: unknown;
  fieldName?: unknown;
  fieldType?: unknown;
  value?: unknown;
  submitted?: unknown;
};

type PanelDraft = {
  formAction: string;
  fieldName: string;
  fieldType: string;
  value: string | number | boolean;
};

const frameMessageFields = new Set([
  'channel',
  'token',
  'kind',
  'actionId',
  'input',
  'height',
  'code',
  'formAction',
  'fieldName',
  'fieldType',
  'value',
  'submitted',
]);
const draftFields = new Set(['formAction', 'fieldName', 'fieldType', 'value']);
const draftFieldTypes = new Set([
  'checkbox',
  'email',
  'hidden',
  'number',
  'radio',
  'search',
  'select-one',
  'tel',
  'text',
  'textarea',
  'url',
]);

function plainFrameMessage(value: unknown): value is FrameMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.keys(value).every((key) => frameMessageFields.has(key))
  );
}

function boundedJson(value: unknown): boolean {
  try {
    const encoded = JSON.stringify(value);
    return encoded !== undefined && encoded.length <= PACKAGE_PANEL_MESSAGE_LIMIT;
  } catch {
    return false;
  }
}

function panelDraft(value: unknown, actions: Set<string>): PanelDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.keys(value).some((key) => !draftFields.has(key))
  )
    return null;
  const draft = value as Record<string, unknown>;
  if (
    typeof draft.formAction !== 'string' ||
    !actions.has(draft.formAction) ||
    typeof draft.fieldName !== 'string' ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/u.test(draft.fieldName) ||
    ['__proto__', 'prototype', 'constructor'].includes(draft.fieldName) ||
    typeof draft.fieldType !== 'string' ||
    !draftFieldTypes.has(draft.fieldType) ||
    !['string', 'number', 'boolean'].includes(typeof draft.value) ||
    (typeof draft.value === 'number' && !Number.isFinite(draft.value)) ||
    (typeof draft.value === 'string' && draft.value.length > 8000) ||
    (draft.fieldType === 'checkbox' && typeof draft.value !== 'boolean') ||
    (draft.fieldType === 'number' && !(typeof draft.value === 'number' || draft.value === '')) ||
    (draft.fieldType === 'radio' && typeof draft.value !== 'string')
  )
    return null;
  return draft as PanelDraft;
}

const draftKey = (draft: Pick<PanelDraft, 'formAction' | 'fieldName' | 'fieldType'>) =>
  JSON.stringify([draft.formAction, draft.fieldName, draft.fieldType]);

function stableDocument(
  ref: MutableRefObject<{ key: string; value: PreparedPackagePanel } | undefined>,
  panel: RenderedPackagePanel
) {
  const key = JSON.stringify([panel.html, panel.css, panel.actions, panel.issue ?? null]);
  if (!ref.current || ref.current.key !== key)
    ref.current = {
      key,
      value: preparePackagePanel(panel.html, panel.css, panel.actions, panel.issue),
    };
  return ref.current.value;
}

export function PackagePanelFrame({ panel, disabled, onAction }: Props) {
  const preparedRef = useRef<{ key: string; value: PreparedPackagePanel } | undefined>(undefined);
  const prepared = stableDocument(preparedRef, panel);
  const frame = useRef<HTMLIFrameElement>(null);
  const actionLock = useRef(false);
  const mounted = useRef(true);
  const panelId = useRef(panel.id);
  const drafts = useRef(new Map<string, PanelDraft>());
  const disabledRef = useRef(disabled);
  const onActionRef = useRef(onAction);
  const [height, setHeight] = useState(PACKAGE_PANEL_MIN_HEIGHT);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [frameIssue, setFrameIssue] = useState('');
  disabledRef.current = disabled;
  onActionRef.current = onAction;
  if (panelId.current !== panel.id) {
    panelId.current = panel.id;
    drafts.current.clear();
  }

  const sendDisabled = useCallback(
    (value: boolean) => {
      if (!prepared.ok) return;
      frame.current?.contentWindow?.postMessage(
        { channel, token: prepared.token, kind: 'disabled', value },
        '*'
      );
    },
    [prepared]
  );
  const sendInit = useCallback(() => {
    if (!prepared.ok) return;
    frame.current?.contentWindow?.postMessage(
      {
        channel,
        token: prepared.token,
        kind: 'init',
        disabled: disabledRef.current || actionLock.current,
        drafts: [...drafts.current.values()],
      },
      '*'
    );
  }, [prepared]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: A new sanitized document owns fresh frame lifecycle state.
  useEffect(() => {
    setHeight(PACKAGE_PANEL_MIN_HEIGHT);
    setReady(false);
    setFrameIssue('');
    actionLock.current = false;
    setBusy(false);
  }, [prepared.ok ? prepared.token : prepared.issue]);

  useEffect(() => {
    sendDisabled(disabled || busy);
  }, [disabled, busy, sendDisabled]);

  useEffect(() => {
    if (!prepared.ok || ready) return;
    const timer = window.setTimeout(() => {
      setFrameIssue('패키지 패널을 불러오지 못했어요. 기본 상태와 행동을 사용해 주세요.');
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [prepared, ready]);

  useEffect(() => {
    if (!prepared.ok) return;
    const allowed = new Set(panel.actions);
    const receive = (event: MessageEvent<FrameMessage>) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null') return;
      const data: unknown = event.data;
      if (
        !plainFrameMessage(data) ||
        !boundedJson(data) ||
        data.channel !== channel ||
        data.token !== prepared.token
      )
        return;
      if (data.kind === 'ready') {
        setReady(true);
        setFrameIssue('');
        sendDisabled(disabledRef.current || actionLock.current);
        return;
      }
      if (data.kind === 'resize') {
        if (typeof data.height !== 'number' || !Number.isFinite(data.height)) return;
        setHeight(
          Math.max(PACKAGE_PANEL_MIN_HEIGHT, Math.min(PACKAGE_PANEL_MAX_HEIGHT, data.height))
        );
        return;
      }
      if (data.kind === 'issue') {
        setFrameIssue(
          data.code === 'PACKAGE_PANEL_INPUT_LIMIT'
            ? '패널 입력이 너무 길어요. 입력을 줄여 다시 시도해 주세요.'
            : '패널 입력 형식을 확인해 주세요. 입력한 내용은 패널 안에 유지돼요.'
        );
        return;
      }
      if (data.kind === 'draft') {
        const draft = panelDraft(
          {
            formAction: data.formAction,
            fieldName: data.fieldName,
            fieldType: data.fieldType,
            value: data.value,
          },
          allowed
        );
        if (!draft) {
          setFrameIssue('패널 입력 초안을 보관하지 못했어요. 입력 형식을 확인해 주세요.');
          return;
        }
        const next = new Map(drafts.current);
        next.set(draftKey(draft), draft);
        if (
          next.size > 100 ||
          !boundedJson({
            channel,
            token: '00000000-0000-0000-0000-000000000000',
            kind: 'init',
            disabled: false,
            drafts: [...next.values()],
          })
        ) {
          setFrameIssue('패널 입력 초안의 보관 한도를 넘었어요. 입력을 줄여 주세요.');
          return;
        }
        drafts.current = next;
        return;
      }
      if (
        data.kind !== 'action' ||
        typeof data.actionId !== 'string' ||
        !allowed.has(data.actionId) ||
        !boundedJson(data.input) ||
        (data.submitted !== undefined &&
          (!Array.isArray(data.submitted) ||
            data.submitted.length > 100 ||
            !boundedJson(data.submitted))) ||
        disabledRef.current ||
        actionLock.current
      )
        return;
      const submittedDrafts: PanelDraft[] = [];
      const submittedKeys = new Set<string>();
      const submittedValues = Array.isArray(data.submitted) ? data.submitted : [];
      for (const value of submittedValues) {
        const draft = panelDraft(value, allowed);
        if (!draft || draft.formAction !== data.actionId) return;
        const key = draftKey(draft);
        if (submittedKeys.has(key)) return;
        submittedKeys.add(key);
        submittedDrafts.push(draft);
      }
      actionLock.current = true;
      setBusy(true);
      setFrameIssue('');
      sendDisabled(true);
      const actionDocument = prepared;
      const actionPanelId = panel.id;
      const submitted = submittedDrafts.flatMap((draft) => {
        const key = draftKey(draft);
        const saved = drafts.current.get(key);
        return saved && JSON.stringify(saved.value) === JSON.stringify(draft.value)
          ? [{ key, saved: JSON.stringify(saved), draft }]
          : [];
      });
      void onActionRef
        .current(data.actionId, data.input)
        .then(() => {
          if (!mounted.current || panelId.current !== actionPanelId) return;
          const cleared: PanelDraft[] = [];
          for (const item of submitted) {
            const current = drafts.current.get(item.key);
            if (!current || JSON.stringify(current) !== item.saved) continue;
            drafts.current.delete(item.key);
            cleared.push(item.draft);
          }
          if (!cleared.length) return;
          const current = preparedRef.current?.value;
          if (!current?.ok) return;
          frame.current?.contentWindow?.postMessage(
            { channel, token: current.token, kind: 'clear-drafts', drafts: cleared },
            '*'
          );
        })
        .catch(() => {
          if (mounted.current && panelId.current === actionPanelId)
            setFrameIssue(
              '패널 행동을 반영하지 못했어요. 기본 상태와 행동에서 다시 시도해 주세요.'
            );
        })
        .finally(() => {
          if (!mounted.current || preparedRef.current?.value !== actionDocument) return;
          actionLock.current = false;
          setBusy(false);
          sendDisabled(disabledRef.current);
        });
    };
    window.addEventListener('message', receive);
    sendInit();
    return () => window.removeEventListener('message', receive);
  }, [panel.actions, panel.id, prepared, sendDisabled, sendInit]);

  if (!prepared.ok)
    return (
      <aside className="package-panel-fallback" role="status" aria-label={panel.title}>
        <strong>{panel.title}</strong>
        <span>{prepared.issue} 기본 상태와 행동을 사용해 주세요.</span>
      </aside>
    );

  return (
    <section className="package-panel-frame" aria-label={panel.title} aria-busy={!ready || busy}>
      <header>
        <h4>{panel.title}</h4>
        {busy && <small role="status">행동을 반영하고 있어요…</small>}
      </header>
      {!ready && !frameIssue && <p role="status">패키지 패널을 불러오고 있어요…</p>}
      {frameIssue && (
        <p className="package-panel-frame-issue" role="alert">
          {frameIssue}
        </p>
      )}
      {/* Authored JavaScript and media are deliberately outside this first UI boundary. */}
      <iframe
        key={prepared.token}
        ref={frame}
        className="package-panel-frame-content"
        title={`${panel.title} 패키지 패널`}
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        srcDoc={prepared.srcDoc}
        style={{ height }}
        onLoad={sendInit}
      />
    </section>
  );
}
