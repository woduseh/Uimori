import type { RisuPluginApiSupport, RisuPluginPreview } from '../core/risu-plugin.js';

const SUPPORT: Record<RisuPluginApiSupport, string> = {
  mapped: '대응 가능',
  unimplemented: '미구현',
  'out-of-scope': '제공하지 않음',
};

/** Reads a plugin's own declarations back to the user. Nothing runs while the file is read. */
export function RisuPluginReport({ preview }: { preview: RisuPluginPreview }) {
  const groups = (['out-of-scope', 'unimplemented', 'mapped'] as const)
    .map((support) => ({ support, apis: preview.apis.filter((api) => api.support === support) }))
    .filter((group) => group.apis.length);
  return (
    <section className="risu-import-summary" aria-label="플러그인 지원 범위">
      <h3>{preview.displayName}</h3>
      <small className="muted">
        플러그인 · API {preview.apiVersion}
        {preview.pluginVersion ? ` · 버전 ${preview.pluginVersion}` : ''} ·{' '}
        {Math.max(1, Math.round(preview.bytes / 1024))} KiB
      </small>
      <p className="muted">
        가져오는 동안에는 코드를 실행하지 않고 파일이 선언한 내용만 읽었어요. 가져온 뒤에는 이
        코드가 격리된 자료 행동으로만, 아래 안내가 말하는 범위에서 실행돼요.
      </p>
      {preview.updateUrl && <p className="muted">업데이트 주소: {preview.updateUrl}</p>}
      {preview.allowedIpc.length > 0 && (
        <p className="muted">선언한 플러그인 채널: {preview.allowedIpc.join(', ')}</p>
      )}
      {preview.arguments.length > 0 && (
        <dl>
          {preview.arguments.map((argument) => (
            <div key={argument.key}>
              <dt>
                {argument.key} · {argument.type}
              </dt>
              <dd>{argument.description || '설명 없음'}</dd>
            </div>
          ))}
        </dl>
      )}
      {groups.map((group) => (
        <details key={group.support} open={group.support !== 'mapped'}>
          <summary>
            {SUPPORT[group.support]} · {group.apis.length}개
          </summary>
          <ul>
            {group.apis.map((api) => (
              <li key={api.name}>
                <code>{api.name}</code> — {api.note}
              </li>
            ))}
          </ul>
        </details>
      ))}
      {preview.unknownApis.length > 0 && (
        <p className="muted">판정하지 않은 이름: {preview.unknownApis.join(', ')}</p>
      )}
      <small className="muted">
        {preview.name} · SHA-256 {preview.sha256.slice(0, 16)}…
      </small>
    </section>
  );
}
