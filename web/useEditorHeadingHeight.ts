import { useLayoutEffect, useRef } from 'react';

/** Native editor tabs follow the actual header; its CSS minimum stays independent. */
export function useEditorHeadingHeight(ready: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!ready) return;
    const heading = ref.current;
    const editor = heading?.parentElement;
    if (!heading || !editor) return;
    const measure = () =>
      editor.style.setProperty(
        '--editor-heading-offset',
        `${heading.getBoundingClientRect().height}px`
      );
    const observer = new ResizeObserver(measure);
    observer.observe(heading);
    measure();
    return () => {
      observer.disconnect();
      editor.style.removeProperty('--editor-heading-offset');
    };
  }, [ready]);
  return ref;
}
