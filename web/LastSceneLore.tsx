import { readerEndpoints } from '#contracts';
import { t, useI18n } from './i18n.js';
import type { LastSceneLoreDetail } from '../core/scene-usage.js';
import { LazyDiagnostics } from './LazyDiagnostics.js';
import { endpointRecord, type RecordSource } from './useApiRecord.js';
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
        source={
          endpointRecord(readerEndpoints.readLastSceneLore, {
            chatId,
          }) as RecordSource<LastSceneLoreDetail>
        }
        revision={headRevision ?? ''}
        title={t('library.inclusionRecords')}
        initiallyOpen
        disclosure={false}
      >
        {(detail) =>
          detail.sourceRevision === null ? (
            <p>{t('library.noCompletedScenesYet')}</p>
          ) : (
            <RequestLoreView lore={detail.lore} heading={false} />
          )
        }
      </LazyDiagnostics>
    </section>
  );
}
