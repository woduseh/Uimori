import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useCompactLayout } from './useCompactLayout.js';
import type { RisuContentSource } from '../core/risu-native.js';
import { api } from './api.js';
import { translateMessage, useI18n } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { RisuMessageSurface } from './RisuMessageSurface.js';
import { RunningIcon } from './ui-icons.js';
import { useWindowViewport } from './window-viewport.js';
import './risu-draft-preview.css';

const DRAFT_PREVIEW_DELAY_MS = 500;
const ignoreAction = async () => {};
let previewShownThisSession = true;

type Rendered = { html: string; css: string; issues: string[] };

export function useDraftPreviewShown() {
  const [shown, setShown] = useState(previewShownThisSession);
  const toggle = () => {
    previewShownThisSession = !shown;
    setShown(!shown);
  };
  return [shown, toggle] as const;
}

export function FirstMessageWorkspace({
  field,
  preview,
  shown,
}: {
  field: ReactNode;
  preview: ReactNode;
  shown: boolean;
}) {
  const { t } = useI18n();
  const compact = useCompactLayout();
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  if (!compact)
    return (
      <div className="native-greeting">
        {field}
        {shown && preview}
      </div>
    );
  return (
    <div className="native-greeting">
      <div className="segmented compact" role="group" aria-label={t('draftPreview.mode')}>
        <button type="button" aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>
          {t('native.text_d482e14b40')}
        </button>
        <button type="button" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>
          {t('native.text_2f1c9d7bd8')}
        </button>
      </div>
      {mode === 'edit' ? field : preview}
    </div>
  );
}

export function RisuDraftStartPreview({
  contentId,
  revision,
  native,
  text,
  surfaceKey,
}: {
  contentId: string;
  revision: number;
  native: RisuContentSource;
  text: string;
  surfaceKey: string;
}) {
  const { t } = useI18n();
  const viewport = useWindowViewport();
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [error, setError] = useState('');
  const [updating, setUpdating] = useState(true);
  const first = useRef(true);
  useEffect(() => {
    const controller = new AbortController();
    const delay = first.current ? 0 : DRAFT_PREVIEW_DELAY_MS;
    first.current = false;
    setUpdating(true);
    const timer = setTimeout(() => {
      void api<Rendered | { failure: string }>(
        `/content/${encodeURIComponent(contentId)}/risu-preview`,
        {
          revision,
          nativeRisu: native,
          text,
          ...(viewport ? { viewportWidth: viewport.width, viewportHeight: viewport.height } : {}),
        },
        'POST',
        controller.signal
      )
        .then((value) => {
          if (controller.signal.aborted) return;
          if ('failure' in value) {
            setError(value.failure);
            return;
          }
          setRendered(value);
          setError('');
        })
        .catch((caught: Error) => {
          if (!controller.signal.aborted) setError(caught.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setUpdating(false);
        });
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [contentId, revision, native, text, viewport]);
  if (!rendered)
    return (
      <section className="risu-draft-preview" aria-label={t('draftPreview.title')}>
        <LoadingState
          presentation="placeholder"
          loading={updating}
          error={translateMessage(error)}
          errorLabel={t('native.text_78102a76b6')}
          label={t('native.text_f7b0125b0b')}
        />
      </section>
    );
  return (
    <section
      className="risu-draft-preview"
      aria-label={t('draftPreview.title')}
      aria-busy={updating}
    >
      <div className="risu-draft-preview-status">
        <strong>{t('draftPreview.title')}</strong>
        {updating && (
          <span role="status">
            <RunningIcon size={14} className="activity-spinner" aria-hidden="true" />
            {t('draftPreview.updating')}
          </span>
        )}
      </div>
      {error && (
        <div className="risu-draft-preview-error" role="alert">
          <p>{t('native.text_78102a76b6')}</p>
          <p className="muted">{translateMessage(error)}</p>
        </div>
      )}
      <div className="risu-draft-preview-surface" data-stale={!!error || undefined}>
        <RisuMessageSurface
          html={rendered.html}
          css={rendered.css}
          revisionKey={surfaceKey}
          disabled
          onAction={ignoreAction}
        />
      </div>
      {rendered.issues.length > 0 && (
        <details className="risu-draft-preview-issues">
          <summary>{t('native.previewIssues', { count: rendered.issues.length })}</summary>
          <ul>
            {rendered.issues.map((issue) => (
              <li key={issue}>{translateMessage(issue)}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
