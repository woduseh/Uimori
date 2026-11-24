import { t, useI18n, translateMessage, formatNumber } from './i18n.js';
import { useRef, useState } from 'react';
import type { Usage } from '../core/types.js';
import type { Illustration, IllustrationUsageReport } from '../core/illustration.js';
import { api, labels } from './api.js';
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
          onError((cause as Error).message);
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

export function IllustrationPhases({
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
  const progress = illustrationProgress(items);
  return (
    <>
      <dl className="illustration-phases">
        {progress.phases.map((phase) => (
          <div key={phase.task}>
            <dt>{illustrationTaskNames[phase.task]}</dt>
            <dd className="ui-meta-row">
              <span>
                {phase.task === 'placement' && phase.status === 'completed' && progress.unresolved
                  ? t('visuals.m173')
                  : translateMessage(labels[phase.status] ?? phase.status)}
              </span>
              {phase.detail && <span>{phase.detail}</span>}
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
    </>
  );
}

export function IllustrationUsageReportView({
  report,
  items,
}: {
  report: IllustrationUsageReport;
  items: Illustration[];
}) {
  useI18n();
  const progress = illustrationProgress(items);
  return (
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
      <small className="illustration-usage-note">{t('visuals.m175')}</small>
    </>
  );
}
