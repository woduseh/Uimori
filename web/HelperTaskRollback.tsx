import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Undo2 } from 'lucide-react';
import type { HelperChange, HelperRollbackUnit, HelperRollbackView } from '../core/helper.js';
import { isAppErrorCode } from '#contracts';
import { api, definiteRejection } from './api.js';
import { apiErrorDisplay } from './api-errors.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { helperChangeLocationParts } from './helper-change-location.js';
import { getIntlLocale, t, translateMessage, message as legacyDescriptor } from './i18n.js';
import { uiMessage } from './ui-message.js';
import { IconButton } from './IconButton.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { OUTLINE_REFRESH_EVENT } from './outline-helper.js';
import { useTransientNotice } from './TransientNotice.js';
import { hasUnsavedInput, useUnsavedInputVersion } from './unsaved-input.js';
import { useRetryableEffect } from './useRetryableEffect.js';
import { helperChange, helperDataFrame } from './live-frames.js';
import { announceLocalChange, useLiveRefresh } from './live-stream.js';
import { helperRefreshSpacing } from './poll-delays.js';

type Plan = { unit: string | null };

const coveredChange = (change: HelperChange) =>
  change.domain === 'resource' ||
  change.domain === 'outline' ||
  change.domain === 'notes' ||
  change.domain === 'chat-lore' ||
  (change.domain === 'scene' && !change.targetId.endsWith(':title'));

export const rollbackCovers = (changes: readonly HelperChange[]) => changes.some(coveredChange);

const uncoveredKindLabels = {
  settings: 'helperRollback.kindSettings',
  'scene-title': 'helperRollback.kindSceneTitle',
} as const;

export function uncoveredKinds(changes: readonly HelperChange[]) {
  const kinds = new Set(
    changes
      .filter((change) => !coveredChange(change))
      .map((change) => (change.domain === 'scene' ? 'scene-title' : 'settings'))
  );
  const labels = (['settings', 'scene-title'] as const)
    .filter((kind) => kinds.has(kind))
    .map((kind) => t(uncoveredKindLabels[kind]));
  return labels.length
    ? new Intl.ListFormat(getIntlLocale(), { type: 'conjunction' }).format(labels)
    : null;
}

const unitOwns = (unit: HelperRollbackUnit, change: HelperChange) =>
  unit.domain === change.domain && unit.changeTargetIds.includes(change.targetId);
const restorable = (unit: HelperRollbackUnit) => unit.status === 'restorable';
const unsaved = (unit: HelperRollbackUnit) =>
  !!unit.touches && unit.touches.domain !== 'resource' && hasUnsavedInput(unit.touches);

function reasonText(unit: HelperRollbackUnit) {
  if (unit.status === 'restored') return t('helperRollback.alreadyRestored');
  if (unit.status === 'failed') {
    if (unit.error && isAppErrorCode(unit.error))
      return apiErrorDisplay({ code: unit.error, params: unit.errorParams }, 409);
    return unit.error ? translateMessage(unit.error) : t('helperRollback.failed');
  }
  if (unit.reason === 'changed-after-task') return t('helperRollback.changedAfter');
  if (unit.reason === 'changed-during-task') return t('helperRollback.changedDuring');
  if (unit.reason === 'created') return t('helperRollback.created');
  if (unit.reason === 'expired') return t('helperRollback.expired');
  if (unit.reason === 'deleted')
    return t(unit.status === 'text-removed' ? 'helperRollback.removed' : 'helperRollback.deleted');
  if (unit.reason === 'recorded-before-rollback') return t('helperRollback.unrecorded');
  return t('helperRollback.otherDomain');
}

function refreshRestored(units: readonly HelperRollbackUnit[]) {
  const restored = units.filter((unit) => unit.status === 'restored');
  if (!restored.length) return;
  announceLocalChange(helperChange('task.rolled-back'), { echoed: true });
  const touches = restored.flatMap((unit) => (unit.touches ? [unit.touches] : []));
  for (const kind of ['theme', 'illustration-preset'] as const)
    if (touches.some((touch) => touch.domain === 'resource' && touch.kind === kind))
      announceLocalChange(helperChange(`${kind}.updated`), { echoed: true });
  if (touches.some((touch) => touch.domain === 'outline'))
    window.dispatchEvent(new Event(OUTLINE_REFRESH_EVENT));
}

export function rollbackSelection(value: HelperRollbackView, target: Plan) {
  const selected =
    target.unit === null ? value.units : value.units.filter((unit) => unit.unit === target.unit);
  const restore = value.blocked
    ? []
    : selected.filter((unit) => restorable(unit) && !unsaved(unit));
  const every = value.units.filter(restorable).length === restore.length;
  return {
    restore,
    drafts: selected.filter((unit) => restorable(unit) && unsaved(unit)),
    kept: selected.filter((unit) => !restorable(unit)),
    bodies: target.unit === null && every ? [{}] : restore.map((unit) => ({ unit: unit.unit })),
  };
}

export function mergeRollbackResults(
  view: HelperRollbackView | null,
  results: readonly HelperRollbackUnit[]
) {
  const settled = new Map(
    results.filter((unit) => unit.status !== 'failed').map((unit) => [unit.unit, unit])
  );
  if (!view || !settled.size) return view;
  return { ...view, units: view.units.map((unit) => settled.get(unit.unit) ?? unit) };
}

export function clearRollbackFailures(
  failures: Record<string, string>,
  units: readonly HelperRollbackUnit[]
) {
  return Object.fromEntries(
    Object.entries(failures).filter(([unit]) => !units.some((item) => item.unit === unit))
  );
}

export function recordRollbackFailures(
  failures: Record<string, string>,
  results: readonly HelperRollbackUnit[]
) {
  const failed = results.filter((unit) => unit.status === 'failed');
  if (!failed.length) return failures;
  return {
    ...failures,
    ...Object.fromEntries(failed.map((unit) => [unit.unit, unit.error ?? ''])),
  };
}

export function useHelperRollback({
  taskId,
  changes,
  enabled,
  unavailable,
  review,
}: {
  taskId: string;
  changes: readonly HelperChange[];
  enabled: boolean;
  unavailable: boolean;
  review: boolean;
}) {
  useUnsavedInputVersion();
  const [view, setView] = useState<HelperRollbackView | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [preview, setPreview] = useState<HelperRollbackView | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [running, setRunning] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [failures, setFailures] = useState<Record<string, string>>({});
  const notify = useTransientNotice();
  const alive = useRef(true);
  const lock = useRef(false);
  const path = `/helper/tasks/${encodeURIComponent(taskId)}/rollback`;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const retry = useRetryableEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    api<HelperRollbackView>(path, undefined, 'GET', controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setView(value);
        setReadFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setReadFailed(true);
      });
    return () => controller.abort();
  }, [path, enabled]);
  useLiveRefresh({
    enabled,
    match: helperDataFrame,
    refresh: async () => retry(),
    minIntervalMs: helperRefreshSpacing,
  });
  const wasUnavailable = useRef(unavailable);
  useEffect(() => {
    if (wasUnavailable.current && !unavailable) retry();
    wasUnavailable.current = unavailable;
  }, [unavailable]);
  const units = enabled ? (view?.units ?? []) : [];
  const blocked = unavailable || view?.blocked === 'task-active';
  const unitFor = (change: HelperChange) => units.find((unit) => unitOwns(unit, change));
  const firstChange = new Map<string, HelperChange>();
  for (const change of changes) {
    const unit = unitFor(change);
    if (unit && !firstChange.has(unit.unit)) firstChange.set(unit.unit, change);
  }
  const shownUnits = units.filter((unit) => firstChange.has(unit.unit));
  const unitName = (unit: HelperRollbackUnit) => {
    const change = firstChange.get(unit.unit);
    const title = change?.title ?? unit.title;
    if (unit.domain === 'outline') return `${title}, ${t('helperRollback.outline')}`;
    if (unit.domain === 'notes') return `${title}, ${t('helperRollback.notes')}`;
    if (unit.domain === 'chat-lore') return `${title}, ${t('helperRollback.kindChatLore')}`;
    if (unit.domain === 'scene' && change?.location && typeof change.location !== 'string') {
      const scene = helperChangeLocationParts(change.location)[0];
      return scene ? `${title}, ${scene.text}` : title;
    }
    return title;
  };
  const restorableUnits = shownUnits.filter(restorable);
  const restoredCount = shownUnits.filter((unit) => unit.status === 'restored').length;
  const reviewing = review && restorableUnits.length + restoredCount > 0;

  async function read(target: (value: HelperRollbackView) => void) {
    const value = await api<HelperRollbackView>(path, undefined, 'GET');
    if (!alive.current) return;
    setView(value);
    target(value);
  }
  function open(unit: string | null) {
    if (lock.current) return;
    setPlan({ unit });
    setPreview(null);
    setPreviewFailed(false);
    setError('');
    read(setPreview).catch(() => {
      if (alive.current) setPreviewFailed(true);
    });
  }
  async function run() {
    if (!plan || !preview || lock.current || unavailable) return;
    const chosen = rollbackSelection(preview, plan);
    if (!chosen.restore.length) return;
    lock.current = true;
    setRunning(true);
    setError('');
    setUnknown(false);
    setFailures((old) => clearRollbackFailures(old, chosen.restore));
    const results: HelperRollbackUnit[] = [];
    try {
      for (const body of chosen.bodies)
        results.push(...(await api<HelperRollbackView>(path, body)).units);
      const count = results.filter((unit) => unit.status === 'restored').length;
      if (alive.current && count) notify(uiMessage('helperRollback.done', { count }));
    } catch (cause) {
      if (!alive.current) return;
      if (definiteRejection(cause)) {
        setError(
          cause instanceof Error ? cause.message : legacyDescriptor('helperRollback.failed')
        );
        retry();
      } else setUnknown(true);
    } finally {
      refreshRestored(results);
      lock.current = false;
      if (alive.current) {
        setFailures((old) => recordRollbackFailures(old, results));
        setView((old) => mergeRollbackResults(old, results));
        setRunning(false);
        setPlan(null);
      }
    }
  }
  async function check() {
    setChecking(true);
    try {
      await read((value) => {
        setUnknown(false);
        refreshRestored(value.units);
      });
    } catch {
    } finally {
      if (alive.current) setChecking(false);
    }
  }

  function action(change: HelperChange): ReactNode {
    const unit = unitFor(change);
    if (!unit || !restorable(unit) || firstChange.get(unit.unit) !== change) return null;
    return (
      <IconButton
        className={`${reviewing ? '' : 'helper-change-open '}helper-rollback-unit`}
        icon={Undo2}
        size={16}
        label={t('helperRollback.unitAction', { title: unitName(unit) })}
        text={reviewing ? t('helperRollback.confirmUnit') : undefined}
        title={reviewing ? '' : undefined}
        disabled={blocked || running || unknown || unsaved(unit)}
        onClick={() => open(unit.unit)}
      />
    );
  }
  function status(change: HelperChange): ReactNode {
    const unit = unitFor(change);
    if (!unit || firstChange.get(unit.unit) !== change) return null;
    if (unit.status === 'restored')
      return (
        <p className="helper-result-note helper-rollback-status" data-status="restored">
          <Check size={16} aria-hidden="true" />
          <span>
            {t('helperRollback.restored')}
            {unit.notices?.includes('translation-images-not-restored') &&
              ` ${t('helperRollback.imagesKept')}`}
          </span>
        </p>
      );
    const failure = restorable(unit) ? failures[unit.unit] : undefined;
    const shown: HelperRollbackUnit =
      failure === undefined ? unit : { ...unit, status: 'failed', error: failure || undefined };
    const text = restorable(shown)
      ? unsaved(shown)
        ? t('helperRollback.unsaved')
        : ''
      : (shown.status === 'text-removed' && change.textRemoved) || shown.reason === 'other-domain'
        ? ''
        : reasonText(shown);
    return text ? (
      <p className="helper-result-note helper-rollback-status" data-status={shown.status}>
        {text}
      </p>
    ) : null;
  }

  const chosen = plan && preview ? rollbackSelection(preview, plan) : null;
  const uncovered = uncoveredKinds(changes);
  const imageNotice = chosen?.restore.some(
    (unit) => unit.touches?.domain === 'scene' && unit.touches.fields.includes('translation')
  );
  const taskAction = restorableUnits.length > 1 && (
    <button
      type="button"
      className="secondary"
      disabled={blocked || running || unknown}
      onClick={() => open(null)}
    >
      <Undo2 size={16} aria-hidden="true" />
      {t(reviewing ? 'helperRollback.allAction' : 'helperRollback.taskAction')}
    </button>
  );
  const taskActive = blocked && restorableUnits.length > 0 && (
    <p className="helper-result-note">{t('helperRollback.taskActive')}</p>
  );
  const notices = (
    <>
      {readFailed && (
        <NoticeBanner
          tone="error"
          actions={
            <button type="button" className="secondary" onClick={retry}>
              {t('helpers.m102')}
            </button>
          }
        >
          {t('helperRollback.readFailed')}
        </NoticeBanner>
      )}
      {unknown && (
        <NoticeBanner
          tone="error"
          actions={
            <button
              type="button"
              className="secondary"
              disabled={checking}
              aria-busy={checking}
              onClick={() => void check()}
            >
              {t('helperRollback.check')}
            </button>
          }
        >
          {t('helperRollback.unknown')}
        </NoticeBanner>
      )}
      {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
    </>
  );
  const strip = reviewing ? (
    <div
      className="helper-review-strip"
      role="group"
      aria-label={t('helperRollback.reviewLabel')}
      data-testid="helper-review-strip"
    >
      <div className="helper-rollback-row">
        <p className="helper-review-summary">
          <span>{t('helperRollback.savedCount', { count: shownUnits.length })}</span>
          {restoredCount > 0 && (
            <span>{t('helperRollback.restoredCount', { count: restoredCount })}</span>
          )}
        </p>
        {taskAction}
        {taskActive}
      </div>
      {notices}
    </div>
  ) : null;
  const footer = (
    <>
      {uncovered && (
        <p className="helper-result-note">{t('helperRollback.uncovered', { kinds: uncovered })}</p>
      )}
      {!reviewing && (taskAction || taskActive) && (
        <div className="helper-rollback-row">
          {taskAction}
          {taskActive}
        </div>
      )}
      {!reviewing && notices}
      <ConfirmDialog
        open={!!plan}
        title={t('helperRollback.title')}
        body={t(plan?.unit ? 'helperRollback.unitMessage' : 'helperRollback.taskMessage')}
        action={
          plan?.unit || !chosen
            ? t('helperRollback.confirmUnit')
            : t('helperRollback.confirmTask', { count: chosen.restore.length })
        }
        busy={running}
        disabled={!chosen?.restore.length || unavailable}
        onCancel={() => setPlan(null)}
        onConfirm={() => void run()}
      >
        <div className="helper-rollback-preview" data-testid="helper-rollback-preview">
          <LoadingState
            presentation="inline"
            loading={!preview && !previewFailed}
            error={previewFailed ? uiMessage('helperRollback.readFailed') : null}
            label={uiMessage('helperRollback.reading')}
            onRetry={() => open(plan?.unit ?? null)}
          />
          {chosen && (
            <>
              {(preview?.blocked || unavailable) && <p>{t('helperRollback.taskActive')}</p>}
              {chosen.restore.length > 0 ? (
                <section aria-label={t('helperRollback.restoreList')}>
                  <h3>{t('helperRollback.restoreList')}</h3>
                  <ul>
                    {chosen.restore.map((unit) => (
                      <li key={unit.unit}>{unitName(unit)}</li>
                    ))}
                  </ul>
                </section>
              ) : (
                !preview?.blocked && !unavailable && <p>{t('helperRollback.nothing')}</p>
              )}
              {chosen.drafts.length + chosen.kept.length > 0 && (
                <section aria-label={t('helperRollback.keepList')}>
                  <h3>{t('helperRollback.keepList')}</h3>
                  <ul>
                    {[...chosen.drafts, ...chosen.kept].map((unit) => (
                      <li key={unit.unit}>
                        <span>{unitName(unit)}</span>
                        <small>
                          {restorable(unit) ? t('helperRollback.unsaved') : reasonText(unit)}
                        </small>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {imageNotice && <p role="note">{t('helperRollback.imagesNotice')}</p>}
            </>
          )}
        </div>
      </ConfirmDialog>
    </>
  );
  return {
    unitKey: (change: HelperChange) => unitFor(change)?.unit ?? null,
    action,
    status,
    strip,
    footer,
  };
}
