import { t, useI18n } from './i18n.js';
import { uiMessage } from './ui-message.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ResponseDisplayMode } from './presentation-settings.js';
import type { ResponseStreamPage, ResponseTaskKind } from '../core/response-stream.js';
import {
  responseStreamIsPushed,
  watchResponseStream,
  type PushedResponsePage,
} from './response-stream-bridge.js';
import { api, ApiError } from './api.js';
import { responseStreamPollDelay } from './poll-delays.js';
import { PlainProse, Prose } from './Prose.js';
import { HelperMessageProse } from './HelperMessageProse.js';
import { splitCompletedParagraphs } from '../core/reading-markdown.js';
import { LoadingState } from './LoadingState.js';
import { useStoryUiSegments } from './story-ui-parser.js';
import { StoryUi } from './LazyStoryUi.js';
import { StoryUiPreviewBlock } from './StoryUiPreviewBlock.js';
import { scanStoryUi, type StoryUiMessage } from '../core/story-ui-scan.js';

const neverCompiled = (_value: unknown): _value is StoryUiMessage[] => false;
import './streaming-response.css';

type StoryStyle = import('../core/story-ui-style.js').StoryUiStyleSetting;

type StreamingStoryProps = { text: string; style?: StoryStyle; runId?: string };
class ResponseStreamError extends Error {}

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
  const last = pending.includes('<a2ui>') ? scanStoryUi(pending, neverCompiled).at(-1) : undefined;
  const composing = last?.kind === 'pending' && last.text.startsWith('<a2ui>');
  return (
    <HelperMessageProse text={complete}>
      <PendingParagraph text={composing ? pending.slice(0, last.start) : pending} />
      {composing && (
        <LoadingState presentation="placeholder" label={uiMessage('storyUi.composing')} />
      )}
    </HelperMessageProse>
  );
}

export function StreamingStoryText({
  text,
  style,
  runId,
  finished = false,
}: StreamingStoryProps & { finished?: boolean }) {
  const parts = useStoryUiSegments(text);
  if (!parts)
    return <LoadingState presentation="placeholder" label={uiMessage('reader.loadingResult')} />;
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
        ) : part.kind === 'pending' && finished ? (
          <Prose key={part.id} text={part.text} />
        ) : part.text.startsWith('<a2ui>') ? (
          <StoryUiPreviewBlock key={part.id} text={part.text} style={style} runId={runId} />
        ) : null
      )}
    </>
  );
}

const THOUGHT_TAIL_CHARS = 600;
export function thoughtTail(thought: string) {
  const plain = thought.replaceAll('**', '').trim();
  if (plain.length <= THOUGHT_TAIL_CHARS) return plain;
  const tail = plain.slice(-THOUGHT_TAIL_CHARS);
  const start = tail.search(/\s/u);
  return '…' + tail.slice(start < 0 ? 0 : start).trimStart();
}

const PUSHED_PAGE_LIMIT = 16;
const active = (status?: string) => status === undefined || ['queued', 'running'].includes(status);
const taskStatusPath: Record<ResponseTaskKind, string> = {
  main: '/runs/',
  helper: '/helper/tasks/',
  translation: '/jobs/',
};

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
    return (
      <LoadingState presentation="placeholder" label={uiMessage('reader.waitingForAResponse')} />
    );
  if (props.taskStatus === 'completed')
    return <LoadingState presentation="placeholder" label={uiMessage('reader.loadingResult')} />;
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
  quietUntilText = false,
  onText,
}: ResponseProps & {
  settled?: boolean;
  quietUntilText?: boolean;
  onText?: (arrived: boolean) => void;
}) {
  useI18n();
  const [parts, setParts] = useState<[string, string][]>([]);
  const [status, setStatus] = useState('running');
  const [thought, setThought] = useState('');
  const [disconnected, setDisconnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const currentTaskStatus = useRef(taskStatus);
  currentTaskStatus.current = taskStatus;
  const shown = useRef(visible);
  shown.current = visible;
  const wake = useRef<() => void>(() => {});
  useEffect(() => {
    setParts([]);
    setThought('');
    setStatus('running');
    setDisconnected(false);
    setLoaded(false);
    const texts = new Map<string, string>();
    const offsets = new Map<string, number>();
    const pushed: PushedResponsePage[] = [];
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined,
      frame = 0,
      closed = false,
      terminal = false,
      polling = false,
      cursor = 0,
      failures = 0;
    const base = `/response-streams/${taskKind}/${encodeURIComponent(taskId)}`;
    const reading = () => !closed && !terminal && shown.current && !document.hidden;
    const commit = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      setParts([...texts]);
    };
    const receive = (page: ResponseStreamPage) => {
      if (closed || terminal) return;
      if (page.taskKind !== taskKind || page.taskId !== taskId || !Array.isArray(page.chunks))
        throw new ResponseStreamError('RESPONSE_STREAM_IDENTITY_MISMATCH');
      let added = false;
      for (const chunk of page.chunks) {
        if (chunk.seq <= cursor) continue;
        const key = `${chunk.segment}:${chunk.attemptId}`;
        if (
          !Number.isSafeInteger(chunk.seq) ||
          typeof chunk.text !== 'string' ||
          !Number.isSafeInteger(chunk.offset) ||
          chunk.offset !== (offsets.get(key) ?? 0) + chunk.text.length
        )
          throw new ResponseStreamError('RESPONSE_STREAM_OFFSET_MISMATCH');
        offsets.set(key, chunk.offset);
        cursor = chunk.seq;
        texts.set(key, (texts.get(key) ?? '') + chunk.text);
        added = true;
      }
      setStatus(page.status);
      setThought(page.thought ?? '');
      setDisconnected(false);
      failures = 0;
      if (page.status !== 'running' && !page.hasMore) {
        terminal = true;
        pushed.length = 0;
        commit();
        setLoaded(true);
        clearTimeout(timer);
      } else if (added && !settled && !frame) frame = requestAnimationFrame(commit);
    };
    const receivePushed = () => {
      while (!terminal && pushed.length && pushed[0].after <= cursor) receive(pushed.shift()!);
    };
    const stop = () => {
      terminal = true;
      pushed.length = 0;
      clearTimeout(timer);
      setDisconnected(true);
    };
    const schedule = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => void poll(), delay);
    };
    const retry = () => {
      if (!reading()) return;
      setDisconnected(true);
      schedule(Math.min(10000, 1200 * 2 ** Math.min(failures++, 3)));
    };
    const poll = async () => {
      if (polling || !reading()) return;
      clearTimeout(timer);
      polling = true;
      try {
        let page: ResponseStreamPage;
        let textArrived = false;
        do {
          const requested = cursor;
          page = await api<ResponseStreamPage>(
            `${base}?after=${requested}`,
            undefined,
            'GET',
            controller.signal
          );
          if (closed) return;
          receive(page);
          textArrived = cursor > requested;
          if (page.hasMore && !textArrived)
            throw new ResponseStreamError('RESPONSE_STREAM_CURSOR_STALLED');
          receivePushed();
        } while (!terminal && page.hasMore && shown.current && !document.hidden);
        if (!reading()) return;
        schedule(
          textArrived || pushed.length
            ? responseStreamPollDelay.streaming
            : !settled && responseStreamIsPushed(taskKind, taskId)
              ? responseStreamPollDelay.pushed
              : responseStreamPollDelay.waiting
        );
      } catch (error) {
        if (closed) return;
        if (error instanceof ApiError && [401, 403].includes(error.status)) {
          stop();
          return;
        }
        if (error instanceof ApiError && error.status === 404) {
          let task = currentTaskStatus.current;
          if (task === undefined) {
            try {
              task = (
                await api<{ status: string }>(
                  `${taskStatusPath[taskKind]}${encodeURIComponent(taskId)}`,
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
          if (closed || terminal) return;
          if (!active(task)) {
            terminal = true;
            setStatus(task!);
            setLoaded(true);
            return;
          }
        } else if (error instanceof ResponseStreamError) {
          stop();
          return;
        }
        retry();
      } finally {
        polling = false;
      }
    };
    const unwatch = settled
      ? () => {}
      : watchResponseStream(taskKind, taskId, {
          cursor: () => cursor,
          receive: (page) => {
            if (!reading()) {
              pushed.length = 0;
              return;
            }
            if (pushed.push(page) > PUSHED_PAGE_LIMIT) pushed.shift();
            const before = cursor;
            try {
              receivePushed();
            } catch {
              stop();
              return;
            }
            if (terminal || polling) return;
            if (pushed.length) void poll();
            else if (cursor > before) schedule(responseStreamPollDelay.pushed);
          },
          disconnected: () => {
            pushed.length = 0;
            if (reading() && !polling) void poll();
          },
        });
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
      cancelAnimationFrame(frame);
      unwatch();
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
    };
  }, [taskKind, taskId, settled]);
  useEffect(() => {
    shown.current = visible;
    wake.current();
  }, [visible]);
  const hasText = parts.length > 0;
  const reportText = useRef(onText);
  reportText.current = onText;
  useEffect(() => {
    reportText.current?.(hasText);
  }, [hasText]);
  const thinking =
    !settled && status === 'running' && thought ? (
      <div className="streaming-thought" role="status" aria-label={t('reader.thoughtSummary')}>
        <small>{t('reader.thoughtSummary')}</small>
        <p>{thoughtTail(thought)}</p>
      </div>
    ) : null;
  if (!hasText) {
    if (quietUntilText) return null;
    if (thinking) return thinking;
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
              ? uiMessage('reader.loadingPartialResponse')
              : taskStatus === 'completed'
                ? uiMessage('reader.loadingResult')
                : uiMessage('reader.waitingForAResponse')
          }
        />
      );
    if (!settled && status === 'completed')
      return <LoadingState presentation="placeholder" label={uiMessage('reader.loadingResult')} />;
    return settled ? <small role="status">{t('reader.noPartialResponseToShow')}</small> : null;
  }
  const shownParts = taskKind === 'translation' ? parts.slice(-1) : parts;
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
      {shownParts.map(([key, value], index) => {
        const finished = status !== 'running' || index < shownParts.length - 1;
        return taskKind === 'translation' ? (
          <div className="streaming-text prose translated" key={key}>
            <StreamingProse text={value} finished={finished} />
          </div>
        ) : taskKind === 'main' ? (
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
      {thinking}
    </div>
  );
}
