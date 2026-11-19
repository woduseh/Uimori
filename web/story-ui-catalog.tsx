import { createComponentImplementation as implement } from '@a2ui/react';
import { Catalog } from '@a2ui/web_core';
import { basicCatalog } from '@a2ui/web_core/catalogs/basic/v1';
import {
  type CSSProperties,
  cloneElement,
  createContext,
  Fragment,
  isValidElement,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { compileReadingMarkdown } from '../core/reading-markdown.js';
import { storyUiCatalog, storyUiImageKeys } from '../core/story-ui-catalog.js';
import { isStoryUiImageUrl, storyUiImageName } from '../core/story-ui.js';
import { storyUiIcons } from './story-ui-icons.js';
import { getIntlLocale, t } from './i18n.js';

// Every component renders in the light DOM with `story-ui-*` class names, so the presets in
// story-ui.css and authored themes style the same markup. The SDK supplies data binding,
// validation and actions; none of its own elements or styles are used.
const api = (name: string) => storyUiCatalog.components.get(name)!;
export const StoryUiImageUrls = createContext<Record<string, string> | undefined>(undefined);
const createComponentImplementation: typeof implement = (component, render) =>
  implement(component, (args) => {
    const urls = useContext(StoryUiImageUrls);
    const key = storyUiImageKeys[component.name];
    const value = key ? (args.props as Record<string, unknown>)[key] : undefined;
    const name = storyUiImageName(value);
    const node =
      typeof value === 'string' && !isStoryUiImageUrl(value)
        ? render({
            ...args,
            props: {
              ...args.props,
              [key]: name && urls && Object.hasOwn(urls, name) ? urls[name] : undefined,
            },
          })
        : render(args);
    const look = (args.props as { look?: unknown }).look;
    if (typeof look !== 'string' || !isValidElement<{ className?: string }>(node)) return node;
    if (node.type === Fragment) return node;
    const names = look.split(' ').map((name) => `look-${name}`);
    return cloneElement(node, {
      className: [node.props.className, ...names].filter(Boolean).join(' '),
    });
  });
type ChildRef = string | { id: string; basePath?: string };
type Build = (id: string, basePath?: string) => ReactNode;

const one = (child: ChildRef | undefined, build: Build) =>
  !child ? null : typeof child === 'string' ? build(child) : build(child.id, child.basePath);
const many = (children: unknown, build: Build) =>
  (Array.isArray(children) ? (children as ChildRef[]) : []).map((child) => (
    <Fragment key={typeof child === 'string' ? child : `${child.basePath}/${child.id}`}>
      {one(child, build)}
    </Fragment>
  ));
const flex = (weight: unknown): CSSProperties | undefined =>
  typeof weight === 'number' ? { flex: `${weight} 1 0%`, minWidth: 0 } : undefined;
const str = (value: unknown) => (value === undefined || value === null ? '' : String(value));
const JUSTIFY: Record<string, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  spaceBetween: 'space-between',
  spaceAround: 'space-around',
  spaceEvenly: 'space-evenly',
  stretch: 'stretch',
};
const ALIGN: Record<string, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
};
/** Charts and gauges show figures the way a reader writes them: grouped, without float noise. */
const figure = (value: number) =>
  Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '';

function Markdown({ text, className }: { text: string; className: string }) {
  const html = useMemo(() => compileReadingMarkdown(text).html, [text]);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: the reading compiler escapes raw HTML
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
function Portrait({ label, url, size }: { label: string; url?: string; size?: string }) {
  return (
    <span className="story-ui-avatar" data-size={size}>
      {isStoryUiImageUrl(url) ? <img src={url} alt={label} /> : [...label.trim()][0]}
    </span>
  );
}
function Errors({ props }: { props: { isValid?: boolean; validationErrors?: string[] } }) {
  if (props.isValid !== false || !props.validationErrors?.length) return null;
  return (
    <p className="story-ui-error" role="alert">
      {props.validationErrors.join(' ')}
    </p>
  );
}
function Caption({ children }: { children: ReactNode }) {
  return children ? <figcaption>{children}</figcaption> : null;
}

const Text = createComponentImplementation(api('Text'), ({ props }) => {
  const variant: string = props.variant ?? 'body';
  const shared = {
    className: `story-ui-text story-ui-text-${variant}`,
    'data-tone': props.tone,
    style: { ...flex(props.weight), textAlign: props.align },
  };
  const text = str(props.text);
  if (variant === 'body' || variant === 'quote')
    return (
      <div {...shared}>
        <Markdown text={text} className="story-ui-prose" />
      </div>
    );
  if (variant === 'headline') return <h3 {...shared}>{text}</h3>;
  if (variant === 'title') return <h4 {...shared}>{text}</h4>;
  return <p {...shared}>{text}</p>;
});
const Icon = createComponentImplementation(api('Icon'), ({ props, context }) => {
  // The SDK's generic binder leaves Icon's enum/SVG/binding union unresolved.
  const [name, setName] = useState<unknown>(() =>
    context.dataContext.resolveDynamicValue(props.name)
  );
  useEffect(() => {
    const subscription = context.dataContext.subscribeDynamicValue(props.name, setName);
    setName(subscription.value);
    return () => subscription.unsubscribe();
  }, [context.dataContext, props.name]);
  if (typeof name === 'string') {
    const Glyph = Object.hasOwn(storyUiIcons, name) ? storyUiIcons[name] : undefined;
    return Glyph ? (
      <Glyph className="story-ui-icon" aria-hidden="true" focusable="false" strokeWidth={1.5} />
    ) : null;
  }
  return name &&
    typeof name === 'object' &&
    'svgPath' in name &&
    typeof name.svgPath === 'string' ? (
    <svg
      className="story-ui-icon"
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d={name.svgPath} />
    </svg>
  ) : null;
});
const Image = createComponentImplementation(api('Image'), ({ props }) => {
  if (props.url === undefined) return null;
  return (
    <img
      className="story-ui-image"
      data-variant={props.variant ?? 'mediumFeature'}
      src={isStoryUiImageUrl(props.url) ? props.url : undefined}
      alt={props.description || ''}
      style={{
        ...flex(props.weight),
        objectFit: props.fit === 'scaleDown' ? 'scale-down' : (props.fit ?? 'cover'),
      }}
    />
  );
});
const Avatar = createComponentImplementation(api('Avatar'), ({ props }) => (
  <Portrait label={str(props.label)} url={props.url} size={props.size ?? 'medium'} />
));

const Row = createComponentImplementation(api('Row'), ({ props, buildChild }) => (
  <div
    className="story-ui-row"
    style={{
      ...flex(props.weight),
      justifyContent: JUSTIFY[props.justify],
      alignItems: ALIGN[props.align],
    }}
  >
    {many(props.children, buildChild)}
  </div>
));
const Column = createComponentImplementation(api('Column'), ({ props, buildChild }) => (
  <div
    className="story-ui-column"
    style={{
      ...flex(props.weight),
      justifyContent: JUSTIFY[props.justify],
      alignItems: ALIGN[props.align],
    }}
  >
    {many(props.children, buildChild)}
  </div>
));
const List = createComponentImplementation(api('List'), ({ props, buildChild }) => (
  <div
    className="story-ui-list"
    data-direction={props.direction ?? 'vertical'}
    style={{ ...flex(props.weight), alignItems: ALIGN[props.align] }}
  >
    {many(props.children, buildChild)}
  </div>
));
const Grid = createComponentImplementation(api('Grid'), ({ props, buildChild }) => (
  <div
    className="story-ui-grid"
    style={{ ...flex(props.weight), '--story-columns': props.columns ?? 3 } as CSSProperties}
  >
    {many(props.children, buildChild)}
  </div>
));
const Card = createComponentImplementation(api('Card'), ({ props, buildChild }) => (
  <div
    className="story-ui-card"
    data-surface={props.surface}
    data-accent={props.accent}
    style={flex(props.weight)}
  >
    {one(props.child, buildChild)}
  </div>
));
const Divider = createComponentImplementation(api('Divider'), ({ props }) => (
  <hr className="story-ui-divider" data-axis={props.axis ?? 'horizontal'} />
));
const Frame = createComponentImplementation(api('Frame'), ({ props, buildChild, context }) => (
  <section
    className="story-ui-frame"
    data-root={context.componentModel.id === 'root' || undefined}
    data-kind={props.kind ?? 'panel'}
    data-accent={props.accent}
    data-surface={props.surface}
    data-ornament={props.ornament}
    data-backdrop={isStoryUiImageUrl(props.backdrop) || undefined}
    style={flex(props.weight)}
  >
    {isStoryUiImageUrl(props.backdrop) && (
      <img className="story-ui-frame-backdrop" src={props.backdrop} alt="" />
    )}
    {(props.title || props.subtitle) && (
      <header className="story-ui-frame-head">
        {props.title && <span className="story-ui-frame-title">{str(props.title)}</span>}
        {props.subtitle && <span className="story-ui-frame-subtitle">{str(props.subtitle)}</span>}
      </header>
    )}
    <div className="story-ui-frame-body">{one(props.child, buildChild)}</div>
  </section>
));
const Hero = createComponentImplementation(api('Hero'), ({ props, buildChild }) => {
  const image = isStoryUiImageUrl(props.image);
  return (
    <header
      className="story-ui-hero"
      data-size={props.size ?? 'medium'}
      data-align={props.align ?? 'start'}
      data-accent={props.accent}
      data-image={image || undefined}
      style={flex(props.weight)}
    >
      {image && <img className="story-ui-hero-image" src={props.image} alt="" />}
      <div className="story-ui-hero-content">
        {props.label && <p className="story-ui-hero-label">{str(props.label)}</p>}
        <h3 className="story-ui-hero-title">{str(props.title)}</h3>
        {props.subtitle && <p className="story-ui-hero-subtitle">{str(props.subtitle)}</p>}
        {props.child && <div className="story-ui-hero-extra">{one(props.child, buildChild)}</div>}
      </div>
    </header>
  );
});
const Stack = createComponentImplementation(api('Stack'), ({ props, buildChild }) => (
  <div
    className="story-ui-stack"
    data-align={props.align ?? 'bottomStart'}
    style={flex(props.weight)}
  >
    {many(props.children, buildChild)}
  </div>
));
const Carousel = createComponentImplementation(api('Carousel'), ({ props, buildChild }) => (
  <div
    className="story-ui-carousel"
    role="group"
    aria-label={t('storyUi.carousel')}
    tabIndex={0}
    data-item={props.itemWidth ?? 'medium'}
    style={flex(props.weight)}
  >
    {many(props.children, buildChild)}
  </div>
));
const Details = createComponentImplementation(api('Details'), ({ props, buildChild }) => (
  <details className="story-ui-details" open={props.open} style={flex(props.weight)}>
    <summary>{str(props.title)}</summary>
    <div className="story-ui-details-body">{one(props.child, buildChild)}</div>
  </details>
));
const Tabs = createComponentImplementation(api('Tabs'), ({ props, buildChild }) => {
  const [selected, setSelected] = useState(0);
  const id = useId();
  const tabs: { title: string; child: ChildRef }[] = props.tabs ?? [];
  const current = Math.min(selected, tabs.length - 1);
  return (
    <div className="story-ui-tabset" style={flex(props.weight)}>
      <div role="tablist" className="story-ui-tabs">
        {tabs.map((tab, index) => (
          <button
            key={typeof tab.child === 'string' ? tab.child : tab.child.id}
            id={`${id}-tab-${index}`}
            type="button"
            role="tab"
            aria-selected={index === current}
            aria-controls={`${id}-panel-${index}`}
            tabIndex={index === current ? 0 : -1}
            onClick={() => setSelected(index)}
            onKeyDown={(event) => {
              const next =
                event.key === 'ArrowRight'
                  ? (index + 1) % tabs.length
                  : event.key === 'ArrowLeft'
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? tabs.length - 1
                        : -1;
              if (next >= 0) {
                event.preventDefault();
                setSelected(next);
                (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
              }
            }}
          >
            {tab.title}
          </button>
        ))}
      </div>
      {tabs[current] && (
        <div role="tabpanel" id={`${id}-panel-${current}`} aria-labelledby={`${id}-tab-${current}`}>
          {one(tabs[current].child, buildChild)}
        </div>
      )}
    </div>
  );
});
const Modal = createComponentImplementation(api('Modal'), ({ props, buildChild }) => {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <div className="story-ui-modal-trigger" onClick={() => dialog.current?.showModal()}>
        {one(props.trigger, buildChild)}
      </div>
      <dialog
        ref={dialog}
        className="story-ui-modal"
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        <div className="story-ui-modal-body">
          <button
            type="button"
            className="story-ui-modal-close"
            aria-label={t('storyUi.close')}
            onClick={() => dialog.current?.close()}
          >
            ×
          </button>
          {one(props.content, buildChild)}
        </div>
      </dialog>
    </>
  );
});

const Button = createComponentImplementation(api('Button'), ({ props, buildChild }) => (
  <button
    type="button"
    className="story-ui-button"
    data-variant={props.variant ?? 'default'}
    style={flex(props.weight)}
    disabled={props.isValid === false}
    onClick={() => props.action?.()}
  >
    {one(props.child, buildChild)}
  </button>
));
const TextField = createComponentImplementation(api('TextField'), ({ props }) => {
  const id = useId();
  const shared = {
    id,
    value: String(props.value ?? ''),
    placeholder: props.placeholder,
    'aria-invalid': props.isValid === false,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      props.setValue?.(event.target.value),
  };
  return (
    <div className="story-ui-field" style={flex(props.weight)}>
      <label htmlFor={id}>{props.label || props.placeholder || t('storyUi.input')}</label>
      {props.variant === 'longText' ? (
        <textarea {...shared} />
      ) : (
        <input
          {...shared}
          type={
            props.variant === 'number'
              ? 'number'
              : props.variant === 'obscured'
                ? 'password'
                : 'text'
          }
        />
      )}
      <Errors props={props} />
    </div>
  );
});
const CheckBox = createComponentImplementation(api('CheckBox'), ({ props }) => (
  <div className="story-ui-check" style={flex(props.weight)}>
    <label>
      <input
        type="checkbox"
        checked={!!props.value}
        aria-invalid={props.isValid === false}
        onChange={(event) => props.setValue?.(event.target.checked)}
      />
      <span>{str(props.label)}</span>
    </label>
    <Errors props={props} />
  </div>
));
const ChoicePicker = createComponentImplementation(api('ChoicePicker'), ({ props }) => {
  const group = useId();
  const [filter, setFilter] = useState('');
  const selected: string[] = Array.isArray(props.value)
    ? props.value
    : typeof props.value === 'string'
      ? [props.value]
      : [];
  const multiple = props.variant === 'multipleSelection';
  const toggle = (value: string) =>
    props.setValue?.(
      !multiple
        ? [value]
        : selected.includes(value)
          ? selected.filter((item) => item !== value)
          : [...selected, value]
    );
  const options: { label: string; value: string }[] = (props.options ?? []).filter(
    (option: { label: string }) =>
      !props.filterable || String(option.label).toLowerCase().includes(filter.toLowerCase())
  );
  return (
    <fieldset className="story-ui-choice" style={flex(props.weight)}>
      {props.label && <legend>{str(props.label)}</legend>}
      {props.filterable && (
        <input
          type="search"
          aria-label={t('storyUi.filter')}
          placeholder={t('storyUi.filter')}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      )}
      <div className="story-ui-choice-options" data-display={props.displayStyle ?? 'checkbox'}>
        {options.map((option) =>
          props.displayStyle === 'chips' ? (
            <button
              key={option.value}
              type="button"
              className="story-ui-chip"
              aria-pressed={selected.includes(option.value)}
              onClick={() => toggle(option.value)}
            >
              {option.label}
            </button>
          ) : (
            <label key={option.value}>
              <input
                type={multiple ? 'checkbox' : 'radio'}
                name={multiple ? undefined : group}
                checked={selected.includes(option.value)}
                onChange={() => toggle(option.value)}
              />
              <span>{option.label}</span>
            </label>
          )
        )}
      </div>
      <Errors props={props} />
    </fieldset>
  );
});
const Slider = createComponentImplementation(api('Slider'), ({ props }) => {
  const id = useId();
  const min = props.min ?? 0;
  const max = props.max ?? 100;
  return (
    <div className="story-ui-slider" style={flex(props.weight)}>
      <div className="story-ui-slider-head">
        <label htmlFor={id}>{str(props.label)}</label>
        <output htmlFor={id}>{str(props.value)}</output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={props.steps > 0 && max > min ? (max - min) / props.steps : undefined}
        value={Number(props.value ?? min)}
        onChange={(event) => props.setValue?.(Number(event.target.value))}
      />
      <Errors props={props} />
    </div>
  );
});
const part = (value: string, kind: 'date' | 'time') => {
  const [date, time] = value.includes('T') ? value.split('T') : [value, value];
  if (kind === 'date') return date.includes('-') ? date.slice(0, 10) : '';
  return time.includes(':') ? time.slice(0, 5) : '';
};
const DateTimeInput = createComponentImplementation(api('DateTimeInput'), ({ props }) => {
  const id = useId();
  const time: boolean = props.enableTime ?? false;
  const date: boolean = props.enableDate ?? !time;
  const value = str(props.value);
  const today = () => new Date().toLocaleDateString('sv-SE');
  return (
    <div className="story-ui-field story-ui-datetime" style={flex(props.weight)}>
      {props.label && <label htmlFor={id}>{str(props.label)}</label>}
      <div>
        {date && (
          <input
            id={id}
            type="date"
            min={part(str(props.min), 'date') || undefined}
            max={part(str(props.max), 'date') || undefined}
            value={part(value, 'date')}
            onChange={(event) =>
              props.setValue?.(
                time
                  ? `${event.target.value}T${part(value, 'time') || '00:00'}:00`
                  : event.target.value
              )
            }
          />
        )}
        {time && (
          <input
            id={date ? undefined : id}
            type="time"
            aria-label={date ? str(props.label) || t('storyUi.input') : undefined}
            min={part(str(props.min), 'time') || undefined}
            max={part(str(props.max), 'time') || undefined}
            value={part(value, 'time')}
            onChange={(event) =>
              props.setValue?.(
                date
                  ? `${part(value, 'date') || today()}T${event.target.value}:00`
                  : event.target.value
              )
            }
          />
        )}
      </div>
      <Errors props={props} />
    </div>
  );
});

const Message = createComponentImplementation(api('Message'), ({ props }) => {
  const side: string = props.side ?? 'left';
  if (side === 'center')
    return (
      <p className="story-ui-message" data-side="center" style={flex(props.weight)}>
        <span>{str(props.text)}</span>
      </p>
    );
  const sender = str(props.sender);
  return (
    <div className="story-ui-message" data-side={side} style={flex(props.weight)}>
      {side === 'left' && (sender || props.avatar) && (
        <Portrait label={sender} url={props.avatar} />
      )}
      <div className="story-ui-message-main">
        {sender && <span className="story-ui-message-sender">{sender}</span>}
        <div className="story-ui-message-line">
          <p className="story-ui-bubble">{str(props.text)}</p>
          {(props.status || props.time) && (
            <span className="story-ui-message-meta">
              {props.status && <span>{str(props.status)}</span>}
              {props.time && <time>{str(props.time)}</time>}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});
const Post = createComponentImplementation(api('Post'), ({ props, buildChild }) => {
  const variant: string = props.variant ?? 'post';
  const author = str(props.author);
  const replies = many(props.children, buildChild);
  const byline = (author || props.time) && (
    <p className="story-ui-post-byline">
      {author && <span className="story-ui-post-author">{author}</span>}
      {props.time && <time>{str(props.time)}</time>}
    </p>
  );
  return (
    <article className="story-ui-post" data-variant={variant} style={flex(props.weight)}>
      {variant === 'article' ? (
        <header className="story-ui-post-head">
          {props.tag && <p className="story-ui-post-kicker">{str(props.tag)}</p>}
          {props.title && <h3 className="story-ui-post-title">{str(props.title)}</h3>}
          {byline}
        </header>
      ) : (
        <>
          <header className="story-ui-post-head">
            {(author || props.avatar) && (
              <Portrait label={author} url={props.avatar} size="small" />
            )}
            {byline}
            {props.tag && <span className="story-ui-badge">{str(props.tag)}</span>}
          </header>
          {props.title && <h4 className="story-ui-post-title">{str(props.title)}</h4>}
        </>
      )}
      <Markdown text={str(props.text)} className="story-ui-post-body story-ui-prose" />
      {props.meta && <p className="story-ui-post-meta">{str(props.meta)}</p>}
      {replies.length > 0 && <div className="story-ui-post-replies">{replies}</div>}
    </article>
  );
});
const Notice = createComponentImplementation(api('Notice'), ({ props }) => {
  const Glyph =
    props.icon && Object.hasOwn(storyUiIcons, props.icon) ? storyUiIcons[props.icon] : undefined;
  return (
    <aside
      className="story-ui-notice"
      data-tone={props.tone ?? 'accent'}
      style={flex(props.weight)}
    >
      {Glyph && (
        <Glyph className="story-ui-icon" aria-hidden="true" focusable="false" strokeWidth={1.75} />
      )}
      <div>
        {props.title && <p className="story-ui-notice-title">{str(props.title)}</p>}
        <Markdown text={str(props.text)} className="story-ui-prose" />
      </div>
    </aside>
  );
});
const Badge = createComponentImplementation(api('Badge'), ({ props }) => (
  <span className="story-ui-badge" data-tone={props.tone}>
    {str(props.text)}
  </span>
));
const Stat = createComponentImplementation(api('Stat'), ({ props }) => (
  <div className="story-ui-stat" data-tone={props.tone} style={flex(props.weight)}>
    <span className="story-ui-stat-label">{str(props.label)}</span>
    <span className="story-ui-stat-value">
      {typeof props.value === 'number' ? figure(props.value) : str(props.value)}
    </span>
    {props.hint && <span className="story-ui-stat-hint">{str(props.hint)}</span>}
  </div>
));
const Gauge = createComponentImplementation(api('Gauge'), ({ props }) => {
  const min = Number(props.min);
  const max = Number(props.max);
  const value = Number(props.value);
  const ratio = Math.min(1, Math.max(0, (value - min) / (max - min || 1)));
  const label = str(props.label);
  return (
    <div className="story-ui-gauge" data-tone={props.tone} style={flex(props.weight)}>
      <div className="story-ui-gauge-head">
        <span className="story-ui-gauge-label">{label}</span>
        <span className="story-ui-gauge-value">
          <b>{figure(value)}</b>
          <span>/ {figure(max)}</span>
          {props.unit && <span>{props.unit}</span>}
        </span>
      </div>
      <div
        className="story-ui-gauge-track"
        role="meter"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Number.isFinite(value) ? value : min}
      >
        <span style={{ inlineSize: `${ratio * 100}%` }} />
      </div>
    </div>
  );
});
const Ring = createComponentImplementation(api('Ring'), ({ props }) => {
  const min = Number(props.min);
  const max = Number(props.max);
  const value = Number(props.value);
  const share = Math.min(1, Math.max(0, (value - min) / (max - min || 1))) * 100;
  const label = str(props.label);
  return (
    <div
      className="story-ui-ring"
      data-tone={props.tone}
      data-size={props.size ?? 'medium'}
      style={flex(props.weight)}
    >
      <div
        className="story-ui-ring-dial"
        role="meter"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Number.isFinite(value) ? value : min}
      >
        <svg viewBox="0 0 42 42" aria-hidden="true" focusable="false">
          <circle className="story-ui-ring-track" cx="21" cy="21" r="15.9155" />
          <circle
            className="story-ui-ring-fill"
            cx="21"
            cy="21"
            r="15.9155"
            strokeDasharray={`${share} ${100 - share}`}
            strokeDashoffset="25"
          />
        </svg>
        <span className="story-ui-ring-value">
          <b>{figure(value)}</b>
          {props.unit && <span>{props.unit}</span>}
        </span>
      </div>
      <span className="story-ui-ring-label">{label}</span>
    </div>
  );
});
const Dialogue = createComponentImplementation(api('Dialogue'), ({ props }) => {
  const speaker = str(props.speaker);
  return (
    <div
      className="story-ui-dialogue"
      data-side={props.side ?? 'left'}
      data-accent={props.accent}
      style={flex(props.weight)}
    >
      {isStoryUiImageUrl(props.portrait) && (
        <img className="story-ui-dialogue-portrait" src={props.portrait} alt={speaker} />
      )}
      <div className="story-ui-dialogue-box">
        {(speaker || props.status) && (
          <p className="story-ui-dialogue-head">
            {speaker && <span className="story-ui-dialogue-name">{speaker}</span>}
            {props.status && <span className="story-ui-dialogue-status">{str(props.status)}</span>}
          </p>
        )}
        <Markdown text={str(props.text)} className="story-ui-dialogue-text story-ui-prose" />
      </div>
    </div>
  );
});
type TimelineItem = { title: string; text?: string; time?: string; state?: string };
const Profile = createComponentImplementation(api('Profile'), ({ props, buildChild }) => {
  const name = str(props.title);
  const facts: { label: string; value: string }[] = props.items ?? [];
  return (
    <article className="story-ui-profile" data-accent={props.accent} style={flex(props.weight)}>
      <div className="story-ui-profile-portrait">
        {isStoryUiImageUrl(props.image) ? (
          <img src={props.image} alt={name} />
        ) : (
          <span aria-hidden="true">{[...name.trim()][0]}</span>
        )}
      </div>
      <div className="story-ui-profile-main">
        <header>
          <h4 className="story-ui-profile-name">{name}</h4>
          {props.subtitle && <p className="story-ui-profile-role">{str(props.subtitle)}</p>}
        </header>
        {props.text && (
          <Markdown text={str(props.text)} className="story-ui-profile-text story-ui-prose" />
        )}
        {facts.length > 0 && (
          <dl className="story-ui-profile-facts">
            {facts.map((fact, index) => (
              <div key={index}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {props.child && (
          <div className="story-ui-profile-extra">{one(props.child, buildChild)}</div>
        )}
      </div>
    </article>
  );
});
type ScheduleItem = { day: number; title: string; time?: string; text?: string; tone?: string };
const Schedule = createComponentImplementation(api('Schedule'), ({ props }) => {
  const days: string[] = props.days;
  const items: ScheduleItem[] = props.items ?? [];
  return (
    <figure className="story-ui-schedule" style={flex(props.weight)}>
      <Caption>{props.title}</Caption>
      <div
        className="story-ui-schedule-days"
        style={{ '--story-days': days.length } as CSSProperties}
      >
        {days.map((day, index) => (
          <section key={index} data-current={props.current === index || undefined}>
            <h5>{day}</h5>
            <ul>
              {items
                .filter((item) => item.day === index)
                .map((item, position) => (
                  <li key={position} data-tone={item.tone}>
                    {item.time && <time>{item.time}</time>}
                    <span className="story-ui-schedule-title">{item.title}</span>
                    {item.text && <span className="story-ui-schedule-text">{item.text}</span>}
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
    </figure>
  );
});
type CompareItem = { label: string; value: number; text?: string };
const Compare = createComponentImplementation(api('Compare'), ({ props }) => {
  const items: CompareItem[] = props.items;
  const max = Math.max(...items.map((item) => item.value)) || 1;
  const least = Math.min(...items.map((item) => item.value).filter((value) => value > 0));
  const bar = props.shape === 'bar';
  return (
    <figure
      className="story-ui-compare"
      data-shape={bar ? 'bar' : 'figure'}
      style={flex(props.weight)}
    >
      <Caption>{props.title}</Caption>
      <ol>
        {items.map((item, index) => {
          const size = `${Math.max(1.5, (item.value / max) * 100)}%`;
          return (
            <li key={index} data-series={index % 8}>
              <span className="story-ui-compare-value">
                {figure(item.value)}
                {props.unit}
              </span>
              <span className="story-ui-compare-stage" aria-hidden="true">
                {bar ? (
                  <span className="story-ui-compare-mark" style={{ blockSize: size }} />
                ) : (
                  // One silhouette scaled as a whole, so a small figure keeps its proportions.
                  <svg
                    className="story-ui-compare-mark"
                    viewBox="0 0 20 60"
                    focusable="false"
                    style={{ blockSize: size }}
                  >
                    <circle cx="10" cy="7" r="6" />
                    <path d="M3 22Q3 15 10 15Q17 15 17 22V58Q17 60 15 60H5Q3 60 3 58Z" />
                  </svg>
                )}
              </span>
              <span className="story-ui-compare-label">{item.label}</span>
              {item.text && <span className="story-ui-compare-text">{item.text}</span>}
              {Number.isFinite(least) && item.value > least && (
                <span className="story-ui-compare-ratio">×{figure(item.value / least)}</span>
              )}
            </li>
          );
        })}
      </ol>
    </figure>
  );
});
const Slot = createComponentImplementation(api('Slot'), ({ props }) => {
  const label = str(props.label);
  const Glyph =
    props.icon && Object.hasOwn(storyUiIcons, props.icon) ? storyUiIcons[props.icon] : undefined;
  const state: string | undefined = props.state;
  const mark = props.value;
  return (
    <div
      className="story-ui-slot"
      data-rarity={props.rarity}
      data-state={state}
      style={flex(props.weight)}
    >
      <span className="story-ui-slot-tile">
        {isStoryUiImageUrl(props.image) ? (
          <img src={props.image} alt="" />
        ) : Glyph ? (
          <Glyph className="story-ui-icon" aria-hidden="true" focusable="false" strokeWidth={1.5} />
        ) : (
          state !== 'empty' && <span aria-hidden="true">{[...label.trim()][0]}</span>
        )}
        {state && state !== 'empty' && (
          <span className="story-ui-slot-state">{t(`storyUi.slot.${state}`)}</span>
        )}
        {mark !== undefined && mark !== '' && (
          <span className="story-ui-slot-count">
            {typeof mark === 'number' ? figure(mark) : str(mark)}
          </span>
        )}
      </span>
      <span className="story-ui-slot-label">{label}</span>
    </div>
  );
});
const Rank = createComponentImplementation(api('Rank'), ({ props }) => {
  const total: number = props.max ?? 5;
  const stars: number | undefined = props.stars;
  return (
    <div className="story-ui-rank" data-tone={props.tone} style={flex(props.weight)}>
      <span className="story-ui-rank-stamp">{str(props.value)}</span>
      <div className="story-ui-rank-main">
        {props.label && <span className="story-ui-rank-label">{str(props.label)}</span>}
        {stars !== undefined && (
          <span
            className="story-ui-rank-stars"
            role="img"
            aria-label={`${figure(stars)} / ${total}`}
            style={
              {
                '--story-stars': Math.min(stars, total),
                '--story-star-max': total,
              } as CSSProperties
            }
          />
        )}
        {props.text && <span className="story-ui-rank-text">{str(props.text)}</span>}
      </div>
    </div>
  );
});
type Bar = { label: string; value: number; max: number; tone?: string };
const Combatant = createComponentImplementation(api('Combatant'), ({ props }) => {
  const name = str(props.title);
  const state: string | undefined = props.state;
  const effects: { label: string; tone?: string }[] = props.effects ?? [];
  return (
    <div
      className="story-ui-combatant"
      data-side={props.side ?? 'ally'}
      data-state={state}
      style={flex(props.weight)}
    >
      <Portrait label={name} url={props.image} size="medium" />
      <div className="story-ui-combatant-main">
        <p className="story-ui-combatant-head">
          <span className="story-ui-combatant-name">{name}</span>
          {props.subtitle && <span className="story-ui-combatant-rank">{str(props.subtitle)}</span>}
          {state && (
            <span className="story-ui-combatant-state">{t(`storyUi.combatant.${state}`)}</span>
          )}
        </p>
        {(props.bars as Bar[]).map((bar, index) => {
          const ratio = Math.min(1, Math.max(0, bar.value / bar.max));
          // The first bar is the one a fight is read by, so it warns as it empties.
          const tone =
            bar.tone ??
            (index > 0 ? 'info' : ratio > 0.5 ? 'positive' : ratio > 0.2 ? 'caution' : 'danger');
          return (
            <div key={index} className="story-ui-combatant-bar" data-tone={tone}>
              <span className="story-ui-combatant-label">{bar.label}</span>
              <span
                className="story-ui-combatant-track"
                role="meter"
                aria-label={`${name} ${bar.label}`}
                aria-valuemin={0}
                aria-valuemax={bar.max}
                aria-valuenow={bar.value}
              >
                <span style={{ inlineSize: `${ratio * 100}%` }} />
              </span>
              <span className="story-ui-combatant-value">
                <b>{figure(bar.value)}</b>/{figure(bar.max)}
              </span>
            </div>
          );
        })}
        {effects.length > 0 && (
          <p className="story-ui-combatant-effects">
            {effects.map((effect, index) => (
              <span key={index} className="story-ui-badge" data-tone={effect.tone}>
                {effect.label}
              </span>
            ))}
          </p>
        )}
      </div>
    </div>
  );
});
const Route = createComponentImplementation(api('Route'), ({ props }) => (
  <figure className="story-ui-route" style={flex(props.weight)}>
    <Caption>{props.title}</Caption>
    <ol>
      {(props.items as TimelineItem[]).map((item, index) => (
        <li key={index} data-state={item.state}>
          <span
            className="story-ui-route-mark"
            role={item.state ? 'img' : undefined}
            aria-label={item.state ? t(`storyUi.state.${item.state}`) : undefined}
          />
          <span className="story-ui-route-title">{item.title}</span>
          {item.time && <time>{item.time}</time>}
          {item.text && <span className="story-ui-route-text">{item.text}</span>}
        </li>
      ))}
    </ol>
  </figure>
));
type GraphNode = {
  id: string;
  label: string;
  text?: string;
  image?: string;
  tone?: string;
  state?: string;
};
type GraphEdge = {
  from: string;
  to: string;
  label?: string;
  tone?: string;
  arrow?: string;
  line?: string;
};
type Point = [number, number];
// Graph geometry is laid out in viewBox units; nodes and labels are sized from the same
// width through container units, so line ends meet the discs at any rendered size.
// A caption is the name and note under (or over) a disc.
const GRAPH = { width: 600, disc: 56, label: 112, margin: 24, caption: 64, row: 170, slot: 104 };
function placeGraph(nodes: GraphNode[], edges: GraphEdge[], tree: boolean, center?: string) {
  const points = new Map<string, Point>();
  // Captions on the upper half of a ring sit above their discs, clear of the lines going in.
  const above = new Set<string>();
  let width = GRAPH.width;
  if (tree) {
    const ids = new Set(nodes.map((node) => node.id));
    const links = edges.filter((e) => e.from !== e.to && ids.has(e.from) && ids.has(e.to));
    const depth = new Map<string, number>();
    const pointed = new Set(links.map((edge) => edge.to));
    const visit = (roots: string[]) => {
      const queue = roots.filter((id) => !depth.has(id));
      for (const id of queue) depth.set(id, 0);
      for (let index = 0; index < queue.length; index++) {
        const id = queue[index];
        for (const edge of links)
          if (edge.from === id && !depth.has(edge.to)) {
            depth.set(edge.to, depth.get(id)! + 1);
            queue.push(edge.to);
          }
      }
    };
    visit(nodes.filter((node) => !pointed.has(node.id)).map((node) => node.id));
    for (const node of nodes) visit([node.id]);
    const layers: string[][] = [];
    for (const node of nodes) (layers[depth.get(node.id)!] ??= []).push(node.id);
    width = Math.max(GRAPH.width, Math.max(...layers.map((layer) => layer.length)) * GRAPH.slot);
    layers.forEach((layer, row) => {
      // Each node sits under the average of its parents, which keeps most lines from crossing.
      const parent = (id: string) => {
        const xs = links
          .filter((edge) => edge.to === id && points.has(edge.from))
          .map((edge) => points.get(edge.from)![0]);
        return xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : width / 2;
      };
      const ordered = row === 0 ? layer : [...layer].sort((a, b) => parent(a) - parent(b));
      ordered.forEach((id, index) => {
        points.set(id, [(width * (index + 0.5)) / ordered.length, row * GRAPH.row]);
      });
    });
  } else {
    const middle = nodes.some((node) => node.id === center) ? center : undefined;
    const around = nodes.filter((node) => node.id !== middle);
    const count = around.length;
    const radiusX = count <= 3 && !middle ? 180 : 225;
    const radiusY = middle ? 190 : count <= 4 ? 120 : count <= 8 ? 160 : 190;
    // Two nodes face each other across the width; more start at the top.
    const offset = count === 2 ? Math.PI : -Math.PI / 2;
    around.forEach((node, index) => {
      const angle = offset + (index * Math.PI * 2) / count;
      if (Math.sin(angle) < -0.3 && !(count === 2 && middle)) above.add(node.id);
      points.set(node.id, [
        width / 2 + Math.cos(angle) * radiusX,
        Math.sin(angle) * radiusY * (count === 2 && middle ? 0 : 1),
      ]);
    });
    if (middle) points.set(middle, [width / 2, 0]);
  }
  const lowest = Math.min(...[...points.values()].map(([, y]) => y));
  const top = GRAPH.margin + GRAPH.disc / 2 + (above.size ? GRAPH.caption : 0);
  for (const point of points.values()) point[1] += top - lowest;
  const height =
    Math.max(...[...points.values()].map(([, y]) => y)) +
    GRAPH.disc / 2 +
    GRAPH.caption +
    GRAPH.margin;
  return { points, above, width, height };
}
type Box = [left: number, top: number, right: number, bottom: number];
const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
  Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
// Text is measured before layout from its length: CSS pixels per glyph at each label's
// size, and viewBox units per CSS pixel at the smallest width the canvas is drawn at.
const glyphs = (text = '') =>
  [...text].reduce((sum, glyph) => sum + (/[\u1100-\uffdc]/u.test(glyph) ? 1 : 0.6), 0);
const UNITS_PER_PIXEL = 1.6;
// Spots along a line, nearest the preferred one first.
const SPOTS = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7, 0.25, 0.75, 0.2, 0.8, 0.15, 0.85];
const PAIRED_SPOTS = [0.32, 0.27, 0.37, 0.22, 0.42, 0.17, 0.47];
/**
 * Each relation label takes the first spot along its line that keeps clear of the discs,
 * the names and the labels already placed; one of an opposite pair starts near its source.
 */
function placeRelations(
  lines: { edge: GraphEdge; head: Point; control: Point; tail: Point; paired: boolean }[],
  nodes: GraphNode[],
  points: Map<string, Point>,
  above: Set<string>
): Point[] {
  const taken: Box[] = nodes.flatMap((node) => {
    const [x, y] = points.get(node.id)!;
    const radius = GRAPH.disc / 2 + 4;
    const width = Math.min(
      GRAPH.label,
      (Math.max(glyphs(node.label) * 13.5, glyphs(node.text) * 11.5) + 12) * UNITS_PER_PIXEL
    );
    const height = (node.text ? 36 : 20) * UNITS_PER_PIXEL;
    const top = above.has(node.id) ? y - radius - height : y + radius;
    return [
      [x - radius, y - radius, x + radius, y + radius],
      [x - width / 2, top, x + width / 2, top + height],
    ];
  });
  return lines.map(({ edge, head, control, tail, paired }) => {
    const spots = (paired ? PAIRED_SPOTS : SPOTS).map(
      (at): Point => [
        (1 - at) ** 2 * head[0] + 2 * (1 - at) * at * control[0] + at ** 2 * tail[0],
        (1 - at) ** 2 * head[1] + 2 * (1 - at) * at * control[1] + at ** 2 * tail[1],
      ]
    );
    if (!edge.label) return spots[0];
    const width = Math.min(GRAPH.label, (glyphs(edge.label) * 11.5 + 14) * UNITS_PER_PIXEL);
    const height = 20 * UNITS_PER_PIXEL;
    const box = ([x, y]: Point): Box => [
      x - width / 2,
      y - height / 2,
      x + width / 2,
      y + height / 2,
    ];
    const cost = (spot: Point) => taken.reduce((sum, other) => sum + overlap(box(spot), other), 0);
    const best = spots.reduce((chosen, spot) => (cost(spot) < cost(chosen) ? spot : chosen));
    taken.push(box(best));
    return best;
  });
}
const arrowHead = (tip: Point, from: Point) => {
  const length = Math.hypot(tip[0] - from[0], tip[1] - from[1]) || 1;
  const [dx, dy] = [(tip[0] - from[0]) / length, (tip[1] - from[1]) / length];
  const base: Point = [tip[0] - dx * 11, tip[1] - dy * 11];
  return {
    points: `${tip[0]},${tip[1]} ${base[0] - dy * 5.5},${base[1] + dx * 5.5} ${base[0] + dy * 5.5},${base[1] - dx * 5.5}`,
    base,
  };
};
function layoutGraph(nodes: GraphNode[], given: GraphEdge[], tree: boolean, center?: string) {
  const ids = new Set(nodes.map((node) => node.id));
  const edges = given.filter(
    (edge) => edge.from !== edge.to && ids.has(edge.from) && ids.has(edge.to)
  );
  const { points, above, width, height } = placeGraph(nodes, edges, tree, center);
  const lines = edges.map((edge) => {
    const start = points.get(edge.from)!;
    const end = points.get(edge.to)!;
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]) || 1;
    // A pair of opposite edges bends apart, each to its own left, so both stay readable.
    const paired = edges.some((other) => other.from === edge.to && other.to === edge.from);
    const bend = paired ? 26 : 0;
    const control: Point = [
      (start[0] + end[0]) / 2 + ((end[1] - start[1]) / length) * bend,
      (start[1] + end[1]) / 2 - ((end[0] - start[0]) / length) * bend,
    ];
    const trim = (from: Point, toward: Point): Point => {
      const distance = Math.hypot(toward[0] - from[0], toward[1] - from[1]) || 1;
      const gap = GRAPH.disc / 2 + 4;
      return [
        from[0] + ((toward[0] - from[0]) / distance) * gap,
        from[1] + ((toward[1] - from[1]) / distance) * gap,
      ];
    };
    let head = trim(start, control);
    let tail = trim(end, control);
    const arrow = edge.arrow ?? 'end';
    const endHead = arrow !== 'none' ? arrowHead(tail, control) : undefined;
    const startHead = arrow === 'both' ? arrowHead(head, control) : undefined;
    if (endHead) tail = endHead.base;
    if (startHead) head = startHead.base;
    return { edge, head, tail, control, endHead, startHead, paired };
  });
  const middles = placeRelations(lines, nodes, points, above);
  return { points, above, width, height, edges, lines, middles };
}
const Graph = createComponentImplementation(api('Graph'), ({ props }) => {
  const urls = useContext(StoryUiImageUrls);
  const nodes: GraphNode[] = props.nodes;
  const { points, above, width, height, edges, lines, middles } = layoutGraph(
    nodes,
    props.edges,
    props.layout === 'tree',
    props.center
  );
  const names = new Map(nodes.map((node) => [node.id, node.label]));
  const percent = (value: number, total: number) => `${(value / total) * 100}%`;
  const units = (value: number) => `${(value / width) * 100}cqi`;
  const image = (value?: string) => {
    if (isStoryUiImageUrl(value)) return value;
    const name = storyUiImageName(value);
    return name && urls && Object.hasOwn(urls, name) ? urls[name] : undefined;
  };
  return (
    <figure
      className="story-ui-graph"
      data-layout={props.layout ?? 'ring'}
      style={flex(props.weight)}
    >
      <Caption>{props.title}</Caption>
      <div className="story-ui-graph-scroll">
        <div
          className="story-ui-graph-canvas"
          style={
            {
              aspectRatio: `${width} / ${height}`,
              minInlineSize: `${Math.round(width * 0.55)}px`,
              maxInlineSize: `${Math.round(width * 0.95)}px`,
              '--story-graph-disc': units(GRAPH.disc),
              '--story-graph-label': units(GRAPH.label),
            } as CSSProperties
          }
        >
          <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false">
            {lines.map(({ edge, head, tail, control, endHead, startHead }, index) => (
              <g
                key={index}
                className="story-ui-graph-edge"
                data-tone={edge.tone}
                data-line={edge.line}
              >
                <path
                  d={`M${head[0]},${head[1]} Q${control[0]},${control[1]} ${tail[0]},${tail[1]}`}
                />
                {endHead && <polygon points={endHead.points} />}
                {startHead && <polygon points={startHead.points} />}
              </g>
            ))}
          </svg>
          {lines.map(
            ({ edge }, index) =>
              edge.label && (
                <span
                  key={index}
                  className="story-ui-graph-relation"
                  data-tone={edge.tone}
                  aria-hidden="true"
                  style={{
                    left: percent(middles[index][0], width),
                    top: percent(middles[index][1], height),
                  }}
                >
                  {edge.label}
                </span>
              )
          )}
          {nodes.map((node) => {
            const [x, y] = points.get(node.id)!;
            const unknown = node.state === 'unknown';
            return (
              <div
                key={node.id}
                className="story-ui-graph-node"
                data-tone={node.tone}
                data-state={node.state}
                data-caption={above.has(node.id) ? 'above' : undefined}
                style={{ left: percent(x, width), top: percent(y, height) }}
              >
                <Portrait
                  label={unknown ? '?' : node.label}
                  url={unknown ? undefined : image(node.image)}
                />
                <span className="story-ui-graph-caption">
                  <span className="story-ui-graph-label">{node.label}</span>
                  {node.text && <span className="story-ui-graph-text">{node.text}</span>}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {edges.length > 0 && (
        <ul className="sr-only">
          {edges.map((edge, index) => (
            <li key={index}>
              {names.get(edge.from)} → {names.get(edge.to)}
              {edge.label && `: ${edge.label}`}
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
});
type MapArea = {
  x: number;
  y: number;
  w?: number;
  h?: number;
  label?: string;
  tone?: string;
  terrain?: string;
};
type MapMarker = {
  x: number;
  y: number;
  label: string;
  mark?: string;
  icon?: string;
  text?: string;
  tone?: string;
  state?: string;
};
const columnLetter = (index: number) => String.fromCharCode(65 + index);
function MapToken({ marker }: { marker: MapMarker }) {
  const Glyph =
    marker.icon && Object.hasOwn(storyUiIcons, marker.icon) ? storyUiIcons[marker.icon] : undefined;
  return (
    <span className="story-ui-map-token" data-tone={marker.tone} data-state={marker.state}>
      {Glyph ? (
        <Glyph className="story-ui-icon" aria-hidden="true" focusable="false" strokeWidth={2} />
      ) : (
        <span>{marker.mark || [...marker.label.trim()][0]}</span>
      )}
    </span>
  );
}
const MapBoard = createComponentImplementation(api('Map'), ({ props }) => {
  const columns: number = props.columns;
  const rows: number = props.rows;
  const coords = props.coords === true;
  const shift = coords ? 2 : 1;
  const inside = (item: { x: number; y: number }) => item.x < columns && item.y < rows;
  const areas = ((props.areas ?? []) as MapArea[]).filter(inside);
  const markers = ((props.markers ?? []) as MapMarker[]).filter(inside);
  const cells = new Map<string, MapMarker[]>();
  for (const marker of markers) {
    const key = `${marker.x},${marker.y}`;
    cells.set(key, [...(cells.get(key) ?? []), marker]);
  }
  const place = (x: number, y: number, w = 1, h = 1): CSSProperties => ({
    gridColumn: `${x + shift} / span ${Math.min(w, columns - x)}`,
    gridRow: `${y + shift} / span ${Math.min(h, rows - y)}`,
  });
  return (
    <figure className="story-ui-map" data-coords={coords || undefined} style={flex(props.weight)}>
      <Caption>{props.title}</Caption>
      <div className="story-ui-map-scroll">
        <div
          className="story-ui-map-board"
          style={{ '--story-map-columns': columns, '--story-map-rows': rows } as CSSProperties}
          aria-hidden="true"
        >
          <span className="story-ui-map-ground" style={place(0, 0, columns, rows)} />
          {coords &&
            Array.from({ length: columns }, (_, x) => (
              <span
                key={`c${x}`}
                className="story-ui-map-coord"
                style={{ gridColumn: x + 2, gridRow: 1 }}
              >
                {columnLetter(x)}
              </span>
            ))}
          {coords &&
            Array.from({ length: rows }, (_, y) => (
              <span
                key={`r${y}`}
                className="story-ui-map-coord"
                style={{ gridColumn: 1, gridRow: y + 2 }}
              >
                {y + 1}
              </span>
            ))}
          {areas.map((area, index) => (
            <span
              key={index}
              className="story-ui-map-area"
              data-terrain={area.terrain ?? 'floor'}
              data-tone={area.tone}
              style={place(area.x, area.y, area.w, area.h)}
            >
              {area.label && <span className="story-ui-map-area-label">{area.label}</span>}
            </span>
          ))}
          {[...cells.values()].map((group) => (
            <span
              key={`${group[0].x},${group[0].y}`}
              className="story-ui-map-cell"
              data-count={Math.min(group.length, 4)}
              style={place(group[0].x, group[0].y)}
            >
              {group.map((marker, index) => (
                <MapToken key={index} marker={marker} />
              ))}
            </span>
          ))}
        </div>
      </div>
      {markers.length > 0 && (
        <ul className="story-ui-map-legend">
          {markers.map((marker, index) => (
            <li key={index} data-state={marker.state}>
              <MapToken marker={marker} />
              <span className="story-ui-map-legend-label">{marker.label}</span>
              {coords && (
                <span className="story-ui-map-legend-at">
                  {columnLetter(marker.x)}
                  {marker.y + 1}
                </span>
              )}
              {marker.text && <span className="story-ui-map-legend-text">{marker.text}</span>}
            </li>
          ))}
        </ul>
      )}
      {areas.some((area) => area.label) && (
        <ul className="sr-only">
          {areas
            .filter((area) => area.label)
            .map((area, index) => (
              <li key={index}>{area.label}</li>
            ))}
        </ul>
      )}
    </figure>
  );
});
type CalendarItem = { date: number; title: string; time?: string; text?: string; tone?: string };
const WEEKEND: Record<number, string> = { 0: 'sunday', 6: 'saturday' };
const weekdayNames = () => {
  const format = new Intl.DateTimeFormat(getIntlLocale(), { weekday: 'short', timeZone: 'UTC' });
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, day) => format.format(Date.UTC(2023, 0, 1 + day)));
};
const Calendar = createComponentImplementation(api('Calendar'), ({ props }) => {
  const month: string | undefined = props.month;
  const given: string[] | undefined = props.days;
  let columns = given?.length ?? 7;
  let start: number = props.start ?? 0;
  let length: number = props.length ?? 30;
  if (month) {
    const [year, number] = month.split('-').map(Number);
    columns = 7;
    start = new Date(Date.UTC(year, number - 1, 1)).getUTCDay();
    length = new Date(Date.UTC(year, number, 0)).getUTCDate();
  }
  start = Math.min(start, columns - 1);
  const days = given && given.length === columns ? given : columns === 7 ? weekdayNames() : [];
  const items = ((props.items ?? []) as CalendarItem[])
    .filter((item) => item.date <= length)
    .sort((a, b) => a.date - b.date);
  const weekday = (date: number) => (start + date - 1) % columns;
  const weekend = (date: number) => (month ? WEEKEND[weekday(date)] : undefined);
  const trailing = (columns - ((start + length) % columns)) % columns;
  return (
    <figure className="story-ui-calendar" style={flex(props.weight)}>
      <Caption>{props.title}</Caption>
      <div
        className="story-ui-calendar-grid"
        style={{ '--story-calendar-columns': columns } as CSSProperties}
      >
        {days.map((day, index) => (
          <span
            key={`h${index}`}
            className="story-ui-calendar-weekday"
            data-weekend={month ? WEEKEND[index] : undefined}
          >
            {day}
          </span>
        ))}
        {Array.from({ length: start }, (_, index) => (
          <span key={`b${index}`} className="story-ui-calendar-blank" />
        ))}
        {Array.from({ length }, (_, index) => {
          const date = index + 1;
          const entries = items.filter((item) => item.date === date);
          return (
            <div
              key={date}
              className="story-ui-calendar-date"
              data-current={props.current === date || undefined}
              data-weekend={weekend(date)}
              data-busy={entries.length > 0 || undefined}
            >
              <span className="story-ui-calendar-number">{date}</span>
              {entries.length > 0 && (
                <ul>
                  {entries.map((item, position) => (
                    <li key={position} data-tone={item.tone}>
                      {item.title}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
        {Array.from({ length: trailing }, (_, index) => (
          <span key={`t${index}`} className="story-ui-calendar-blank" />
        ))}
      </div>
      {items.length > 0 && (
        <ol className="story-ui-calendar-agenda">
          {items.map((item, index) => (
            <li
              key={index}
              data-tone={item.tone}
              data-detail={item.time || item.text ? true : undefined}
            >
              <span className="story-ui-calendar-when">
                <b>{item.date}</b>
                {days[weekday(item.date)] && ` ${days[weekday(item.date)]}`}
              </span>
              {item.time && <time>{item.time}</time>}
              <span className="story-ui-calendar-title">{item.title}</span>
              {item.text && <span className="story-ui-calendar-text">{item.text}</span>}
            </li>
          ))}
        </ol>
      )}
    </figure>
  );
});
const KeyValue = createComponentImplementation(api('KeyValue'), ({ props }) => (
  <figure className="story-ui-keyvalue" style={flex(props.weight)}>
    <Caption>{props.title}</Caption>
    <dl>
      {(props.items as { label: string; value: string }[]).map((item, index) => (
        <div key={index}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  </figure>
));
const Timeline = createComponentImplementation(api('Timeline'), ({ props }) => (
  <figure className="story-ui-timeline" style={flex(props.weight)}>
    <Caption>{props.title}</Caption>
    <ol>
      {(props.items as TimelineItem[]).map((item, index) => (
        <li key={index} data-state={item.state}>
          <span
            className="story-ui-timeline-mark"
            role={item.state ? 'img' : undefined}
            aria-label={item.state ? t(`storyUi.state.${item.state}`) : undefined}
          />
          <div>
            <p className="story-ui-timeline-title">
              <span>{item.title}</span>
              {item.time && <time>{item.time}</time>}
            </p>
            {item.text && <p className="story-ui-timeline-text">{item.text}</p>}
          </div>
        </li>
      ))}
    </ol>
  </figure>
));
const DataTable = createComponentImplementation(api('DataTable'), ({ props }) => {
  const rows: string[][] = props.rows;
  // A column of figures aligns to the end, heading included.
  const numeric = (props.columns as string[]).map((_, column) => {
    const cells = rows.map((row) => row[column]?.trim()).filter(Boolean);
    return (
      (cells.length > 0 &&
        cells.every((cell) => /^[+\-−]?\d[\d,.]*\s*[%a-zA-Z가-힣]{0,4}$/u.test(cell))) ||
      undefined
    );
  });
  return (
    <figure style={flex(props.weight)}>
      <Caption>{props.title}</Caption>
      <div className="story-ui-table">
        <table>
          <thead>
            <tr>
              {(props.columns as string[]).map((column, index) => (
                <th key={index} scope="col" data-numeric={numeric[index]}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {row.map((cell, column) => (
                  <td key={column} data-numeric={numeric[column]}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
});

type ChartItem = { label: string; value: number };
type ChartProps = {
  title: string;
  items: ChartItem[];
  unit?: string;
  max?: number;
  weight?: number;
};
const summary = (items: ChartItem[], unit = '') =>
  items.map((item) => `${item.label}: ${item.value}${unit}`).join(', ');
const BarChart = createComponentImplementation(api('BarChart'), ({ props: resolved }) => {
  const props = resolved as ChartProps;
  const min = Math.min(0, ...props.items.map((item) => item.value));
  const max = Math.max(0, ...props.items.map((item) => item.value));
  const span = max - min || 1;
  const zero = (-min / span) * 100;
  return (
    <figure style={flex(props.weight)}>
      <Caption>{props.title}</Caption>
      <ul className="story-ui-chart">
        {props.items.map((item, index) => (
          <li key={index} data-negative={item.value < 0 || undefined}>
            <span>{item.label}</span>
            <span className="story-ui-bar-track" aria-hidden="true">
              {min < 0 && <span className="story-ui-zero" style={{ left: `${zero}%` }} />}
              <span
                className="story-ui-bar"
                style={{
                  left: `${Math.min(zero, ((item.value - min) / span) * 100)}%`,
                  width: `${(Math.abs(item.value) / span) * 100}%`,
                }}
              />
            </span>
            <span>
              {figure(item.value)}
              {props.unit}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
});
const LineChart = createComponentImplementation(api('LineChart'), ({ props: resolved }) => {
  const props = resolved as ChartProps;
  const values = props.items.map((item) => item.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((value, index) => [
    values.length === 1 ? 50 : (index / (values.length - 1)) * 100,
    90 - ((value - min) / span) * 80,
  ]);
  const line = points.map(([x, y]) => `${x},${y}`).join(' ');
  return (
    <figure style={flex(props.weight)}>
      <Caption>{props.title}</Caption>
      <div className="story-ui-line-plot">
        <div className="story-ui-line-scale" aria-hidden="true">
          <span>
            {figure(max)}
            {props.unit}
          </span>
          <span>
            {figure(min)}
            {props.unit}
          </span>
        </div>
        <div className="story-ui-line-canvas">
          <svg
            className="story-ui-line"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            role="img"
            aria-label={summary(props.items, props.unit)}
          >
            <polygon
              className="story-ui-line-area"
              points={`${points[0][0]},100 ${line} ${points[points.length - 1][0]},100`}
            />
            <polyline
              points={line}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <div className="story-ui-line-dots" aria-hidden="true">
            {points.map(([x, y], index) => (
              <span key={index} style={{ left: `${x}%`, top: `${y}%` }} />
            ))}
          </div>
        </div>
      </div>
      <ol className="story-ui-line-labels">
        {props.items.map((item, index) => (
          <li key={index}>
            <span>{item.label}</span>
            <b>
              {figure(item.value)}
              {props.unit}
            </b>
          </li>
        ))}
      </ol>
    </figure>
  );
});
const PieChart = createComponentImplementation(api('PieChart'), ({ props: resolved }) => {
  const props = resolved as ChartProps;
  const items = props.items.map((item) => ({ ...item, value: Math.max(0, item.value) }));
  const total = items.reduce((sum, item) => sum + item.value, 0) || 1;
  let offset = 0;
  return (
    <figure style={flex(props.weight)}>
      <Caption>{props.title}</Caption>
      <div className="story-ui-pie">
        <svg viewBox="0 0 42 42" role="img" aria-label={summary(props.items, props.unit)}>
          {items.map((item, index) => {
            const share = (item.value / total) * 100;
            const start = offset;
            offset += share;
            return (
              <circle
                key={index}
                data-series={index % 8}
                cx="21"
                cy="21"
                r="15.9155"
                fill="none"
                strokeWidth="6"
                strokeDasharray={`${share} ${100 - share}`}
                strokeDashoffset={25 - start}
              />
            );
          })}
        </svg>
        <ul>
          {items.map((item, index) => (
            <li key={index} data-series={index % 8}>
              <span>{item.label}</span>
              <b>
                {figure(props.items[index].value)}
                {props.unit}
              </b>
              <span>{Math.round((item.value / total) * 100)}%</span>
            </li>
          ))}
        </ul>
      </div>
    </figure>
  );
});
const RadarChart = createComponentImplementation(api('RadarChart'), ({ props: resolved }) => {
  const props = resolved as ChartProps;
  const count = props.items.length;
  const limit = props.max ?? Math.max(...props.items.map((item) => item.value), 1);
  const at = (index: number, radius: number) => {
    const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
    return [50 + Math.cos(angle) * radius, 50 + Math.sin(angle) * radius];
  };
  const ring = (radius: number) =>
    props.items.map((_, index) => at(index, radius).join(',')).join(' ');
  return (
    <figure style={flex(props.weight)}>
      <Caption>{props.title}</Caption>
      <svg
        className="story-ui-radar"
        viewBox="-22 -8 144 116"
        role="img"
        aria-label={summary(props.items)}
      >
        {[10, 20, 30, 40].map((radius) => (
          <polygon key={radius} className="story-ui-radar-grid" points={ring(radius)} />
        ))}
        {props.items.map((_, index) => {
          const [x, y] = at(index, 40);
          return <line key={index} className="story-ui-radar-grid" x1="50" y1="50" x2={x} y2={y} />;
        })}
        <polygon
          className="story-ui-radar-area"
          points={props.items
            .map((item, index) =>
              at(index, Math.min(1, Math.max(0, item.value / limit)) * 40).join(',')
            )
            .join(' ')}
        />
        {props.items.map((item, index) => {
          const [x, y] = at(index, 49);
          return (
            <text
              key={index}
              x={x}
              y={y}
              textAnchor={Math.abs(x - 50) < 4 ? 'middle' : x > 50 ? 'start' : 'end'}
              dominantBaseline={y < 20 ? 'auto' : y > 80 ? 'hanging' : 'middle'}
            >
              <tspan>{item.label}</tspan>
              <tspan className="story-ui-radar-value" dx="2">
                {figure(item.value)}
              </tspan>
            </text>
          );
        })}
      </svg>
    </figure>
  );
});

const implementations = new Map(
  [
    Text,
    Icon,
    Image,
    Avatar,
    Row,
    Column,
    List,
    Grid,
    Card,
    Divider,
    Frame,
    Hero,
    Stack,
    Carousel,
    Ring,
    Dialogue,
    Profile,
    Schedule,
    Compare,
    Slot,
    Rank,
    Route,
    Combatant,
    Graph,
    MapBoard,
    Calendar,
    Details,
    Tabs,
    Modal,
    Button,
    TextField,
    CheckBox,
    ChoicePicker,
    Slider,
    DateTimeInput,
    Message,
    Post,
    Notice,
    Badge,
    Stat,
    Gauge,
    KeyValue,
    Timeline,
    DataTable,
    BarChart,
    LineChart,
    PieChart,
    RadarChart,
  ].map((entry) => [entry.name, entry])
);
export const storyUiRenderCatalog = new Catalog(
  storyUiCatalog.id,
  '1.0',
  [...storyUiCatalog.components.keys()].map((name) => implementations.get(name)!),
  [...storyUiCatalog.functions.keys()].map((name) => basicCatalog.functions.get(name)!),
  {
    defs: storyUiCatalog.defs,
    defModels: storyUiCatalog.defModels,
    themeSchema: storyUiCatalog.themeSchema,
    commonTypesUri: storyUiCatalog.commonTypesUri,
  }
);
