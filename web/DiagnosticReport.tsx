import { useEffect, useRef, useState } from 'react';
import type { DiagnosticReport as Report, DiagnosticScope } from '../core/diagnostic-report.js';
import { api, saveDownload } from './api.js';
import { Dialog } from './Dialog.js';
import { DownloadIcon } from './ui-icons.js';

/** Preview only the server's sharing projection, never the local Inspector payload. */
export function DiagnosticReport({
  scope,
  label = '문제 보고용 진단 만들기',
}: {
  scope: DiagnosticScope;
  label?: string;
}) {
  return <DiagnosticReportContent key={JSON.stringify(scope)} scope={scope} label={label} />;
}

function DiagnosticReportContent({ scope, label }: { scope: DiagnosticScope; label: string }) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const scopeKey = JSON.stringify(scope);
  useEffect(() => () => controller.current?.abort(), []);
  const close = () => {
    controller.current?.abort();
    controller.current = null;
    setOpen(false);
    setBusy(false);
    setReport(null);
  };
  async function generate() {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setOpen(true);
    setReport(null);
    setError('');
    setBusy(true);
    try {
      const result = await api<Report>('/diagnostics/report', scope, 'POST', request.signal);
      if (request.signal.aborted) return;
      setReport(result);
    } catch {
      if (!request.signal.aborted) setError('진단 보고서를 만들지 못했어요. 다시 시도해 주세요.');
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  }
  return (
    <>
      <button type="button" className="secondary" onClick={() => void generate()} disabled={busy}>
        {label}
      </button>
      <Dialog open={open} title="진단 보고서 미리보기" onClose={close} scopeKey={scopeKey} wide>
        <p>
          원문·프롬프트·키·자료 이름은 포함하지 않아요. 파일을 확인한 뒤 원하는 곳에 직접 공유해
          주세요.
        </p>
        <p className="muted">
          새 로그 수집과 상세 진단은 아직 제공하지 않아요. 기존 실행 기록에서 상태·오류 코드·수치만
          추려요.
        </p>
        {busy && <p role="status">진단 보고서를 만드는 중이에요…</p>}
        {error && <p role="alert">{error}</p>}
        {report && (
          <>
            <p role="status">
              {report.scope === 'system'
                ? '시스템 정보'
                : report.scope === 'run'
                  ? '선택한 실행'
                  : '선택한 채팅'}{' '}
              · 실행 {report.coverage.runs.included}개 · 요청 시도{' '}
              {report.coverage.attempts.included}개
            </p>
            {(report.coverage.runs.truncated || report.coverage.attempts.truncated) && (
              <p>크기 제한으로 오래된 항목 일부를 제외했어요.</p>
            )}
            <p className="muted">
              최신 순서로 표시해요. 보조 작업의 독립 진행 이력과 서버·브라우저 로그는 포함하지
              않아요.{report.scope === 'run' && ' 이 실행에 직접 연결된 요청 시도만 포함해요.'}
              {report.scope === 'system' && ' 채팅 내용과 실행 정보는 포함하지 않아요.'}
            </p>
            <details>
              <summary>파일 내용 확인</summary>
              <pre>{JSON.stringify(report, null, 2)}</pre>
            </details>
            <button
              type="button"
              className="primary"
              onClick={() => saveDownload('uimori-diagnostic-report.json', report)}
            >
              <DownloadIcon size={18} aria-hidden="true" /> 진단 JSON 다운로드
            </button>
          </>
        )}
        {error && (
          <button type="button" className="secondary" onClick={() => void generate()}>
            다시 시도
          </button>
        )}
      </Dialog>
    </>
  );
}
