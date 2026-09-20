import { useEffect, useState } from 'react';
import { api } from './api.js';
import { ExternalLinkIcon, LibraryIcon } from './ui-icons.js';
import license from '../LICENSE?raw';
import notices from '../THIRD_PARTY_NOTICES.md?raw';

export function AppAbout() {
  const [buildId, setBuildId] = useState('');
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly starts a fresh request after a failed health lookup.
  useEffect(() => {
    let active = true;
    setError(false);
    void api<{ buildId: string }>('/health')
      .then((result) => {
        if (active) setBuildId(result.buildId);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [refresh]);
  return (
    <section className="app-about" aria-label="Uimori 앱 정보">
      <div className="recovery-settings-brand">
        <LibraryIcon size={28} aria-hidden="true" />
        <div>
          <h3>Uimori</h3>
          <p className="muted">앱 정보 · 실행 버전과 라이선스</p>
        </div>
      </div>
      <div className="recovery-settings-row">
        <div>
          <strong>실행 버전</strong>
          <p className="muted">현재 서버의 빌드 식별자</p>
        </div>
        <code data-testid="app-build-id">{buildId || (error ? '확인 실패' : '확인 중…')}</code>
      </div>
      {error && (
        <p role="alert">
          실행 버전을 확인하지 못했어요.{' '}
          <button
            type="button"
            className="secondary"
            onClick={() => setRefresh((value) => value + 1)}
          >
            다시 확인
          </button>
        </p>
      )}
      <div className="recovery-settings-row">
        <div>
          <strong>라이선스</strong>
          <p className="muted">GNU Affero General Public License v3</p>
        </div>
        <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noreferrer">
          <ExternalLinkIcon size={16} aria-hidden="true" /> 전문 보기
        </a>
      </div>
      <div className="recovery-settings-row">
        <div>
          <strong>소스 저장소</strong>
          <p className="muted">Uimori 프로젝트 소스 코드</p>
        </div>
        <a href="https://github.com/woduseh/Uimori" target="_blank" rel="noreferrer">
          <ExternalLinkIcon size={16} aria-hidden="true" /> 소스 보기
        </a>
      </div>
      <details className="recovery-settings-disclosure">
        <summary>라이선스 전문</summary>
        <pre className="app-about-document">{license}</pre>
      </details>
      <details className="recovery-settings-disclosure">
        <summary>저작권·제3자 고지</summary>
        <pre className="app-about-document">{notices}</pre>
      </details>
      <section className="recovery-settings-note">
        <h3>보증 안내</h3>
        <p className="muted">
          보증 없이 제공돼요. 자세한 조건은 라이선스 전문에서 확인할 수 있어요.
        </p>
      </section>
    </section>
  );
}
