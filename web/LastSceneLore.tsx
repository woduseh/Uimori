import { t, useI18n } from './i18n.js';
import type { LastSceneLoreDetail } from '../core/scene-usage.js';
import { LazyDiagnostics } from './LazyDiagnostics.js';
import { RequestLoreView } from './AttemptInspector.js';

export function LastSceneLore({
  chatId,
  headRevision,
}: {
  chatId: string;
  headRevision: string | null;
}) {
  useI18n();
  return (
    <section aria-label={t('library.loreIncludedInTheLastScene')}>
      <LazyDiagnostics<LastSceneLoreDetail>
        path={`/chats/${encodeURIComponent(chatId)}/last-scene-lore`}
        revision={headRevision ?? ''}
        title={t('library.inclusionRecords')}
        initiallyOpen
        disclosure={false}
      >
        {(detail) =>
          detail.sourceRevision === null ? (
            <p>{t('library.noCompletedScenesYet')}</p>
          ) : (
            <RequestLoreView lore={detail.lore} />
          )
        }
      </LazyDiagnostics>
    </section>
  );
}
