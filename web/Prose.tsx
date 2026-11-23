import {
  memo,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { compileReadingMarkdown, type ReadingBlock } from '../core/reading-markdown.js';
import { ReadingPreferencesContext } from './ReadingPreferencesContext.js';
import type { ReadabilitySettings } from './reading-preferences.js';
import { createReadingDecorator } from './reading-dom.js';
import './prose.css';
export { safeProseLink } from '../core/reading-markdown.js';
export { PlainProse } from './PlainProse.js';
const emptyBlocks: readonly ReadingBlock[] = [];

export const Prose = memo(function Prose({
  text,
  reading,
  allowedImageUrls,
  blocks = emptyBlocks,
  sourceId,
  compiled,
  afterBlock,
  storySlots,
  renderStorySlot,
}: {
  text: string;
  reading?: ReadabilitySettings;
  allowedImageUrls?: readonly string[];
  blocks?: readonly ReadingBlock[];
  sourceId?: string;
  compiled?: ReturnType<typeof compileReadingMarkdown>;
  afterBlock?: (anchor: string) => ReactNode;
  storySlots?: readonly { id: string; start: number }[];
  renderStorySlot?: (id: string) => ReactNode;
}) {
  const inherited = useContext(ReadingPreferencesContext);
  const settings = reading ?? inherited;
  const document = useMemo(
    () => compiled ?? compileReadingMarkdown(text, blocks, allowedImageUrls, storySlots),
    [text, blocks, allowedImageUrls, compiled, storySlots]
  );
  const innerHtml = useMemo(() => ({ __html: document.html }), [document.html]);
  const host = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const mounted = useRef<ReturnType<typeof createReadingDecorator> | null>(null);
  const [slots, setSlots] = useState<{ anchor: string; element: HTMLElement }[]>([]);
  const [uiSlots, setUiSlots] = useState<{ id: string; element: HTMLElement }[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Content replacement and reading decoration change the DOM owned by this effect.
  useLayoutEffect(() => {
    if (!content.current) return;
    mounted.current = createReadingDecorator(content.current);
    const found = [...content.current.querySelectorAll<HTMLElement>('[data-prose-slot]')].map(
      (element) => ({ anchor: element.dataset.proseSlot!, element })
    );
    const foundUi = [...content.current.querySelectorAll<HTMLElement>('[data-story-ui-slot]')].map(
      (element) => ({ id: element.dataset.storyUiSlot!, element })
    );
    setSlots((current) => (found.length || current.length ? found : current));
    setUiSlots((current) => (foundUi.length || current.length ? foundUi : current));
    return () => {
      mounted.current?.clear();
      mounted.current = null;
    };
  }, [document]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Content replacement and reading decoration change the DOM owned by this effect.
  useLayoutEffect(() => {
    mounted.current?.update(settings);
  }, [document, settings]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Content replacement and reading decoration change the DOM owned by this effect.
  useLayoutEffect(() => {
    const root = host.current;
    const prose = content.current;
    if (!root || !prose || !blocks.length) return;
    const markers = [...root.querySelectorAll<HTMLElement>(':scope > [data-block-anchor]')];
    const update = () => {
      const rootTop = root.getBoundingClientRect().top;
      const leaves = [...prose.querySelectorAll<HTMLElement>('[data-prose-start]')]
        .filter((element) => !element.querySelector('[data-prose-start]'))
        .map((element) => ({
          start: Number(element.dataset.proseStart),
          end: Number(element.dataset.proseEnd),
          rect: element.getBoundingClientRect(),
        }));
      let previousEnd = 0;
      let partIndex = 0;
      for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        while (partIndex < leaves.length && leaves[partIndex].end <= block.start) partIndex++;
        const matches: typeof leaves = [];
        let cursor = partIndex;
        while (cursor < leaves.length && leaves[cursor].start < block.end)
          matches.push(leaves[cursor++]);
        const following = leaves[cursor];
        const start = Math.max(
          previousEnd,
          matches.length
            ? Math.min(...matches.map((part) => part.rect.top)) - rootTop
            : following
              ? following.rect.top - rootTop
              : previousEnd
        );
        const end = Math.max(
          start + 1,
          matches.length
            ? Math.max(...matches.map((part) => part.rect.bottom)) - rootTop
            : start + 1
        );
        const marker = markers[index];
        if (marker) {
          marker.style.top = `${start}px`;
          marker.style.height = `${end - start}px`;
        }
        previousEnd = end;
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(prose);
    for (const element of prose.querySelectorAll<HTMLElement>(
      '[data-prose-start], img, [data-prose-slot]'
    ))
      observer.observe(element);
    prose.addEventListener('load', update, true);
    globalThis.document.fonts.addEventListener('loadingdone', update);
    return () => {
      observer.disconnect();
      prose.removeEventListener('load', update, true);
      globalThis.document.fonts.removeEventListener('loadingdone', update);
    };
  }, [document, blocks, settings]);
  return (
    <div className="reading-markdown" ref={host}>
      {blocks.map((block) => (
        <div
          key={block.anchor}
          className="reading-block-anchor"
          aria-hidden="true"
          data-block-anchor={block.anchor}
          id={sourceId ? `block-${sourceId}-${block.anchor}` : undefined}
        />
      ))}
      <div
        ref={content}
        className="reading-markdown-content"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: The compiler emits escaped text and validated reading HTML only.
        dangerouslySetInnerHTML={innerHtml}
      />
      {afterBlock &&
        slots.map(({ anchor, element }) => createPortal(afterBlock(anchor), element, anchor))}
      {renderStorySlot &&
        uiSlots.map(({ id, element }) => createPortal(renderStorySlot(id), element, id))}
    </div>
  );
});
