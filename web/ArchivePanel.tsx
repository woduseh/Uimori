import { useState } from 'react';
import { api, saveDownload } from './api.js';

export function ArchivePanel({
  onImported,
  onError,
  expanded = false,
}: {
  onImported: () => Promise<void>;
  onError: (error: string) => void;
  expanded?: boolean;
}) {
  const [archive, setArchive] = useState<unknown>(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    onError('');
    setMessage('');
    try {
      await work();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const Container = expanded ? 'section' : 'details';
  return (
    <Container className={expanded ? 'archive-settings' : 'workspace-tools'}>
      {expanded ? (
        <p className="muted">원문·분기·자료·파생물을 내보내거나 복원해요.</p>
      ) : (
        <summary>
          내보내기와 복원 <small>원문 · 분기 · 자료 · 파생물</small>
        </summary>
      )}
      <div className="form-actions">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            void perform(async () => {
              const result = await api('/export');
              saveDownload('narrative-archive.json', result);
              setMessage('JSON 내보내기를 준비했어요.');
            });
          }}
        >
          JSON 내보내기
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            void perform(async () => {
              const response = await fetch('/api/backup');
              if (!response.ok) throw new Error(`백업을 만들지 못했어요. (${response.status})`);
              const url = URL.createObjectURL(await response.blob());
              const anchor = document.createElement('a');
              anchor.href = url;
              anchor.download = 'narrative-backup.sqlite';
              anchor.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
              setMessage('일관된 SQLite 백업을 준비했어요.');
            });
          }}
        >
          SQLite 백업 다운로드
        </button>
      </div>
      <p className="muted">
        복원은 새 빈 데이터베이스에서 진행해요. 이미 자료가 있는 DB는 서버가 거절해요. SQLite 백업은
        서버를 종료하고 새 NR_DB 경로에 보관해 다시 열 수 있어요.
      </p>
      <form
        className="editor-grid"
        onSubmit={(event) => {
          event.preventDefault();
          if (!archive) return;
          void perform(async () => {
            await api('/import', { archive });
            await onImported();
            setArchive(null);
            setFileName('');
            setMessage('빈 DB에 가져오기를 완료했어요.');
          });
        }}
      >
        <label className="full">
          가져올 JSON 파일
          <input
            aria-label="가져올 JSON 파일"
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) {
                setArchive(null);
                setFileName('');
                return;
              }
              setFileName(file.name);
              void file
                .text()
                .then((text) => {
                  setArchive(JSON.parse(text));
                  onError('');
                })
                .catch(() => {
                  setArchive(null);
                  onError('유효한 JSON 아카이브를 선택해 주세요.');
                });
            }}
          />
        </label>
        <div className="form-actions full">
          <button disabled={busy || !archive}>빈 DB에 가져오기</button>
          <small>{fileName}</small>
        </div>
      </form>
      <p role="status">{message}</p>
    </Container>
  );
}
