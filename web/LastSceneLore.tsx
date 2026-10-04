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
  return (
    <section aria-label="마지막 장면에 포함된 로어">
      <p className="muted">
        마지막 장면의 마지막 본문 요청에 실제로 첨부한 로어 기록이에요. 다음 요청에서 쓸 로어는
        달라질 수 있어요.
      </p>
      <LazyDiagnostics<LastSceneLoreDetail>
        path={`/chats/${encodeURIComponent(chatId)}/last-scene-lore`}
        revision={headRevision ?? ''}
        title="포함 기록"
        initiallyOpen
      >
        {(detail) =>
          detail.sourceRevision === null ? (
            <p>아직 완성된 장면이 없어요.</p>
          ) : (
            <RequestLoreView lore={detail.lore} />
          )
        }
      </LazyDiagnostics>
    </section>
  );
}
