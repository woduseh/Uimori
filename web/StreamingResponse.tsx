import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ResponseDisplayMode } from './presentation-settings.js';
import type {
  ResponseChunk,
  ResponseStreamPage,
  ResponseTaskKind,
} from '../core/response-stream.js';
import { api, ApiError } from './api.js';
import { PlainProse } from './Prose.js';

const active = (status?: string) => status === undefined || ['queued', 'running'].includes(status);

/** Mount the reader only after an explicit request to inspect an incomplete answer. */
export function PartialResponse({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="partial-response" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>일부 응답 보기</summary>
      {open && children}
    </details>
  );
}

type ResponseProps = {
  taskKind: ResponseTaskKind;
  taskId: string;
  taskStatus?: string;
  visible?: boolean;
};

/** Final answers belong to Source/helper messages, never to a completed transport stream. */
export function ResponseDisplay({ mode, ...props }: ResponseProps & { mode: ResponseDisplayMode }) {
  if (mode === 'stream') return <StreamingResponse {...props} />;
  if (active(props.taskStatus)) return null;
  if (props.taskStatus === 'completed') return <small role="status">결과 불러오는 중…</small>;
  return (
    <PartialResponse key={props.taskId}>
      <StreamingResponse {...props} settled />
    </PartialResponse>
  );
}

/** Durable cursor batches avoid an extra permanent HTTP/1 connection per visible task. */
export function StreamingResponse({
  taskKind,
  taskId,
  taskStatus,
  visible = true,
  settled = false,
}: ResponseProps & { settled?: boolean }) {
  const [chunks, setChunks] = useState<ResponseChunk[]>([]);
  const [status, setStatus] = useState('running');
  const [disconnected, setDisconnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const currentTaskStatus = useRef(taskStatus);
  currentTaskStatus.current = taskStatus;
  const shown = useRef(visible);
  shown.current = visible;
  const wake = useRef<() => void>(() => {});
  useEffect(() => {
    setChunks([]);
    setStatus('running');
    setDisconnected(false);
    setLoaded(false);
    const buffered: ResponseChunk[] = [];
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined,
      closed = false,
      terminal = false,
      polling = false,
      cursor = 0,
      failures = 0;
    const offsets = new Map<string, number>();
    const base = `/response-streams/${taskKind}/${encodeURIComponent(taskId)}`;
    const receive = (page: ResponseStreamPage) => {
      if (closed || terminal) return;
      if (page.taskKind !== taskKind || page.taskId !== taskId || !Array.isArray(page.chunks))
        throw new Error('RESPONSE_STREAM_IDENTITY_MISMATCH');
      const added: ResponseChunk[] = [];
      for (const chunk of page.chunks) {
        if (chunk.seq <= cursor) continue;
        const key = JSON.stringify([chunk.segment, chunk.attemptId]);
        if (
          !Number.isSafeInteger(chunk.seq) ||
          typeof chunk.text !== 'string' ||
          !Number.isSafeInteger(chunk.offset) ||
          chunk.offset !== (offsets.get(key) ?? 0) + chunk.text.length
        )
          throw new Error('RESPONSE_STREAM_OFFSET_MISMATCH');
        offsets.set(key, chunk.offset);
        cursor = chunk.seq;
        added.push(chunk);
      }
      // The parent replaces this view when its canonical message arrives. A completed
      // stream can arrive first; keep already displayed text during that handoff.
      if (settled) buffered.push(...added);
      else if (added.length) setChunks((old) => [...old, ...added]);
      setStatus(page.status);
      setDisconnected(false);
      failures = 0;
      if (page.status !== 'running' && !page.hasMore) {
        terminal = true;
        if (settled) setChunks([...buffered]);
        setLoaded(true);
        clearTimeout(timer);
      }
    };
    const retry = () => {
      if (closed || terminal || !shown.current || document.hidden) return;
      setDisconnected(true);
      clearTimeout(timer);
      timer = setTimeout(() => void poll(), Math.min(10000, 1200 * 2 ** Math.min(failures++, 3)));
    };
    const poll = async () => {
      if (closed || terminal || polling || !shown.current || document.hidden) return;
      clearTimeout(timer);
      polling = true;
      try {
        // Drain committed pages sequentially, then release the connection before the next poll.
        // Unmount aborts only this read; hiding pauses later reads without losing the cursor.
        let page: ResponseStreamPage;
        do {
          page = await api<ResponseStreamPage>(
            `${base}?after=${cursor}`,
            undefined,
            'GET',
            controller.signal
          );
          if (closed) return;
          const previousCursor = cursor;
          receive(page);
          if (page.hasMore && cursor === previousCursor)
            throw new Error('RESPONSE_STREAM_CURSOR_STALLED');
        } while (!terminal && page.hasMore && shown.current && !document.hidden);
        if (closed || terminal || !shown.current || document.hidden) return;
        timer = setTimeout(() => void poll(), 300);
      } catch (error) {
        if (closed) return;
        if (error instanceof ApiError && [401, 403].includes(error.status)) {
          terminal = true;
          setDisconnected(true);
          return;
        }
        if (error instanceof ApiError && error.status === 404) {
          let task = currentTaskStatus.current;
          if (task === undefined) {
            try {
              task = (
                await api<{ status: string }>(
                  taskKind === 'main'
                    ? `/runs/${encodeURIComponent(taskId)}`
                    : `/helper/tasks/${encodeURIComponent(taskId)}`,
                  undefined,
                  'GET',
                  controller.signal
                )
              ).status;
            } catch (cause) {
              if (cause instanceof ApiError && [401, 403, 404].includes(cause.status))
                task = 'missing';
            }
          }
          if (closed) return;
          if (!active(task)) {
            terminal = true;
            setStatus(task!);
            setLoaded(true);
            return;
          }
        } else if (error instanceof Error && error.message.startsWith('RESPONSE_STREAM_')) {
          terminal = true;
          setDisconnected(true);
          return;
        }
        retry();
      } finally {
        polling = false;
      }
    };
    const resume = () => {
      clearTimeout(timer);
      void poll();
    };
    wake.current = resume;
    void poll();
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    return () => {
      closed = true;
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
    };
  }, [taskKind, taskId, settled]);
  useEffect(() => {
    shown.current = visible;
    wake.current();
  }, [visible]);
  if (!chunks.length)
    return settled ? (
      <small role="status">
        {disconnected
          ? '일부 응답을 불러오지 못했어요. 연결을 확인해 주세요.'
          : loaded
            ? '표시할 일부 응답이 없어요.'
            : '일부 응답을 불러오는 중…'}
      </small>
    ) : null;
  const parts = new Map<string, string>();
  for (const chunk of chunks) {
    const key = `${chunk.segment}:${chunk.attemptId}`;
    parts.set(key, (parts.get(key) ?? '') + chunk.text);
  }
  return (
    <div
      className="streaming-response"
      aria-label={settled ? '일부 응답' : '생성 중인 응답'}
      data-status={status}
    >
      <small>
        {disconnected
          ? '연결을 확인하고 있어요 · 받은 내용은 유지해요'
          : settled
            ? '받은 응답 일부'
            : status === 'running'
              ? '작성 중…'
              : status === 'completed'
                ? '받은 응답'
                : '받은 응답 일부'}
      </small>
      {[...parts].map(([key, value]) => (
        <div className="streaming-text" key={key}>
          <PlainProse text={value} />
        </div>
      ))}
    </div>
  );
}
