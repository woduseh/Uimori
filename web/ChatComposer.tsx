import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
} from 'react';

const ComposerGrowth = createContext<(grown: boolean) => void>(() => {});

/** Shared layout and keyboard contract for main and helper conversations. */
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
};

export function ComposerInput({ inputRef, enterSend, onSend, value, ...props }: InputProps) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? ownRef;
  const composing = useRef(false);
  const setGrown = useContext(ComposerGrowth);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const resize = () => {
      // Measure the one-row layout before choosing a shape. The grown layout is wider;
      // measuring only that width would alternate shapes for a borderline draft.
      const form = node.closest('form.composer');
      const wasGrown = form?.classList.contains('grown');
      if (wasGrown) form?.classList.remove('grown');
      node.style.height = 'auto';
      const style = getComputedStyle(node);
      const single =
        Number.parseFloat(style.lineHeight) +
        Number.parseFloat(style.paddingTop) +
        Number.parseFloat(style.paddingBottom);
      const grown = !!value && (String(value).includes('\n') || node.scrollHeight > single + 1);
      // Restore React's current class synchronously, before paint or observer delivery.
      if (wasGrown) form?.classList.add('grown');
      setGrown(grown);
      node.style.height = `${Math.min(node.scrollHeight, 180)}px`;
    };
    resize();
    // Observe width only: resizing our own height must not schedule another resize.
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
        if (
          props.disabled ||
          props.readOnly ||
          event.key !== 'Enter' ||
          event.nativeEvent.isComposing ||
          composing.current ||
          event.keyCode === 229
        )
          return;
        if (event.ctrlKey || event.metaKey || (enterSend && !event.shiftKey)) {
          event.preventDefault();
          onSend();
        }
      }}
    />
  );
}
