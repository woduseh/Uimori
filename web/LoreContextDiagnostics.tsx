import type { LoreContextSnapshot } from '../core/lore-context.js';
import './lore-context.css';

const reasons: Record<string, string> = {
  disabled: '조회 로어 유지 끔',
  'new-scene': '새 장면 요청으로 조회 로어 정리',
  'source-or-canon-changed': '원문이나 확정 설정 변경',
  'provided-as-pinned': '고정 자료로 제공되어 조회 사본 제외',
  'resource-scope-or-revision-changed': '자료의 사용 범위나 고정 버전 변경',
  'retention-budget': '조회 로어 예산에 맞춰 정리',
};

export function LoreContextDiagnostics({
  snapshot,
  reset = false,
  label = '조회 로어 유지 결과',
}: {
  snapshot?: LoreContextSnapshot;
  reset?: boolean;
  label?: string;
}) {
  if (!snapshot) return <p className="muted">이 실행에는 조회 로어 유지 기록이 없어요.</p>;
  return (
    <section className="lore-context-result" aria-label={label}>
      <h4>{label}</h4>
      <p className="muted">
        이 실행에 고정한 자료 범위예요. 문자 수는 UTF-16 기준이며 토큰 수와 달라요.
      </p>
      <dl className="lore-context-stats">
        <div>
          <dt>유지한 구간</dt>
          <dd>
            {snapshot.stats.retainedEntries.toLocaleString()} /{' '}
            {snapshot.policy.maxRetainedEntries.toLocaleString()}개
          </dd>
        </div>
        <div>
          <dt>유지한 문자</dt>
          <dd>
            {snapshot.stats.retainedChars.toLocaleString()} /{' '}
            {snapshot.policy.maxRetainedChars.toLocaleString()}자
          </dd>
        </div>
        <div>
          <dt>새로 더한 문자</dt>
          <dd>{snapshot.stats.appendedChars.toLocaleString()}자</dd>
        </div>
        <div>
          <dt>정리한 구간</dt>
          <dd>{snapshot.stats.droppedEntries.toLocaleString()}개</dd>
        </div>
        <div>
          <dt>고정 자료 한도</dt>
          <dd>{snapshot.policy.maxPinnedChars.toLocaleString()}자</dd>
        </div>
      </dl>
      {reset && <p>이 요청에서 새 장면 정리를 선택했어요.</p>}
      {snapshot.stats.reasons.length > 0 && (
        <ul className="lore-context-reasons">
          {snapshot.stats.reasons.map((reason) => (
            <li key={reason}>{reasons[reason] ?? reason}</li>
          ))}
        </ul>
      )}
      {!!snapshot.entries.length && (
        <details>
          <summary>유지한 로어와 읽은 출처 · {snapshot.entries.length}구간</summary>
          <ol className="lore-context-entries">
            {snapshot.entries.map((entry, index) => (
              <li key={`${entry.id}:${entry.revision}:${entry.start}:${entry.end}:${index}`}>
                <strong>{entry.title || entry.id}</strong>
                <span>
                  v{entry.revision} · UTF-16 {entry.start.toLocaleString()}–
                  {entry.end.toLocaleString()} · {entry.text.length.toLocaleString()}자
                </span>
                <small>
                  처음 읽은 원문 {entry.origin.sourceRevision} · Run {entry.origin.runId}
                </small>
                <details>
                  <summary>읽은 범위의 본문</summary>
                  <pre>{entry.text}</pre>
                </details>
              </li>
            ))}
          </ol>
        </details>
      )}
      <small className="muted">
        성공한 본문 창작의 자료 읽기만 이어 사용해요. 과거 도구 호출이나 응답을 재실행하지 않아요.
      </small>
    </section>
  );
}
