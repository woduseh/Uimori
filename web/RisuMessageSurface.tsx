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
  const mounted = useRef<{
    prepared: ReturnType<typeof prepareRisuMessage>;
    view: ReturnType<typeof mountRisuMessageSurface>;
    reading?: ReadabilitySettings;
  } | null>(null);
  const [state, setState] = useState<RisuActionState>({ busy: false, issue: '' });
  useLayoutEffect(() => {
    if (!host.current) return;
    if (mounted.current?.prepared !== prepared) {
      mounted.current?.view.destroy();
      mounted.current = {
        prepared,
        view: mountRisuMessageSurface(host.current, prepared, setState),
      };
      setState({ busy: false, issue: '' });
    }
    const current = mounted.current;
    current.view.updateAction({ action: onAction, disabled, revision: revisionKey });
    if (current.reading !== settings) {
      current.view.updateReading(settings);
      current.reading = settings;
    }
  }, [prepared, onAction, disabled, revisionKey, settings]);
  useLayoutEffect(
    () => () => {
      mounted.current?.view.destroy();
      mounted.current = null;
    },
    []
  );
  return (
    <div className="risu-message" aria-busy={state.busy}>
      {state.issue && <p role="alert">{state.issue}</p>}
      <div ref={host} className="risu-message-surface" />
    </div>
  );
}
