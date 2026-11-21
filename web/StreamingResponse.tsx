import { t, useI18n } from './i18n.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ResponseDisplayMode } from './presentation-settings.js';
import type {
  ResponseChunk,
  ResponseStreamPage,
  ResponseTaskKind,
} from '../core/response-stream.js';
import { api, apiEvents, ApiError } from './api.js';
import { PlainProse, Prose } from './Prose.js';
import { HelperMessageProse } from './HelperMessageProse.js';
import { splitCompletedParagraphs } from '../core/reading-markdown.js';
import { LoadingState } from './LoadingState.js';
import { parseStoryUi } from '../core/story-ui.js';
import { StoryUi } from './LazyStoryUi.js';

type StoryStyle = import('../core/story-ui-style.js').StoryUiStyleSetting;

type StreamingStoryProps = { text: string; style?: StoryStyle; runId?: string };

function StreamingStoryBlock({ text, style, runId }: StreamingStoryProps) {
  const [preview, setPreview] = useState('');
  useEffect(() => {
    if (!text.startsWith('<a2ui>') || !text.endsWith('</a2ui>')) return;
    const controller = new AbortController();
    void api<{ text: string }>('/story-ui/preview', { text, runId }, 'POST', controller.signal)
      .then((result) => setPreview(result.text))
      .catch(() => {});
    return () => controller.abort();
  }, [text, runId]);
  const part = parseStoryUi(preview).find((entry) => entry.kind === 'ui');
  return part?.kind === 'ui' ? <StoryUi segment={part} style={style} /> : null;
}

function streamingParagraphs(text: string, finished: boolean) {
  return finished ? { complete: text, pending: '' } : splitCompletedParagraphs(text);
}

function PendingParagraph({ text }: { text: string }) {
  return text ? (
    <p className="streaming-pending">
      <PlainProse text={text} />
    </p>
  ) : null;
}

function StreamingProse({ text, finished }: { text: string; finished: boolean }) {
  const { complete, pending } = streamingParagraphs(text, finished);
  return (
    <>
      {complete && <Prose text={complete} />}
      <PendingParagraph text={pending} />
    </>
  );
}

function StreamingHelperText({ text, finished }: { text: string; finished: boolean }) {
  const { complete, pending } = streamingParagraphs(text, finished);
  return (
    <HelperMessageProse text={complete}>
      <PendingParagraph text={pending} />
    </HelperMessageProse>
  );
}

export function StreamingStoryText({
  text,
  style,
  runId,
  finished = false,
}: StreamingStoryProps & { finished?: boolean }) {
  const parts = parseStoryUi(text);
  return (
    <>
      {parts.map((part, index) =>
        part.kind === 'prose' ? (
          index === parts.length - 1 ? (
            <StreamingProse
              key={part.id}
              text={part.text.replace(/<(?:a(?:2(?:u(?:i)?)?)?)?$/u, '')}
              finished={finished}
            />
          ) : (
            <Prose key={part.id} text={part.text} />
          )
        ) : part.kind === 'ui' ? (
          <StoryUi key={part.id} segment={part} style={style} />
        ) : part.kind === 'invalid' && part.text.startsWith('<a2ui>') ? (
          <StreamingStoryBlock key={part.id} text={part.text} style={style} runId={runId} />
        ) : null
      )}
    </>
  );
}

const active = (status?: string) => status === undefined || ['queued', 'running'].includes(status);

export function PartialResponse({ children }: { children: ReactNode }) {
  useI18n();
  const [open, setOpen] = useState(false);
  return (
    <details className="partial-response" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t('reader.viewPartialResponse')}</summary>
      {open && children}
    </details>
  );
}

type ResponseProps = {
  taskKind: ResponseTaskKind;
  taskId: string;
  taskStatus?: string;
  visible?: boolean;
  storyUiStyle?: StoryStyle;
};

export function ResponseDisplay({ mode, ...props }: ResponseProps & { mode: ResponseDisplayMode }) {
  useI18n();
  if (mode === 'stream') return <StreamingResponse {...props} />;
  if (active(props.taskStatus))
    return <LoadingState presentation="placeholder" label={t('reader.waitingForAResponse')} />;
  if (props.taskStatus === 'completed')
    return <LoadingState presentation="placeholder" label={t('reader.loadingResult')} />;
  return (
    <PartialResponse key={props.taskId}>
      <StreamingResponse {...props} settled />
    </PartialResponse>
  );
}

export function StreamingResponse({
  taskKind,
  taskId,
  taskStatus,
  visible = true,
  settled = false,
  storyUiStyle,
}: ResponseProps & { settled?: boolean }) {
  useI18n();
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
      connection: AbortController | undefined,
      readingSettled = settled,
      closed = false,
      terminal = false,
      cursor = 0,
      failures = 0;
    const offsets = new Map<string, number>();
    const base = `/response-streams/${taskKind}/${encodeURIComponent(taskId)}`;
    const receive = (page: ResponseStreamPage) => {
      if (closed || terminal) return false;
      if (page.taskKind !== taskKind || page.taskId !== taskId || !Array.isArray(page.chunks))
        throw new Error('RESPONSE_STREAM_IDENTITY_MISMATCH');
      const previousCursor = cursor;
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
      if (page.hasMore && cursor === previousCursor)
        throw new Error('RESPONSE_STREAM_CURSOR_STALLED');
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
      return cursor !== previousCursor || terminal;
    };
    const readable = () => !closed && !terminal && shown.current && !document.hidden;
    const retry = () => {
      if (!readable()) return;
      setDisconnected(true);
      clearTimeout(timer);
      timer = setTimeout(connect, Math.min(10000, 1200 * 2 ** Math.min(failures++, 3)));
    };
    const fail = async (error: unknown) => {
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
    };
    function connect() {
      if (connection || readingSettled || !readable()) return;
      clearTimeout(timer);
      const attempt = new AbortController();
      connection = attempt;
      void (async () => {
        let progressed = false;
        try {
          for await (const data of apiEvents(`${base}/events?after=${cursor}`, attempt.signal)) {
            if (receive(JSON.parse(data) as ResponseStreamPage)) progressed = true;
            if (terminal) break;
          }
          if (attempt.signal.aborted) return;
          connection = undefined;
          if (progressed) connect();
          else retry();
        } catch (error) {
          if (attempt.signal.aborted) return;
          connection = undefined;
          await fail(error);
        } finally {
          if (connection === attempt) connection = undefined;
        }
      })();
    }
    const release = () => {
      connection?.abort();
      connection = undefined;
    };
    const readSettled = async () => {
      try {
        let page: ResponseStreamPage;
        do {
          page = await api<ResponseStreamPage>(
            `${base}?after=${cursor}`,
            undefined,
            'GET',
            controller.signal
          );
          if (closed) return;
          receive(page);
        } while (!terminal && page.hasMore);
        readingSettled = false;
        connect();
      } catch (error) {
        readingSettled = false;
        await fail(error);
      }
    };
    const resume = () => {
      if (!shown.current || document.hidden) {
        release();
        return;
      }
      clearTimeout(timer);
      connect();
    };
    wake.current = resume;
    if (settled) void readSettled();
    else connect();
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    return () => {
      closed = true;
      controller.abort();
      release();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
    };
  }, [taskKind, taskId, settled]);
  useEffect(() => {
    shown.current = visible;
    wake.current();
  }, [visible]);
  if (!chunks.length) {
    if (disconnected)
      return (
        <small role="status">
          {settled
            ? t('reader.couldNotLoadThePartialResponseCheckYourConnection')
            : t('reader.couldNotLoadTheResponseCheckYourConnection')}
        </small>
      );
    if (!loaded)
      return (
        <LoadingState
          presentation="placeholder"
          label={
            settled || (!active(taskStatus) && taskStatus !== 'completed')
              ? t('reader.loadingPartialResponse')
              : taskStatus === 'completed'
                ? t('reader.loadingResult')
                : t('reader.waitingForAResponse')
          }
        />
      );
    if (!settled && status === 'completed')
      return <LoadingState presentation="placeholder" label={t('reader.loadingResult')} />;
    return settled ? <small role="status">{t('reader.noPartialResponseToShow')}</small> : null;
  }
  const parts = new Map<string, string>();
  for (const chunk of chunks) {
    const key = `${chunk.segment}:${chunk.attemptId}`;
    parts.set(key, (parts.get(key) ?? '') + chunk.text);
  }
  return (
    <div
      className="streaming-response"
      aria-label={settled ? t('reader.partialResponse') : t('reader.responseBeingGenerated')}
      data-status={status}
    >
      {disconnected ? (
        <small>{t('reader.checkingConnectionReceivedTextIsPreserved')}</small>
      ) : (
        (settled || (status !== 'running' && status !== 'completed')) && (
          <small>{t('reader.partialResponseReceived')}</small>
        )
      )}
      {[...parts].map(([key, value], index) => {
        const finished = status !== 'running' || index < parts.size - 1;
        return taskKind === 'main' ? (
          <div className="streaming-text prose" key={key}>
            <StreamingStoryText
              text={value}
              style={storyUiStyle}
              runId={taskId}
              finished={finished}
            />
          </div>
        ) : (
          <div className="streaming-text" key={key}>
            <StreamingHelperText text={value} finished={finished} />
          </div>
        );
      })}
    </div>
  );
}
