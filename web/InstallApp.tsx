import { useState, useSyncExternalStore } from 'react';
import { Download, Smartphone } from 'lucide-react';
import { installSnapshot, installServerSnapshot, promptInstall, subscribeInstall } from './pwa.js';

export function InstallApp() {
  const state = useSyncExternalStore(subscribeInstall, installSnapshot, installServerSnapshot);
  const [busy, setBusy] = useState(false);
  return (
    <section className="settings-card" aria-label="앱 설치">
      <h3>
        <Smartphone size={18} aria-hidden="true" /> 앱 설치
      </h3>
      <p>
        홈 화면이나 작업 표시줄에서 Uimori를 독립된 창으로 열어요. 같은 서버의 원고와 설정을 그대로
        사용해요.
      </p>
      {state.installed ? (
        <p role="status">설치된 앱으로 사용 중이거나 설치가 확인됐어요.</p>
      ) : state.available ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void promptInstall().finally(() => setBusy(false));
          }}
        >
          <Download size={16} aria-hidden="true" /> Uimori 설치
        </button>
      ) : (
        <p className="muted">
          브라우저 메뉴의 앱 설치 또는 홈 화면에 추가를 사용해 주세요. iPhone·iPad에서는 공유
          메뉴에서 홈 화면에 추가한 뒤 아이콘으로 열어요.
        </p>
      )}
      {!isSecureContext && (
        <p className="muted">앱 설치에는 HTTPS 주소 또는 이 기기의 localhost 접속이 필요해요.</p>
      )}
      {state.error && (
        <p role="alert" className="error">
          {state.error}
        </p>
      )}
      <p className="muted">
        설치는 오프라인 원고 저장이 아니에요. 서버 연결이 필요하고, 연결이 끊겼을 때 작성 요청을
        큐에 넣거나 자동 전송하지 않아요.
      </p>
    </section>
  );
}
