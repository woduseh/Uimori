import { A2uiSurface, MarkdownContext, type ReactCatalogComponent } from '@a2ui/react';
import { MessageProcessor, type ActionPayload } from '@a2ui/web_core';
import { useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { resolveStoryUiPresentation, storyUiBlockCss } from '../core/story-ui-style.js';
import type { ThemeDefinition } from '../core/themes.js';
import { ThemeContext } from './ThemeContext.js';
import { modelStoryUiCss, scopedStoryUiCss } from './story-ui-theme.js';
import type { StoryUiSegment } from '../core/story-ui.js';
import type { RunReceipt } from '../core/types.js';
import { compileReadingMarkdown } from '../core/reading-markdown.js';
import { api, ApiError, definiteRejection } from './api.js';
import { t, useI18n } from './i18n.js';
import { StoryUiImageUrls, storyUiRenderCatalog } from './story-ui-catalog.js';
import './story-ui.css';
import { readStoryUiDraft, storyUiDraftChanges, writeStoryUiDraft } from './story-ui-draft.js';

type UiSegment = Extract<StoryUiSegment, { kind: 'ui' }>;
type Command = { body: Record<string, unknown>; uncertain: boolean };
const commands = new Map<string, Command>();
const renderMarkdown = async (markdown: string) => compileReadingMarkdown(markdown).html;

export function createStoryUiProcessor(
  messages: UiSegment['messages'],
  onAction: (payload: ActionPayload) => void
) {
  const processor = new MessageProcessor<ReactCatalogComponent>([storyUiRenderCatalog], onAction);
  try {
    processor.processMessages(structuredClone(messages));
    return processor;
  } catch {
    processor.dispose();
    return null;
  }
}

export function StoryUi({
  segment,
  chatId,
  sourceId,
  sourceHash,
  latest,
  refresh,
  actionBlockId,
  beginAdmission,
  style,
  customTheme,
  actionNote,
}: {
  segment: UiSegment;
  actionNote?: string;
  style?: import('../core/story-ui-style.js').StoryUiStyleSetting;
  customTheme?: ThemeDefinition['storyUi'];
  chatId?: string;
  sourceId?: string;
  sourceHash?: string;
  latest?: boolean;
  refresh?: () => Promise<void>;
  actionBlockId?: string;
  beginAdmission?: () => (run: RunReceipt) => void;
}) {
  const themeState = useContext(ThemeContext);
  useI18n();
  const themeId = useId();
  const presentation = resolveStoryUiPresentation(
    style,
    segment.messages,
    themeState?.disabled ? undefined : themeState?.catalog,
    themeState?.scope.botId
  );
  const theme = customTheme ?? presentation.theme?.storyUi;
  const root = (
    segment.messages[0] as unknown as {
      createSurface: { components: { id: string; component: string; [key: string]: unknown }[] };
    }
  ).createSurface.components.find((component) => component.id === 'root');
  const frame = root?.component === 'Frame' ? root : undefined;
  const css = useMemo(() => scopedStoryUiCss(theme?.css ?? '', themeId), [theme?.css, themeId]);
  const blockCss = theme ? '' : storyUiBlockCss(style, segment.messages, presentation);
  const authored = useMemo(() => modelStoryUiCss(blockCss, themeId), [blockCss, themeId]);
  const [action, setAction] = useState<ActionPayload>();
  const [mode, setMode] = useState<'short' | 'continue'>('short');
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [failure, setFailure] = useState<ApiError>();
  const [uncertain, setUncertain] = useState(false);
  const callback = useRef(setAction);
  const draftKey =
    sourceId && sourceHash
      ? `uimori:story-ui-draft:${chatId}:${sourceId}:${sourceHash}:${actionBlockId ?? segment.id}`
      : undefined;
  callback.current = (next) => {
    if (!uncertain && !pending) setAction(next);
  };
  const [processor] = useState(() =>
    createStoryUiProcessor(segment.messages, (payload) => callback.current(payload))
  );
  useEffect(() => () => processor?.dispose(), [processor]);
  const surface = processor?.getSurface(segment.surfaceId);
  useEffect(() => {
    if (!surface || !draftKey) return;
    const initial = structuredClone(surface.dataModel.get('/'));
    for (const change of readStoryUiDraft(draftKey)) {
      try {
        surface.dataModel.set(change.path, change.value);
      } catch {}
    }
    const subscription = surface.dataModel.subscribe('/', (value) => {
      writeStoryUiDraft(draftKey, storyUiDraftChanges(initial, value));
    });
    return () => subscription.unsubscribe();
  }, [surface, draftKey]);
  const submit = async () => {
    if (!action || !chatId || !sourceId || !sourceHash || pending) return;
    const identity = JSON.stringify([
      chatId,
      sourceId,
      sourceHash,
      actionBlockId ?? segment.id,
      action.name,
      action.sourceComponentId,
      action.context,
      mode,
    ]);
    const command = commands.get(identity) ?? {
      body: {
        sourceRevision: sourceId,
        sourceHash,
        blockId: actionBlockId ?? segment.id,
        surfaceId: segment.surfaceId,
        eventName: action.name,
        componentId: action.sourceComponentId,
        context: action.context,
        mode,
        idempotencyKey: crypto.randomUUID(),
      },
      uncertain: false,
    };
    commands.set(identity, command);
    setPending(true);
    setFailed(false);
    setFailure(undefined);
    const admitted = beginAdmission?.();
    try {
      const run = await api<RunReceipt>(
        `/chats/${encodeURIComponent(chatId)}/story-ui/actions`,
        command.body
      );
      admitted?.(run);
      commands.delete(identity);
      if (draftKey) writeStoryUiDraft(draftKey, []);
      setUncertain(false);
      setAction(undefined);
      try {
        await refresh?.();
      } catch {
        setFailed(true);
      }
    } catch (error) {
      if (error instanceof ApiError) setFailure(error);
      if (definiteRejection(error)) commands.delete(identity);
      else {
        command.uncertain = true;
        setUncertain(true);
      }
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="story-ui-block" data-authored={authored ? '' : undefined}>
      <section
        className="story-ui"
        data-story-ui-style={theme?.baseStyle ?? presentation.style}
        data-story-ui-custom={theme ? themeId : undefined}
        data-story-ui-authored={authored ? themeId : undefined}
        data-story-ui-root={root?.component}
        data-story-ui-kind={frame ? String(frame.kind ?? 'panel') : undefined}
        data-story-ui-accent={typeof frame?.accent === 'string' ? frame.accent : undefined}
        data-story-ui-surface={typeof frame?.surface === 'string' ? frame.surface : undefined}
      >
        {css && <style>{css}</style>}
        {authored && <style>{authored}</style>}
        {surface && (
          <div className="story-ui-surface" inert={!!action && !!chatId && (latest || uncertain)}>
            <MarkdownContext.Provider value={renderMarkdown}>
              <StoryUiImageUrls.Provider value={segment.imageUrls}>
                <A2uiSurface surface={surface} />
              </StoryUiImageUrls.Provider>
            </MarkdownContext.Provider>
          </div>
        )}
        {!surface && <p role="status">{t('storyUi.invalid')}</p>}
      </section>
      {action &&
        ((latest || uncertain) && chatId ? (
          <div className="story-ui-action">
            <label>
              <input
                type="radio"
                name={`${themeId}-mode`}
                checked={mode === 'short'}
                disabled={uncertain || pending}
                onChange={() => setMode('short')}
              />
              {t('storyUi.actionModeShort')}
            </label>
            <label>
              <input
                type="radio"
                name={`${themeId}-mode`}
                checked={mode === 'continue'}
                disabled={uncertain || pending}
                onChange={() => setMode('continue')}
              />
              {t('storyUi.actionModeContinue')}
            </label>
            {failed && <p role="alert">{failure?.displayMessage ?? t('storyUi.failed')}</p>}
            <button
              type="button"
              className="primary"
              disabled={pending}
              onClick={() => void submit()}
            >
              {uncertain ? t('library.checkResult') : t('storyUi.send')}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={pending || uncertain}
              onClick={() => setAction(undefined)}
            >
              {t('shared.cancel')}
            </button>
          </div>
        ) : (
          <p role="status">{actionNote ?? t('storyUi.older')}</p>
        ))}
    </div>
  );
}
