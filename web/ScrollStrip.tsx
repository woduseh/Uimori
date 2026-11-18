import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import './scroll-strip.css';

type Overflow = { start: boolean; end: boolean };

export function ScrollStrip({
  className = '',
  children,
  ...props
}: ComponentPropsWithoutRef<'div'>) {
  const viewport = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState<Overflow>({ start: false, end: false });
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      const start = element.scrollLeft > 1;
      const end = element.scrollLeft < element.scrollWidth - element.clientWidth - 1;
      setOverflow((old) => (old.start === start && old.end === end ? old : { start, end }));
    };
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    for (const child of element.children) resize.observe(child);
    element.addEventListener('scroll', measure, { passive: true });
    return () => {
      resize.disconnect();
      element.removeEventListener('scroll', measure);
    };
  });
  const scroll = (direction: 1 | -1) => {
    const element = viewport.current;
    if (element) element.scrollBy({ left: direction * element.clientWidth * 0.75 });
  };
  return (
    <div
      className="scroll-strip"
      data-overflow-start={overflow.start || undefined}
      data-overflow-end={overflow.end || undefined}
    >
      <div {...props} ref={viewport} className={`scroll-strip-viewport ${className}`}>
        {children}
      </div>
      <button
        type="button"
        className="scroll-strip-button start"
        tabIndex={-1}
        aria-hidden="true"
        disabled={!overflow.start}
        onClick={() => scroll(-1)}
      >
        <ChevronLeft size={18} />
      </button>
      <button
        type="button"
        className="scroll-strip-button end"
        tabIndex={-1}
        aria-hidden="true"
        disabled={!overflow.end}
        onClick={() => scroll(1)}
      >
        <ChevronRight size={18} />
      </button>
    </div>
  );
}
