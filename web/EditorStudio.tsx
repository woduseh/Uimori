import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ActionMenu } from './ActionMenu.js';
import { SectionNavigation } from './SectionNavigation.js';
import { useCompactLayout } from './useCompactLayout.js';
import { DropdownIcon } from './ui-icons.js';
import { formatNumber, t } from './i18n.js';
import { usePublishedEditorLocation, type EditorLocationItem } from './resource-editor.js';
import type { StudioSection } from './studio-sections.js';
import './editor-studio.css';

const rememberedSections = new Map<string, string>();

export function useStudioSection<K extends string>(
  memoryKey: string,
  available: readonly K[],
  fallback: K,
  restore: boolean
) {
  const [chosen, setChosen] = useState(
    () => ((restore && rememberedSections.get(memoryKey)) || fallback) as K
  );
  const select = useCallback(
    (id: K) => {
      rememberedSections.set(memoryKey, id);
      setChosen(id);
    },
    [memoryKey]
  );
  return [available.includes(chosen) ? chosen : fallback, select] as const;
}

type SetStudioItem = (section: string, item: EditorLocationItem | null) => void;
const Studio = createContext<{ idPrefix: string; current: string } | null>(null);
const StudioItems = createContext<SetStudioItem | null>(null);
const PanelSection = createContext<string | null>(null);

export function StudioPanel({
  section,
  className,
  children,
}: {
  section: string;
  className?: string;
  children: ReactNode;
}) {
  const studio = useContext(Studio);
  const prefix = studio?.idPrefix ?? '';
  return (
    <PanelSection.Provider value={section}>
      <div
        id={`${prefix}-${section}-panel`}
        role="tabpanel"
        aria-labelledby={`${prefix}-${section}-tab`}
        data-studio-section={section}
        hidden={studio?.current !== section}
        className={className}
      >
        {children}
      </div>
    </PanelSection.Provider>
  );
}

export function useStudioItem(index: number | null, label: string, panel?: string) {
  const setItem = useContext(StudioItems);
  const section = useContext(PanelSection) ?? panel ?? null;
  useEffect(() => {
    if (!setItem || !section) return;
    setItem(section, index === null ? null : { index, label });
  }, [setItem, section, index, label]);
  useEffect(() => {
    if (!setItem || !section) return;
    return () => setItem(section, null);
  }, [setItem, section]);
}

export function EditorStudio<K extends string>({
  header,
  notice,
  label,
  sections: placed,
  changed = [],
  value,
  onSelect,
  idPrefix,
  children,
}: {
  header: ReactNode;
  notice?: ReactNode;
  label: string;
  sections: readonly StudioSection<K>[];
  changed?: readonly { id: K }[];
  value: K;
  onSelect: (id: K) => void;
  idPrefix: string;
  children: ReactNode;
}) {
  const compact = useCompactLayout();
  const canvas = useRef<HTMLDivElement>(null);
  const shown = useRef(value);
  const focusTab = useRef<K | null>(null);
  const [items, setItems] = useState<Record<string, EditorLocationItem>>({});
  const setItem = useCallback((section: string, item: EditorLocationItem | null) => {
    setItems((current) => {
      const old = current[section];
      if (item ? old?.index === item.index && old.label === item.label : !old) return current;
      const next = { ...current };
      if (item) next[section] = item;
      else delete next[section];
      return next;
    });
  }, []);
  const item = items[value];
  usePublishedEditorLocation(
    useMemo(() => (item ? { section: value, item } : { section: value }), [value, item])
  );
  useLayoutEffect(() => {
    if (shown.current === value) return;
    shown.current = value;
    canvas.current?.scrollTo({ top: 0 });
    if (focusTab.current !== value) return;
    focusTab.current = null;
    document.getElementById(`${idPrefix}-${value}-tab`)?.focus();
  }, [value, idPrefix]);
  const sections = placed.map((section) =>
    changed.some((item) => item.id === section.id) ? { ...section, changed: true } : section
  );
  const rail = sections.filter((section) => !section.more);
  const more = sections.filter((section) => section.more);
  const studio = useMemo(() => ({ idPrefix, current: value as string }), [idPrefix, value]);
  return (
    <div className="editor-studio">
      <div className="editor-studio-header">
        {header}
        {notice}
      </div>
      {compact && (
        <StudioSectionPicker
          label={label}
          rail={rail}
          more={more}
          value={value}
          onSelect={onSelect}
          idPrefix={idPrefix}
        />
      )}
      <div className="editor-studio-body">
        {!compact && (
          <div className="editor-studio-rail">
            <SectionNavigation
              label={label}
              items={rail}
              value={value}
              onSelect={onSelect}
              compact={false}
              orientation="vertical"
              idPrefix={idPrefix}
            />
            <StudioMoreSections
              sections={more}
              value={value}
              idPrefix={idPrefix}
              onSelect={(id) => {
                focusTab.current = id;
                onSelect(id);
              }}
            />
          </div>
        )}
        <div ref={canvas} className="editor-studio-canvas">
          <StudioItems.Provider value={setItem}>
            <Studio.Provider value={studio}>{children}</Studio.Provider>
          </StudioItems.Provider>
        </div>
      </div>
    </div>
  );
}

function StudioMoreSections<K extends string>({
  sections,
  value,
  idPrefix,
  onSelect,
}: {
  sections: readonly StudioSection<K>[];
  value: K;
  idPrefix: string;
  onSelect: (id: K) => void;
}) {
  if (!sections.length) return null;
  const label = t('shared.moreSections', { count: sections.length });
  return (
    <details className="editor-studio-more">
      <summary>{label}</summary>
      <SectionNavigation
        label={label}
        items={sections}
        value={value}
        compact
        idPrefix={idPrefix}
        onSelect={onSelect}
      />
    </details>
  );
}

function StudioSectionPicker<K extends string>({
  label,
  rail,
  more,
  value,
  onSelect,
  idPrefix,
}: {
  label: string;
  rail: readonly StudioSection<K>[];
  more: readonly StudioSection<K>[];
  value: K;
  onSelect: (id: K) => void;
  idPrefix: string;
}) {
  const body = useRef<HTMLDivElement>(null);
  const current = rail.find((item) => item.id === value);
  const choose = (id: K) => {
    onSelect(id);
    const menu = body.current?.closest('details.action-menu') as HTMLDetailsElement | null;
    if (!menu) return;
    menu.open = false;
    menu.querySelector<HTMLElement>(':scope > summary')?.focus();
  };
  return (
    <ActionMenu
      className="editor-studio-picker"
      label={t('shared.selectEditorSection')}
      summary={
        <>
          <span className="editor-studio-picker-current" aria-hidden="true">
            {current?.title}
            {!!current?.count && (
              <span className="section-navigation-count">{formatNumber(current.count)}</span>
            )}
          </span>
          {current?.changed && <span className="section-navigation-changed" aria-hidden="true" />}
          <DropdownIcon size={18} aria-hidden="true" />
        </>
      }
    >
      <div ref={body}>
        <SectionNavigation
          label={label}
          items={rail}
          value={value}
          compact
          idPrefix={idPrefix}
          onSelect={choose}
        />
        <StudioMoreSections sections={more} value={value} idPrefix={idPrefix} onSelect={choose} />
      </div>
    </ActionMenu>
  );
}
