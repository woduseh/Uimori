import { t, useI18n, translateMessage, formatNumber } from './i18n.js';
import { useRef, useState } from 'react';
import type { Usage } from '../core/types.js';
import type { Illustration, IllustrationUsageReport } from '../core/illustration.js';
import { api, labels } from './api.js';
import { LazyDiagnostics } from './LazyDiagnostics.js';
import { illustrationProgress, illustrationTaskNames } from './illustration-progress.js';
import './illustrations.css';

export function IllustrationUsageLine({ usage }: { usage: Usage }) {
  useI18n();
  return (
    <p className="illustration-usage">
      {t('visuals.usageLine', {
        calls: formatNumber(usage.modelCalls),
        input: usage.inputTokens == null ? t('visuals.m165') : formatNumber(usage.inputTokens),
        output: usage.outputTokens == null ? t('visuals.m165') : formatNumber(usage.outputTokens),
      })}
    </p>
  );
}

export function IllustrationPlacementButton({
  sourceId,
  sourceHash,
  pending,
  refresh,
  onError,
}: {
  sourceId: string;
  sourceHash: string;
  pending: boolean;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  useI18n();
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="secondary"
      disabled={pending || busy}
      title={t('visuals.m168')}
      onClick={async () => {
        if (locked.current) return;
        locked.current = true;
        setBusy(true);
        try {
          await api(`/sources/${sourceId}/illustration-placement`, {
            expectedSourceHash: sourceHash,
          });
          await refresh();
        } catch (cause) {
          onError(translateMessage((cause as Error).message));
        } finally {
          locked.current = false;
          setBusy(false);
        }
      }}
    >
      {pending || busy ? t('visuals.m169') : t('visuals.m170')}
    </button>
  );
}

export function IllustrationActivity({
  items,
  sourceId,
  sourceHash,
  refresh,
  onError,
}: {
  items: Illustration[];
  sourceId: string;
  sourceHash: string;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  useI18n();
  if (!items.length) return null;
  const progress = illustrationProgress(items);
  const revision = items.map((item) => `${item.id}:${item.status}:${item.updatedAt}`).join('|');
  return (
    <section className="job illustration-job" aria-label={t('visuals.m171')}>
      <h3>
        {t('visuals.m098')}{' '}
        <small>
          {progress.status === 'partial'
            ? t('visuals.m172')
            : translateMessage(labels[progress.status] ?? progress.status)}
        </small>
      </h3>
      <dl className="illustration-phases">
        {progress.phases.map((phase) => (
          <div key={phase.task}>
            <dt>{illustrationTaskNames[phase.task]}</dt>
            <dd>
              {phase.task === 'placement' && phase.status === 'completed' && progress.unresolved
                ? t('visuals.m173')
                : translateMessage(labels[phase.status] ?? phase.status)}
              {phase.detail && ` · ${phase.detail}`}
            </dd>
          </div>
        ))}
      </dl>
      {progress.unresolved > 0 && (
        <IllustrationPlacementButton
          sourceId={sourceId}
          sourceHash={sourceHash}
          pending={items.some(
            (item) => item.task === 'placement' && ['queued', 'running'].includes(item.status)
          )}
          refresh={refresh}
          onError={onError}
        />
      )}
      <LazyDiagnostics<IllustrationUsageReport>
        path={`/sources/${sourceId}/illustration-usage`}
        revision={revision}
        title={t('visuals.m174')}
      >
        {(report) => (
          <>
            <IllustrationUsageLine usage={report.total} />
            <dl className="illustration-phases">
              {progress.phases.map(({ task }) => (
                <div key={task}>
                  <dt>{illustrationTaskNames[task]}</dt>
                  <dd>
                    <IllustrationUsageLine usage={report.stages[task]} />
                  </dd>
                </div>
              ))}
            </dl>
            <small>{t('visuals.m175')}</small>
          </>
        )}
      </LazyDiagnostics>
    </section>
  );
}
