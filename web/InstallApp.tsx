import { useState, useSyncExternalStore } from 'react';
import { Check, Download } from 'lucide-react';
import { installSnapshot, installServerSnapshot, promptInstall, subscribeInstall } from './pwa.js';

export function InstallApp() {
  const state = useSyncExternalStore(subscribeInstall, installSnapshot, installServerSnapshot);
  const [busy, setBusy] = useState(false);
  return (
    <section className="settings-service" aria-label="앱 설치">
      <div className="settings-service-row">
        <div className="settings-service-copy">
          <h4>앱 설치</h4>
          <p className="muted">홈 화면에서 앱처럼 열어요. 서버 연결이 필요해요.</p>
        </div>
        {state.installed ? (
          <span className="settings-inline-status" role="status">
            <Check size={16} aria-hidden="true" /> 설치됨
          </span>
        ) : state.available ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void promptInstall().finally(() => setBusy(false));
            }}
          >
            <Download size={16} aria-hidden="true" /> {busy ? '설치 중…' : 'Uimori 설치'}
          </button>
        ) : null}
      </div>
      {!state.installed && !state.available && (
        <p className="muted">
          {isSecureContext
            ? '브라우저 메뉴에서 앱 설치 또는 홈 화면에 추가를 선택해 주세요.'
            : 'HTTPS 또는 localhost에서 설치할 수 있어요.'}
        </p>
      )}
      {state.error && (
        <p role="alert" className="error">
          {state.error}
        </p>
      )}
    </section>
  );
}
