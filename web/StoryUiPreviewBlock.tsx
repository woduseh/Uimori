import { useEffect, useState, type ReactNode } from 'react';
import type { StoryUiStyleSetting } from '../core/story-ui-style.js';
import { api } from './api.js';
import { uiMessage } from './ui-message.js';
import { StoryUi } from './LazyStoryUi.js';
import { LoadingState } from './LoadingState.js';
import { useStoryUiSegments } from './story-ui-parser.js';

const previews = new Map<string, string>();

export function StoryUiPreviewBlock({
  text,
  style,
  runId,
  failed = null,
  actionNote,
}: {
  text: string;
  style?: StoryUiStyleSetting;
  runId?: string;
  failed?: ReactNode;
  actionNote?: string;
}) {
  const key = JSON.stringify([runId ?? '', text]);
  const [preview, setPreview] = useState(() => previews.get(key));
  useEffect(() => {
    const cached = previews.get(key);
    setPreview(cached);
    if (cached !== undefined || !text.startsWith('<a2ui>') || !text.endsWith('</a2ui>')) return;
    const controller = new AbortController();
    void api<{ text: string }>('/story-ui/preview', { text, runId }, 'POST', controller.signal)
      .then((result) => {
        if (previews.size >= 100) previews.delete(previews.keys().next().value!);
        previews.set(key, result.text);
        setPreview(result.text);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPreview('');
      });
    return () => controller.abort();
  }, [key, text, runId]);
  const part = useStoryUiSegments(preview ?? '')?.find((entry) => entry.kind === 'ui');
  if (preview === undefined)
    return <LoadingState presentation="placeholder" label={uiMessage('storyUi.composing')} />;
  return part?.kind === 'ui' ? (
    <StoryUi segment={part} style={style} actionNote={actionNote} />
  ) : (
    failed
  );
}
