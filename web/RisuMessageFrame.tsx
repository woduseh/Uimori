import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { prepareRisuMessage, RISU_FRAME_CHANNEL, risuActionKey } from './risu-message-frame.js';

export function RisuMessageFrame({
  html,
  css = '',
  onAction,
  disabled = false,
  revisionKey = '',
}: {
  html: string;
  css?: string;
  onAction: (kind: 'trigger' | 'button', name: string) => Promise<void>;
  disabled?: boolean;
  revisionKey?: string;
}) {
  const prepared = useMemo(
    () => ({ ...prepareRisuMessage(html, css), revisionKey }),
    [html, css, revisionKey]
  );
  const frame = useRef<HTMLIFrameElement>(null);
  const action = useRef(onAction),
    disabledRef = useRef(disabled),
    locked = useRef(false);
  const [size, setSize] = useState({ token: '', height: 160 }),
    [issue, setIssue] = useState(''),
    [busy, setBusy] = useState(false);
  action.current = onAction;
  disabledRef.current = disabled;
  const sendDisabled = useCallback(
    (value: boolean) =>
      frame.current?.contentWindow?.postMessage(
        { channel: RISU_FRAME_CHANNEL, token: prepared.token, kind: 'disabled', value },
        '*'
      ),
    [prepared.token]
  );
  useEffect(() => {
    sendDisabled(disabled || busy);
  }, [disabled, busy, sendDisabled]);
  useEffect(() => {
    let mounted = true;
    locked.current = false;
    setBusy(false);
    setIssue('');
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null') return;
      const data = event.data;
      if (
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data) ||
        data.channel !== RISU_FRAME_CHANNEL ||
        data.token !== prepared.token
      )
        return;
      if (data.kind === 'ready') {
        sendDisabled(disabledRef.current || locked.current);
        return;
      }
      if (data.kind === 'resize') {
        if (typeof data.height === 'number' && Number.isFinite(data.height))
          setSize({ token: prepared.token, height: Math.max(48, Math.min(30000, data.height)) });
        return;
      }
      if (
        data.kind !== 'action' ||
        !['trigger', 'button'].includes(data.actionKind) ||
        typeof data.name !== 'string' ||
        data.name.length > 1000 ||
        !prepared.actions.has(risuActionKey(data.actionKind, data.name)) ||
        disabledRef.current ||
        locked.current
      )
        return;
      locked.current = true;
      setBusy(true);
      setIssue('');
      sendDisabled(true);
      void action.current(data.actionKind, data.name).catch(() => {
        if (!mounted) return;
        setIssue('봇의 선택을 반영하지 못했어요. 다시 시도해 주세요.');
        locked.current = false;
        setBusy(false);
        sendDisabled(disabledRef.current);
      });
      // Successful actions stay locked until a new source/variable revision is rendered.
      // The HTTP response can arrive before React commits the refreshed reader.
    };
    window.addEventListener('message', receive);
    return () => {
      mounted = false;
      window.removeEventListener('message', receive);
    };
  }, [prepared, sendDisabled]);
  return (
    <div className="risu-message-frame" aria-busy={busy}>
      {issue && <p role="alert">{issue}</p>}
      <iframe
        key={prepared.token}
        ref={frame}
        title="봇 메시지"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={prepared.srcDoc}
        style={{
          width: '100%',
          height: size.token === prepared.token ? size.height : 160,
          border: 0,
          display: 'block',
        }}
        onLoad={() => sendDisabled(disabledRef.current || locked.current)}
      />
    </div>
  );
}
