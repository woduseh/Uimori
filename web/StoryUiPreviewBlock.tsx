import { useEffect, useState, type ReactNode } from 'react';
import type { StoryUiStyleSetting } from '../core/story-ui-style.js';
import { api } from './api.js';
import { t } from './i18n.js';
import { StoryUi } from './LazyStoryUi.js';
import { LoadingState } from './LoadingState.js';
import { useStoryUiSegments } from './story-ui-parser.js';

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
  const [preview, setPreview] = useState<string>();
  useEffect(() => {
    setPreview(undefined);
    if (!text.startsWith('<a2ui>') || !text.endsWith('</a2ui>')) return;
    const controller = new AbortController();
    void api<{ text: string }>('/story-ui/preview', { text, runId }, 'POST', controller.signal)
      .then((result) => setPreview(result.text))
      .catch(() => {
        if (!controller.signal.aborted) setPreview('');
      });
    return () => controller.abort();
  }, [text, runId]);
  const part = useStoryUiSegments(preview ?? '')?.find((entry) => entry.kind === 'ui');
  if (preview === undefined)
    return <LoadingState presentation="placeholder" label={t('storyUi.composing')} />;
  return part?.kind === 'ui' ? (
    <StoryUi segment={part} style={style} actionNote={actionNote} />
  ) : (
    failed
  );
}
