import type { CodexContentWarningGate } from './useCodexContentWarning.js';
import { Dialog } from './Dialog.js';

export function CodexContentWarningDialog({ gate }: { gate: CodexContentWarningGate }) {
  const translation = gate.warning === 'translation';
  return (
    <Dialog
      open={gate.warning !== null}
      title="Codex에서 거절될 수 있어요"
      variant="confirmation"
      role="alertdialog"
      onClose={gate.cancelRequest}
    >
      <p>
        {translation
          ? '이 내용을 그대로 번역하면 성적으로 노골적인 표현이 포함될 가능성이 높아요.'
          : '이 요청을 이어서 작성하면 성적으로 노골적인 표현이 포함될 가능성이 높아요.'}
      </p>
      <p className="muted">
        Codex로 전송하면 공급자 정책에 따라 요청이 거절될 수 있어요. 이 안내는 전송을 막지 않아요.
      </p>
      <div className="form-actions">
        <button type="button" className="secondary" onClick={gate.cancelRequest}>
          취소
        </button>
        <button type="button" className="primary" onClick={gate.continueRequest}>
          그래도 Codex로 전송
        </button>
      </div>
    </Dialog>
  );
}
