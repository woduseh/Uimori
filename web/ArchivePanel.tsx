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
      <section className="archive-management-card" aria-label="백업과 복원">
        <div className="archive-card-heading">
          <div>
            <h3>백업 · 복원</h3>
            <p className="muted">작업실 전체 상태를 저장하거나 이전 백업으로 되돌려요.</p>
          </div>
        </div>
        <div className="archive-action-row">
          <div>
            <strong>작업실 전체 백업</strong>
            <p className="muted">자료·대화·이미지와 등록된 API 키를 DB 스냅샷으로 저장해요.</p>
          </div>
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
        </div>
        <details className="archive-restore-details">
          <summary>작업실 전체 복원</summary>
          <p className="muted">
            백업 DB를 UIMORI_DB 경로로 지정해 작업실 전체 상태를 복원해요. 확인 전까지 기존 DB는
            보관해 주세요.
          </p>
        </details>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </section>
      <ResourceBundleImport onImported={onImported} onDirtyChange={setResourceDirty} />
      <ChatBackupImport onImported={onImported} onDirtyChange={setChatDirty} disabled={busy} />
    </Container>
  );
}
