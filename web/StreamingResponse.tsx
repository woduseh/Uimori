import { useEffect, useRef, useState } from 'react';
import type {
  ResponseChunk,
  ResponseStreamPage,
  ResponseTaskKind,
} from '../core/response-stream.js';
import { api, ApiError } from './api.js';
import { PlainProse } from './Prose.js';

const active = (status?: string) =>
  status === undefined || ['queued', 'running', 'waiting_for_state'].includes(status);

/** Durable cursor batches avoid an extra permanent HTTP/1 connection per visible task. */
export function StreamingResponse({
  taskKind,
  taskId,
  taskStatus,
}: {
  taskKind: ResponseTaskKind;
  taskId: string;
  taskStatus?: string;
}) {
  const [chunks, setChunks] = useState<ResponseChunk[]>([]);
  const [status, setStatus] = useState('running');
  const [disconnected, setDisconnected] = useState(false);
  const currentTaskStatus = useRef(taskStatus);
  currentTaskStatus.current = taskStatus;
  useEffect(() => {
    setChunks([]);
    setStatus('running');
    setDisconnected(false);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined,
      closed = false,
      terminal = false,
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
      if (added.length) setChunks((old) => [...old, ...added]);
      setStatus(page.status);
      setDisconnected(false);
      failures = 0;
      if (page.status !== 'running' && !page.hasMore) {
        terminal = true;
        clearTimeout(timer);
      }
    };
    const retry = () => {
      if (closed || terminal) return;
      setDisconnected(true);
      clearTimeout(timer);
      timer = setTimeout(() => void poll(), Math.min(10000, 1200 * 2 ** Math.min(failures++, 3)));
    };
    const poll = async () => {
      if (closed || terminal) return;
      try {
        // Drain committed pages sequentially, then release the connection before the next poll.
        // A view closing aborts only its current read; it never cancels provider work.
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
        } while (!terminal && page.hasMore);
        if (closed || terminal) return;
        timer = setTimeout(() => void poll(), 300);
      } catch (error) {
        if (closed) return;
        if (error instanceof ApiError && [401, 403].includes(error.status)) {
          terminal = true;
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
            return;
          }
        } else if (error instanceof Error && error.message.startsWith('RESPONSE_STREAM_')) {
          terminal = true;
          setDisconnected(true);
          return;
        }
        retry();
      }
    };
    void poll();
    return () => {
      closed = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [taskKind, taskId]);
  if (!chunks.length) return null;
  const parts = new Map<string, string>();
  for (const chunk of chunks) {
    const key = `${chunk.segment}:${chunk.attemptId}`;
    parts.set(key, (parts.get(key) ?? '') + chunk.text);
  }
  return (
    <div className="streaming-response" aria-label="생성 중인 응답" data-status={status}>
      <small>
        {disconnected
          ? '연결을 확인하고 있어요 · 받은 내용은 유지해요'
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
