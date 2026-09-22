import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import type {
  NativeTransferFile,
  NativeTransferPrepare,
  NativeTransferReceipt,
} from '../core/native-transfer.js';

export function ResourceBundleImport({
  onImported,
  onDirtyChange,
}: {
  onImported: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [selection, setSelection] = useState<{
    file: NativeTransferFile;
    preview: NativeTransferPrepare;
    key: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const serial = useRef(0);
  useEffect(() => {
    onDirtyChange?.(busy || !!selection);
  }, [busy, selection, onDirtyChange]);
  useEffect(
    () => () => {
      serial.current++;
    },
    []
  );
  return (
    <section className="archive-management-card" aria-label="자료 가져오기">
      <div className="archive-card-heading">
        <div>
          <h3>자료 가져오기</h3>
          <p className="muted">
            봇·페르소나·모듈·프리셋을 현재 작업실에 추가해요. 기존 자료는 유지돼요.
          </p>
        </div>
      </div>
      <input
        type="file"
        aria-label="Uimori 자료 백업 파일"
        accept="application/json,.json"
        disabled={busy}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          const current = ++serial.current;
          setSelection(undefined);
          setError('');
          setMessage('');
          if (!file) return;
          setBusy(true);
          try {
            if (file.size > 256 * 1024 * 1024)
              throw new Error('자료 백업은 256MiB 이하 파일을 사용해 주세요.');
            const value = JSON.parse(await file.text()) as NativeTransferFile;
            const preview = await api<NativeTransferPrepare>('/native-transfers/prepare', {
              file: value,
            });
            if (current === serial.current)
              setSelection({ file: value, preview, key: crypto.randomUUID() });
          } catch (caught) {
            if (current === serial.current) setError((caught as Error).message);
          } finally {
            if (current === serial.current) setBusy(false);
          }
        }}
      />
      {selection && (
        <p>
          {selection.preview.summary.contents}개 자료 · {selection.preview.summary.prompts}개 프리셋
          · {selection.preview.summary.images}개 이미지
        </p>
      )}
      <button
        type="button"
        disabled={!selection || busy}
        onClick={async () => {
          if (!selection || busy) return;
          setBusy(true);
          setError('');
          try {
            const result = await api<NativeTransferReceipt>('/native-transfers/apply', {
              file: selection.file,
              digest: selection.preview.digest,
              idempotencyKey: selection.key,
              modelBindings: [],
            });
            setSelection(undefined);
            setMessage(`${result.items.length}개 자료를 추가했어요.`);
            await onImported();
          } catch (caught) {
            setError((caught as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? '처리 중…' : '새 자료로 가져오기'}
      </button>
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
