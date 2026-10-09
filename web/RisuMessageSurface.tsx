import { useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  illustrations = [],
  onIllustrationAnchors,
}: {
  html: string;
  css?: string;
  onAction: RisuAction;
  disabled?: boolean;
  revisionKey?: string;
  reading?: ReadabilitySettings;
  illustrations?: { anchor: string; content: ReactNode }[];
  onIllustrationAnchors?: (anchors: string[]) => void;
}) {
  const inheritedReading = useContext(ReadingPreferencesContext);
  const settings = reading ?? inheritedReading;
  const prepared = useMemo(() => prepareRisuMessage(html, css), [html, css]);
  const host = useRef<HTMLDivElement>(null);
  const mounted = useRef<{
    prepared: ReturnType<typeof prepareRisuMessage>;
    view: ReturnType<typeof mountRisuMessageSurface>;
    revision: string;
    reading?: ReadabilitySettings;
  } | null>(null);
  const [state, setState] = useState<RisuActionState>({ busy: false, issue: '' });
  useLayoutEffect(() => {
    if (!host.current) return;
    if (!mounted.current) {
      mounted.current = {
        prepared,
        revision: revisionKey,
        view: mountRisuMessageSurface(host.current, prepared, setState),
      };
    }
    const current = mounted.current;
    if (current.prepared !== prepared) {
      current.view.updateMessage(prepared, !!revisionKey && current.revision === revisionKey);
      current.prepared = prepared;
      current.reading = undefined;
    }
    current.revision = revisionKey;
    current.view.updateAction({ action: onAction, disabled, revision: revisionKey });
    current.view.updateIllustrations(illustrations.map((item) => item.anchor));
    if (current.reading !== settings) {
      current.view.updateReading(settings);
      current.reading = settings;
    }
  }, [prepared, onAction, disabled, revisionKey, settings, illustrations]);
  useLayoutEffect(() => {
    onIllustrationAnchors?.(prepared.illustrationAnchors);
  }, [prepared, onIllustrationAnchors]);
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
      <div ref={host} className="risu-message-surface">
        {illustrations.map(({ anchor, content }) => (
          <div key={anchor} slot={`illustration-${anchor}`} className="illustration-slot">
            {content}
          </div>
        ))}
      </div>
    </div>
  );
}
