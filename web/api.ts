export async function api<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(`/api${path}`, body === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) {
    if (response.status === 409) throw new Error('다른 요청이 먼저 반영됐어요. 최신 내용을 확인한 뒤 다시 시도해 주세요.');
    const message = response.status >= 500 ? '서버 작업을 완료하지 못했어요.' : '요청을 처리할 수 없어요.';
    throw new Error(`${message} (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export const labels: Record<string, string> = { queued: '대기', running: '진행 중', completed: '완료', failed: '실패', cancelled: '취소됨', interrupted: '서버 중단 · 자동 재생성 안 함', stale: '이전 자료의 결과', refused: '공급자 거절', partial: '부분 결과' };

export function saveDownload(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
