import { createComponentImplementation } from '@a2ui/react';
import { Catalog } from '@a2ui/web_core';
import { basicCatalog } from '@a2ui/web_core/catalogs/basic/v1';
import {
  type CSSProperties,
  Fragment,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { compileReadingMarkdown } from '../core/reading-markdown.js';
import { storyUiCatalog } from '../core/story-ui-catalog.js';
import { isStoryUiImageUrl } from '../core/story-ui.js';
import { storyUiIcons } from './story-ui-icons.js';
import { t } from './i18n.js';

// Every component renders in the light DOM with `story-ui-*` class names, so the presets in
// story-ui.css and authored themes style the same markup. The SDK supplies data binding,
// validation and actions; none of its own elements or styles are used.
const api = (name: string) => storyUiCatalog.components.get(name)!;
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
const Image = createComponentImplementation(api('Image'), ({ props }) => (
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
));
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
  <div className="story-ui-card" style={flex(props.weight)}>
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
    style={flex(props.weight)}
  >
    {(props.title || props.subtitle) && (
      <header className="story-ui-frame-head">
        {props.title && <span className="story-ui-frame-title">{str(props.title)}</span>}
        {props.subtitle && <span className="story-ui-frame-subtitle">{str(props.subtitle)}</span>}
      </header>
    )}
    <div className="story-ui-frame-body">{one(props.child, buildChild)}</div>
  </section>
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
type TimelineItem = { title: string; text?: string; time?: string; state?: string };
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
