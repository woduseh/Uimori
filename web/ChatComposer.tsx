import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
} from 'react';

import { isApplePlatform } from './shortcut-bindings.js';
export { isApplePlatform };

export function sendKeyLabel(enterSend: boolean) {
  if (enterSend) return 'Enter';
  return isApplePlatform() ? 'Cmd+Enter' : 'Ctrl+Enter';
}

const ComposerGrowth = createContext<(grown: boolean) => void>(() => {});

export function ChatComposer({ className = '', children, ...props }: ComponentProps<'form'>) {
  const [grown, setGrown] = useState(false);
  return (
    <ComposerGrowth.Provider value={setGrown}>
      <form {...props} className={`composer${grown ? ' grown' : ''} ${className}`}>
        {children}
      </form>
    </ComposerGrowth.Provider>
  );
}

type InputProps = Omit<ComponentProps<'textarea'>, 'ref' | 'onKeyDown' | 'rows'> & {
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  enterSend: boolean;
  onSend: () => void;
  onAlternateSend?: () => void;
  onKeyDown?: ComponentProps<'textarea'>['onKeyDown'];
};

export function ComposerInput({
  inputRef,
  enterSend,
  onSend,
  onAlternateSend,
  onKeyDown,
  value,
  ...props
}: InputProps) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? ownRef;
  const composing = useRef(false);
  const setGrown = useContext(ComposerGrowth);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const resize = () => {
      const form = node.closest('form.composer');
      const wasGrown = form?.classList.contains('grown');
      if (wasGrown) form?.classList.remove('grown');
      node.style.height = 'auto';
      const style = getComputedStyle(node);
      const single = Math.max(
        Number.parseFloat(style.minHeight),
        Number.parseFloat(style.lineHeight) +
          Number.parseFloat(style.paddingTop) +
          Number.parseFloat(style.paddingBottom)
      );
      const grown = !!value && (String(value).includes('\n') || node.scrollHeight > single + 1);
      if (wasGrown) form?.classList.add('grown');
      setGrown(grown);
      node.style.height = `${Math.min(node.scrollHeight, 180)}px`;
    };
    resize();
    let previousWidth = node.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const width = node.getBoundingClientRect().width;
      if (width === previousWidth) return;
      previousWidth = width;
      resize();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [value, ref, setGrown]);
  return (
    <textarea
      {...props}
      ref={ref}
      rows={1}
      value={value}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (
          props.disabled ||
          props.readOnly ||
          event.key !== 'Enter' ||
          event.nativeEvent.isComposing ||
          composing.current ||
          event.keyCode === 229
        )
          return;
        if (
          onAlternateSend &&
          event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey
        ) {
          event.preventDefault();
          onAlternateSend();
          return;
        }
        if (!event.altKey && (event.ctrlKey || event.metaKey || (enterSend && !event.shiftKey))) {
          event.preventDefault();
          onSend();
        }
      }}
    />
  );
}
