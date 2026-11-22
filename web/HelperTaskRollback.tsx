import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Undo2 } from 'lucide-react';
import type { HelperChange, HelperRollbackUnit, HelperRollbackView } from '../core/helper.js';
import { api, definiteRejection } from './api.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { helperChangeLocationParts } from './helper-change-location.js';
import { formatNumber, t, translateMessage } from './i18n.js';
import { IconButton } from './IconButton.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { OUTLINE_REFRESH_EVENT } from './outline-helper.js';
import { useTransientNotice } from './TransientNotice.js';
import { hasUnsavedInput, useUnsavedInputVersion } from './unsaved-input.js';
import { useRetryableEffect } from './useRetryableEffect.js';

type Plan = { unit: string | null };

const coveredChange = (change: HelperChange) =>
  change.domain === 'resource' ||
  change.domain === 'outline' ||
  change.domain === 'notes' ||
  (change.domain === 'scene' && !change.targetId.endsWith(':title'));

export const rollbackCovers = (changes: readonly HelperChange[]) => changes.some(coveredChange);

const restorable = (unit: HelperRollbackUnit) => unit.status === 'restorable';
const unsaved = (unit: HelperRollbackUnit) => !!unit.touches && hasUnsavedInput(unit.touches);

function reasonText(unit: HelperRollbackUnit) {
  if (unit.status === 'restored') return t('helperRollback.alreadyRestored');
  if (unit.status === 'failed')
    return unit.error ? translateMessage(unit.error) : t('helperRollback.failed');
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
  window.dispatchEvent(new Event('uimori-helper-updated'));
  const touches = restored.flatMap((unit) => (unit.touches ? [unit.touches] : []));
  if (touches.some((touch) => touch.domain === 'resource' && touch.kind === 'theme'))
    window.dispatchEvent(new Event('uimori-themes-changed'));
  if (touches.some((touch) => touch.domain === 'resource' && touch.kind === 'illustration-preset'))
    window.dispatchEvent(new Event('uimori-illustration-presets-changed'));
  if (touches.some((touch) => touch.domain === 'outline'))
    window.dispatchEvent(new Event(OUTLINE_REFRESH_EVENT));
}

function merge(view: HelperRollbackView | null, units: readonly HelperRollbackUnit[]) {
  if (!view) return view;
  const updated = new Map(units.map((unit) => [unit.unit, unit]));
  return { ...view, units: view.units.map((unit) => updated.get(unit.unit) ?? unit) };
}

export function useHelperRollback({
  taskId,
  changes,
  enabled,
  unavailable,
}: {
  taskId: string;
  changes: readonly HelperChange[];
  enabled: boolean;
  unavailable: boolean;
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
  useEffect(() => {
    if (!enabled) return;
    addEventListener('uimori-helper-updated', retry);
    return () => removeEventListener('uimori-helper-updated', retry);
  }, [enabled, retry]);
  const wasUnavailable = useRef(unavailable);
  useEffect(() => {
    if (wasUnavailable.current && !unavailable) retry();
    wasUnavailable.current = unavailable;
  }, [unavailable]);
  const units = enabled ? (view?.units ?? []) : [];
  const blocked = unavailable || view?.blocked === 'task-active';
  const unitFor = (change: HelperChange) =>
    units.find((unit) => unit.changeTargetIds.includes(change.targetId));
  const firstChange = new Map<string, string>();
  for (const change of changes) {
    const unit = unitFor(change);
    if (unit && !firstChange.has(unit.unit)) firstChange.set(unit.unit, change.targetId);
  }
  const unitName = (unit: HelperRollbackUnit) => {
    const change = changes.find((item) => unit.changeTargetIds.includes(item.targetId));
    const title = change?.title ?? unit.title;
    if (unit.domain === 'outline') return `${title}, ${t('helperRollback.outline')}`;
    if (unit.domain === 'notes') return `${title}, ${t('helperRollback.notes')}`;
    if (unit.domain === 'scene' && change?.location && typeof change.location !== 'string') {
      const scene = helperChangeLocationParts(change.location)[0];
      return scene ? `${title}, ${scene.text}` : title;
    }
    return title;
  };
  const restorableUnits = units.filter(restorable);

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
  function selection(value: HelperRollbackView, target: Plan) {
    const selected =
      target.unit === null ? value.units : value.units.filter((unit) => unit.unit === target.unit);
    const restore = value.blocked
      ? []
      : selected.filter((unit) => restorable(unit) && !unsaved(unit));
    return {
      restore,
      drafts: selected.filter((unit) => restorable(unit) && unsaved(unit)),
      kept: selected.filter((unit) => !restorable(unit)),
      every: value.units.filter(restorable).length === restore.length,
    };
  }
  async function run() {
    if (!plan || !preview || lock.current || unavailable) return;
    const chosen = selection(preview, plan);
    if (!chosen.restore.length) return;
    lock.current = true;
    setRunning(true);
    setError('');
    setUnknown(false);
    const bodies =
      plan.unit === null && chosen.every
        ? [{}]
        : chosen.restore.map((unit) => ({ unit: unit.unit }));
    const results: HelperRollbackUnit[] = [];
    try {
      for (const body of bodies) results.push(...(await api<HelperRollbackView>(path, body)).units);
      const count = results.filter((unit) => unit.status === 'restored').length;
      if (alive.current && count) notify(t('helperRollback.done', { count: formatNumber(count) }));
    } catch (cause) {
      if (!alive.current) return;
      if (definiteRejection(cause)) {
        setError(cause instanceof Error ? cause.message : t('helperRollback.failed'));
        retry();
      } else setUnknown(true);
    } finally {
      refreshRestored(results);
      lock.current = false;
      if (alive.current) {
        if (results.length) setView((old) => merge(old, results));
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
    if (!unit || !restorable(unit) || firstChange.get(unit.unit) !== change.targetId) return null;
    return (
      <IconButton
        className="helper-change-open helper-rollback-unit"
        icon={Undo2}
        size={16}
        label={t('helperRollback.unitAction', { title: unitName(unit) })}
        disabled={blocked || running || unknown || unsaved(unit)}
        onClick={() => open(unit.unit)}
      />
    );
  }
  function status(change: HelperChange): ReactNode {
    const unit = unitFor(change);
    if (!unit) return null;
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
    const text = restorable(unit)
      ? unsaved(unit)
        ? t('helperRollback.unsaved')
        : ''
      : (unit.status === 'text-removed' && change.textRemoved) || unit.reason === 'other-domain'
        ? ''
        : reasonText(unit);
    return text ? (
      <p className="helper-result-note helper-rollback-status" data-status={unit.status}>
        {text}
      </p>
    ) : null;
  }

  const chosen = plan && preview ? selection(preview, plan) : null;
  const uncovered = changes.some((change) => !coveredChange(change));
  const imageNotice = chosen?.restore.some(
    (unit) => unit.touches?.domain === 'scene' && unit.touches.fields.includes('translation')
  );
  const footer = (
    <>
      {uncovered && <p className="helper-result-note">{t('helperRollback.uncovered')}</p>}
      {(restorableUnits.length > 1 || (blocked && restorableUnits.length > 0)) && (
        <div className="helper-rollback-row">
          {restorableUnits.length > 1 && (
            <button
              type="button"
              className="secondary"
              disabled={blocked || running || unknown}
              onClick={() => open(null)}
            >
              <Undo2 size={16} aria-hidden="true" />
              {t('helperRollback.taskAction')}
            </button>
          )}
          {blocked && <p className="helper-result-note">{t('helperRollback.taskActive')}</p>}
        </div>
      )}
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
      <ConfirmDialog
        open={!!plan}
        title={t('helperRollback.title')}
        message={t(plan?.unit ? 'helperRollback.unitMessage' : 'helperRollback.taskMessage')}
        action={
          plan?.unit || !chosen
            ? t('helperRollback.confirmUnit')
            : t('helperRollback.confirmTask', { count: formatNumber(chosen.restore.length) })
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
            error={previewFailed ? t('helperRollback.readFailed') : ''}
            label={t('helperRollback.reading')}
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
  return { action, status, footer };
}
