import { useEffect, useRef, useState } from 'react';
import { DownloadIcon } from './ui-icons.js';
import { sessionRequiredEvent } from './api.js';

const messages: Record<string, string> = {
  RISU_EXPORT_MODULE_UNSUPPORTED:
    '독립 모듈의 RISUM 내보내기는 지원하지 않아요. 자료 파일 가져오기·내보내기를 사용해 주세요.',
  RISU_EXPORT_LINKED_MODULES:
    '연결 모듈이 있는 자료는 아직 CHARX로 내보낼 수 없어요. 연결 자료를 함께 옮기려면 자료 파일 가져오기·내보내기를 사용해 주세요.',
  RISU_EXPORT_ASSET_UNAVAILABLE:
    '원문에 연결된 에셋 파일을 찾을 수 없어요. 에셋 탭에서 확인해 주세요.',
  RISU_EXPORT_ASSET_PATH: '원문 에셋의 파일 경로가 겹치거나 올바르지 않아요. 에셋을 확인해 주세요.',
  RISU_EXPORT_TOO_LARGE: '내보낼 자료가 파일 크기 한도를 넘었어요.',
  RISU_EXPORT_REVISION_CHANGED:
    '자료가 다른 곳에서 변경됐어요. 최신 저장본을 확인한 뒤 다시 내보내 주세요.',
};

export function RisuExportButton({
  kind,
  id,
  revision,
  title,
  disabled,
  onError,
}: {
  kind: 'content' | 'prompt-presets';
  id: string;
  revision: number;
  title: string;
  disabled?: boolean;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const format = kind === 'content' ? 'CHARX' : 'RISUP';
  return (
    <button
      type="button"
      className="secondary"
      disabled={disabled || busy}
      title={
        disabled
          ? '편집 내용을 저장한 뒤 내보내 주세요.'
          : '현재 저장본을 ' + format + ' 파일로 내보내기'
      }
      onClick={async () => {
        if (controller.current) return;
        const request = new AbortController();
        controller.current = request;
        setBusy(true);
        try {
          const response = await fetch(
            '/api/' +
              kind +
              '/' +
              encodeURIComponent(id) +
              '/risu-export?expectedRevision=' +
              revision,
            { signal: request.signal }
          );
          if (!response.ok) {
            if (response.status === 401) window.dispatchEvent(new Event(sessionRequiredEvent));
            const payload = (await response.json().catch(() => null)) as { error?: string } | null;
            throw new Error(
              messages[payload?.error ?? ''] ??
                '파일을 내보내지 못했어요. 저장본을 확인한 뒤 다시 시도해 주세요.'
            );
          }
          const blob = await response.blob();
          request.signal.throwIfAborted();
          const header = response.headers.get('Content-Disposition') ?? '';
          const name = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = name ? decodeURIComponent(name) : title + '.' + format.toLowerCase();
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (caught) {
          if (!request.signal.aborted) onError((caught as Error).message);
        } finally {
          if (!request.signal.aborted) setBusy(false);
          controller.current = null;
        }
      }}
    >
      <DownloadIcon size={18} aria-hidden="true" />
      {busy ? '내보내는 중…' : format + ' 내보내기'}
    </button>
  );
}
