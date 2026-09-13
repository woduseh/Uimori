import { useEffect, useRef, useState } from 'react';
import type { RuntimeValue } from '../core/prompt-values.js';
import { api } from './api.js';
import { Dialog } from './Dialog.js';

type UpgradeVersion = {
  packageRevision: number;
  behaviorRevision: number;
  schemaVersion: number;
  stateRevision: number;
};
type Preview = {
  previewId: string;
  mode: 'preserve' | 'program';
  from: UpgradeVersion;
  to: UpgradeVersion;
  before: RuntimeValue;
  after: RuntimeValue;
  drawsCleared: true;
};
export type UpgradeTarget = {
  instanceId: string;
  title: string;
  packageRevision: number;
  stateRevision: number;
  sourceHash: string | null;
  canPreserve: boolean;
  canTransform: boolean;
};

export function PackageStateUpgrade({
  chatId,
  branchId,
  target,
  onClose,
  onApplied,
}: {
  chatId: string;
  branchId?: string;
  target: UpgradeTarget;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [mode, setMode] = useState<'preserve' | 'program'>(
    target.canTransform ? 'program' : 'preserve'
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [error, setError] = useState('');
  const attempt = useRef<AbortController | null>(null);
  const applyKey = useRef('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      attempt.current?.abort();
    };
  }, []);
  const endpoint = `/chats/${encodeURIComponent(chatId)}/package-behaviors/${encodeURIComponent(target.instanceId)}`;
  const command = {
    branchId,
    expectedPackageRevision: target.packageRevision,
    expectedStateRevision: target.stateRevision,
    expectedSourceHash: target.sourceHash,
    mode,
  };
  async function prepare() {
    if (attempt.current) return;
    const controller = new AbortController();
    attempt.current = controller;
    setBusy('preview');
    setError('');
    setPreview(null);
    try {
      const result = await api<Preview>(
        `${endpoint}/upgrade-preview`,
        command,
        'POST',
        controller.signal
      );
      if (mounted.current) {
        setPreview(result);
        applyKey.current = crypto.randomUUID();
      }
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      attempt.current = null;
      if (mounted.current) setBusy(null);
    }
  }
  async function apply() {
    if (!preview || attempt.current) return;
    const controller = new AbortController();
    attempt.current = controller;
    setBusy('apply');
    setError('');
    try {
      await api(
        `${endpoint}/upgrade`,
        { ...command, previewId: preview.previewId, idempotencyKey: applyKey.current },
        'POST',
        controller.signal
      );
      if (mounted.current) onApplied();
    } catch (e) {
      // An uncertain response retries the same preview/command; never create a new adoption key.
      if (mounted.current) setError((e as Error).message);
    } finally {
      attempt.current = null;
      if (mounted.current) setBusy(null);
    }
  }
  return (
    <Dialog open title="자료 상태 업데이트" onClose={() => busy !== 'apply' && onClose()}>
      <p>“{target.title}”의 기존 상태를 새 자료 정의로 옮겨요. 먼저 변경할 값을 확인해 주세요.</p>
      <label>
        업데이트 방법
        <select
          value={mode}
          disabled={!!busy}
          onChange={(e) => {
            setMode(e.target.value as 'preserve' | 'program');
            setPreview(null);
            setError('');
          }}
        >
          {target.canTransform && <option value="program">제작자의 상태 변환 사용</option>}
          {target.canPreserve && <option value="preserve">현재 상태 값 그대로 유지</option>}
        </select>
      </label>
      <p className="muted">
        이전 상태와 추첨 이력은 보존해요. 새 동작에서 참고하는 현재 추첨 값은 비워요. 원문은 바꾸지
        않아요.
      </p>
      {busy && (
        <p role="status">
          {busy === 'preview' ? '변경할 값을 계산하고 있어요…' : '확인한 상태를 적용하고 있어요…'}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {preview && (
        <section aria-label="상태 변경 비교">
          <p>
            자료 개정 {preview.from.packageRevision} → {preview.to.packageRevision}
          </p>
          <h3>변경 전</h3>
          <pre className="behavior-upgrade-json">{JSON.stringify(preview.before, null, 2)}</pre>
          <h3>적용할 상태</h3>
          <pre className="behavior-upgrade-json">{JSON.stringify(preview.after, null, 2)}</pre>
        </section>
      )}
      <div className="form-actions">
        <button type="button" className="secondary" disabled={busy === 'apply'} onClick={onClose}>
          닫기
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!!busy}
          onClick={() => void prepare()}
        >
          {preview ? '변경 내용 다시 계산' : '변경 내용 확인'}
        </button>
        {preview && (
          <button type="button" disabled={!!busy} onClick={() => void apply()}>
            확인한 상태로 업데이트
          </button>
        )}
      </div>
    </Dialog>
  );
}
