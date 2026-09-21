import { useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ReadingPreferencesContext } from './ReadingPreferencesContext.js';
import type { ReadabilitySettings } from './reading-preferences.js';
import { prepareRisuMessage } from './risu-message.js';
import {
  mountRisuMessageSurface,
  type RisuAction,
  type RisuActionState,
} from './risu-message-surface.js';

export function RisuMessageSurface({
  html,
  css = '',
  onAction,
  disabled = false,
  revisionKey = '',
  reading,
}: {
  html: string;
  css?: string;
  onAction: RisuAction;
  disabled?: boolean;
  revisionKey?: string;
  reading?: ReadabilitySettings;
}) {
  const inheritedReading = useContext(ReadingPreferencesContext);
  const settings = reading ?? inheritedReading;
  const prepared = useMemo(() => prepareRisuMessage(html, css), [html, css]);
  const host = useRef<HTMLDivElement>(null);
  const surface = useRef<ReturnType<typeof mountRisuMessageSurface> | null>(null);
  const [state, setState] = useState<RisuActionState>({ busy: false, issue: '' });
  useLayoutEffect(() => {
    if (!host.current) return;
    const current = mountRisuMessageSurface(host.current, prepared, setState);
    surface.current = current;
    setState({ busy: false, issue: '' });
    return () => {
      current.destroy();
      surface.current = null;
    };
  }, [prepared]);
  useLayoutEffect(() => {
    surface.current?.updateAction({ action: onAction, disabled, revision: revisionKey });
  }, [onAction, disabled, revisionKey]);
  useLayoutEffect(() => {
    surface.current?.updateReading(settings);
  }, [settings]);
  return (
    <div className="risu-message" aria-busy={state.busy}>
      {state.issue && <p role="alert">{state.issue}</p>}
      <div ref={host} className="risu-message-surface" />
    </div>
  );
}
