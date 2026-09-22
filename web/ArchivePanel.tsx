import { useEffect, useState } from 'react';
import { ChatBackupImport } from './ChatBackupImport.js';
import { ResourceBundleImport } from './ResourceBundleImport.js';
import { DownloadIcon } from './ui-icons.js';

export function ArchivePanel({
  onImported,
  onError,
  onDirtyChange,
  expanded = false,
}: {
  onImported: () => Promise<void>;
  onError: (error: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  expanded?: boolean;
  active?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [chatDirty, setChatDirty] = useState(false);
  const [resourceDirty, setResourceDirty] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    onDirtyChange?.(busy || chatDirty || resourceDirty);
  }, [busy, chatDirty, resourceDirty, onDirtyChange]);
  const Container = expanded ? 'section' : 'details';
  return (
    <Container
      className={expanded ? 'archive-settings' : 'workspace-tools'}
      data-testid="archive-panel"
      aria-label="백업과 가져오기"
    >
      {!expanded && <summary>내보내기와 복원</summary>}
      <section aria-label="데이터베이스 백업">
        <h3>작업실 전체 백업</h3>
        <p>
          DB 스냅샷에는 자료·대화·이미지와 앱에 등록한 API 키가 들어 있어요. 개인 보관용 파일이에요.
        </p>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            onError('');
            try {
              const response = await fetch('/api/backup');
              if (!response.ok) throw new Error(`백업을 만들지 못했어요. (${response.status})`);
              const url = URL.createObjectURL(await response.blob());
              const link = document.createElement('a');
              link.href = url;
              link.download = 'uimori-backup.sqlite';
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch (caught) {
              setError((caught as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <DownloadIcon size={18} aria-hidden="true" />
          {busy ? '백업 준비 중…' : 'DB 스냅샷 다운로드'}
        </button>
        <details>
          <summary>DB 스냅샷으로 복원하기</summary>
          <p>
            서버를 종료하고 백업 파일을 새 경로에 놓은 뒤 UIMORI_DB로 그 경로를 지정해 시작해요.
            확인이 끝날 때까지 기존 DB는 별도로 보관해요.
          </p>
        </details>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </section>
      <ResourceBundleImport onImported={onImported} onDirtyChange={setResourceDirty} />
      <section>
        <h3>이어 쓸 채팅 가져오기</h3>
        <p>
          메시지·번역·이미지·메모·변수와 연결 자료를 새 채팅으로 복원해요. 분기는 각각 독립 사본이
          돼요.
        </p>
        <ChatBackupImport onImported={onImported} onDirtyChange={setChatDirty} disabled={busy} />
      </section>
    </Container>
  );
}
