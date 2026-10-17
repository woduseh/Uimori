import { useEffect, useRef, useState } from 'react';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { api, apiBinary, definiteRejection } from './api.js';
import { NATIVE_ARCHIVE_MAX_BYTES, type NativeArchivePrepare } from '../core/native-archive.js';
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
    file?: NativeTransferFile;
    preparedId?: string;
    preview: NativeTransferPrepare;
    key: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const serial = useRef(0);
  const lock = useRef(false);
  const input = useRef<HTMLInputElement>(null);
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
    <section className="settings-group" aria-label="자료 가져오기">
      <header className="settings-group-heading archive-card-heading">
        <div>
          <h3>자료 가져오기</h3>
          <p className="muted">
            봇·페르소나·모듈·프리셋을 현재 작업실에 추가해요. 기존 자료는 유지돼요.
          </p>
        </div>
      </header>
      <div className="settings-group-body archive-management-card">
        <input
          ref={input}
          type="file"
          aria-label="Uimori 자료 백업 파일"
          accept="application/json,.json,application/zip,.uimori,.zip"
          disabled={busy || uncertain}
          onChange={async (event) => {
            if (lock.current || uncertain) return;
            const file = event.target.files?.[0];
            const current = ++serial.current;
            setSelection(undefined);
            setError('');
            setMessage('');
            if (!file) return;
            lock.current = true;
            setBusy(true);
            try {
              const archive = /\.(?:uimori|zip)$/iu.test(file.name);
              if (file.size > (archive ? NATIVE_ARCHIVE_MAX_BYTES : 256 * 1024 * 1024))
                throw new Error(
                  archive
                    ? '자료 백업은 512MiB 이하 파일을 사용해 주세요.'
                    : 'JSON 자료 백업은 256MiB 이하 파일을 사용해 주세요.'
                );
              if (archive) {
                const upload = await apiBinary<{ uploadId: string }>('/uploads', file);
                const preview = await api<NativeArchivePrepare>(
                  '/native-transfers/prepare-archive',
                  { uploadId: upload.uploadId }
                );
                if (current === serial.current)
                  setSelection({
                    preparedId: preview.preparedId,
                    preview,
                    key: crypto.randomUUID(),
                  });
                return;
              }
              const value = JSON.parse(await file.text()) as NativeTransferFile;
              const preview = await api<NativeTransferPrepare>('/native-transfers/prepare', {
                file: value,
              });
              if (current === serial.current)
                setSelection({ file: value, preview, key: crypto.randomUUID() });
            } catch (caught) {
              if (current === serial.current) setError((caught as Error).message);
            } finally {
              lock.current = false;
              if (current === serial.current) setBusy(false);
            }
          }}
        />
        {selection && (
          <p>
            {selection.preview.summary.contents}개 자료 · {selection.preview.summary.prompts}개
            프리셋 · {selection.preview.summary.images}개 이미지
          </p>
        )}
        {!!selection?.preview.modelRequirements.length && (
          <p>가져온 조언자의 모델 지정은 주 모델 따르기로 바뀌어요.</p>
        )}
        <button
          type="button"
          disabled={!selection || busy}
          onClick={async () => {
            if (!selection || lock.current) return;
            lock.current = true;
            setBusy(true);
            setError('');
            setMessage('');
            try {
              const result = await api<NativeTransferReceipt>(
                selection.preparedId
                  ? '/native-transfers/apply-archive'
                  : '/native-transfers/apply',
                {
                  ...(selection.preparedId
                    ? { preparedId: selection.preparedId }
                    : { file: selection.file }),
                  digest: selection.preview.digest,
                  idempotencyKey: selection.key,
                  modelBindings: [],
                }
              );
              setSelection(undefined);
              setUncertain(false);
              if (input.current) input.current.value = '';
              setMessage(`${result.items.length}개 자료를 추가했어요.`);
              try {
                await onImported();
              } catch (caught) {
                setError(
                  `자료는 추가했어요. 목록을 다시 불러오지 못했어요. ${(caught as Error).message}`
                );
              }
            } catch (caught) {
              setUncertain(uncertain || !definiteRejection(caught));
              setError((caught as Error).message);
            } finally {
              lock.current = false;
              setBusy(false);
            }
          }}
        >
          {busy ? '처리 중…' : uncertain ? '같은 요청으로 다시 확인' : '새 자료로 가져오기'}
        </button>
        {busy && <LoadingState presentation="inline" label="자료 백업을 처리하는 중이에요…" />}
        {uncertain && (
          <NoticeBanner>
            서버의 완료 여부를 확인하지 못했어요. 선택한 파일과 요청을 유지했어요. 같은 요청으로
            다시 확인해 주세요.
          </NoticeBanner>
        )}
        {message && <NoticeBanner>{message}</NoticeBanner>}
        {error && <NoticeBanner tone="error">{error}</NoticeBanner>}
      </div>
    </section>
  );
}
