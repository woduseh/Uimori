import { createComponentImplementation } from '@a2ui/react';
import { Catalog } from '@a2ui/web_core';
import { basicCatalog } from '@a2ui/web_core/catalogs/basic/v1';
import { useId, useState } from 'react';
import { storyUiCatalog, storyUiExtensions } from '../core/story-ui-catalog.js';
import { t } from './i18n.js';

const api = (name: string) => storyUiCatalog.components.get(name)!;
const Button = createComponentImplementation(api('Button'), ({ props, buildChild }) => (
  <button type="button" disabled={props.isValid === false} onClick={() => props.action?.()}>
    {props.child && buildChild(props.child)}
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
    <div className="story-ui-field">
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
    </div>
  );
});
const Tabs = createComponentImplementation(api('Tabs'), ({ props, buildChild }) => {
  const [selected, setSelected] = useState(0);
  const id = useId();
  const tabs = props.tabs ?? [];
  const current = Math.min(selected, tabs.length - 1);
  return (
    <div>
      <div role="tablist" className="story-ui-tabs">
        {tabs.map((tab: { title: string; child: string }, index: number) => (
          <button
            key={tab.child}
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
          {buildChild(tabs[current].child)}
        </div>
      )}
    </div>
  );
});
const extensions = storyUiExtensions.map((entry) =>
  createComponentImplementation(entry, ({ props: resolved }) => {
    const props = resolved as {
      title: string;
      columns: string[];
      rows: string[][];
      label: string;
      value: number;
      min: number;
      max: number;
      unit?: string;
      items: { label: string; value: number }[];
    };
    if (entry.name === 'DataTable')
      return (
        <figure>
          <figcaption>{props.title}</figcaption>
          <div className="story-ui-table">
            <table>
              <thead>
                <tr>
                  {props.columns.map((column: string, index: number) => (
                    <th key={index} scope="col">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {props.rows.map((row: string[], index: number) => (
                  <tr key={index}>
                    {row.map((cell, column) => (
                      <td key={column}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </figure>
      );
    if (entry.name === 'Gauge')
      return (
        <div>
          <label>
            {props.label}: {props.value}
            {props.unit}
          </label>
          <meter min={props.min} max={props.max} value={props.value} />
        </div>
      );
    if (entry.name === 'LineChart') {
      const values = props.items.map((item) => item.value);
      const min = Math.min(...values);
      const span = Math.max(...values) - min || 1;
      const points = values
        .map(
          (value, index) =>
            `${values.length === 1 ? 50 : (index / (values.length - 1)) * 100},${90 - ((value - min) / span) * 80}`
        )
        .join(' ');
      return (
        <figure>
          <figcaption>{props.title}</figcaption>
          <svg
            className="story-ui-line"
            viewBox="0 0 100 100"
            role="img"
            aria-label={props.items.map((item) => `${item.label}: ${item.value}`).join(', ')}
          >
            <polyline
              points={points}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
            {points.split(' ').map((point, index) => {
              const [cx, cy] = point.split(',').map(Number);
              return <circle key={index} cx={cx} cy={cy} r="1.5" fill="currentColor" />;
            })}
          </svg>
          <ul>
            {props.items.map((item, index) => (
              <li key={index}>
                {item.label}: {item.value}
              </li>
            ))}
          </ul>
        </figure>
      );
    }
    const min = Math.min(0, ...props.items.map((item) => item.value));
    const max = Math.max(0, ...props.items.map((item) => item.value));
    const span = max - min || 1;
    const zero = (-min / span) * 100;
    return (
      <figure>
        <figcaption>{props.title}</figcaption>
        <ul className="story-ui-chart">
          {props.items.map((item: { label: string; value: number }, index: number) => (
            <li key={index}>
              <span>{item.label}</span>
              <span className="story-ui-bar-track" aria-hidden="true">
                <span className="story-ui-zero" style={{ left: `${zero}%` }} />
                <span
                  className="story-ui-bar"
                  style={{
                    left: `${Math.min(zero, ((item.value - min) / span) * 100)}%`,
                    width: `${(Math.abs(item.value) / span) * 100}%`,
                  }}
                />
              </span>
              <span>{item.value}</span>
            </li>
          ))}
        </ul>
      </figure>
    );
  })
);
const overrides = new Map(
  [Button, TextField, Tabs, ...extensions].map((entry) => [entry.name, entry])
);
export const storyUiRenderCatalog = new Catalog(
  storyUiCatalog.id,
  '1.0',
  [...storyUiCatalog.components.values()].map(
    (entry) => overrides.get(entry.name) ?? basicCatalog.components.get(entry.name)!
  ),
  [...storyUiCatalog.functions.keys()].map((name) => basicCatalog.functions.get(name)!),
  {
    defs: storyUiCatalog.defs,
    defModels: storyUiCatalog.defModels,
    themeSchema: storyUiCatalog.themeSchema,
    commonTypesUri: storyUiCatalog.commonTypesUri,
  }
);
