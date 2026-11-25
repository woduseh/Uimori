import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ActionMenu } from './ActionMenu.js';
import { SectionNavigation } from './SectionNavigation.js';
import { useCompactLayout } from './useCompactLayout.js';
import { DropdownIcon } from './ui-icons.js';
import { formatNumber, t } from './i18n.js';
import type { StudioSection } from './studio-sections.js';
import './editor-studio.css';

const rememberedSections = new Map<string, string>();

export function useStudioSection<K extends string>(
  memoryKey: string,
  sections: readonly StudioSection<K>[],
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
  return [sections.some((item) => item.id === chosen) ? chosen : fallback, select] as const;
}

export function EditorStudio<K extends string>({
  header,
  notice,
  label,
  sections,
  value,
  onSelect,
  idPrefix,
  children,
}: {
  header: ReactNode;
  notice?: ReactNode;
  label: string;
  sections: readonly StudioSection<K>[];
  value: K;
  onSelect: (id: K) => void;
  idPrefix: string;
  children: ReactNode;
}) {
  const compact = useCompactLayout();
  const canvas = useRef<HTMLDivElement>(null);
  const shown = useRef(value);
  useLayoutEffect(() => {
    if (shown.current === value) return;
    shown.current = value;
    canvas.current?.scrollTo({ top: 0 });
  }, [value]);
  return (
    <div className="editor-studio">
      <div className="editor-studio-header">
        {header}
        {notice}
      </div>
      {compact && (
        <StudioSectionPicker
          label={label}
          sections={sections}
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
              items={sections}
              value={value}
              onSelect={onSelect}
              compact={false}
              orientation="vertical"
              idPrefix={idPrefix}
            />
          </div>
        )}
        <div ref={canvas} className="editor-studio-canvas">
          {children}
        </div>
      </div>
    </div>
  );
}

function StudioSectionPicker<K extends string>({
  label,
  sections,
  value,
  onSelect,
  idPrefix,
}: {
  label: string;
  sections: readonly StudioSection<K>[];
  value: K;
  onSelect: (id: K) => void;
  idPrefix: string;
}) {
  const body = useRef<HTMLDivElement>(null);
  const current = sections.find((item) => item.id === value);
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
          <DropdownIcon size={18} aria-hidden="true" />
        </>
      }
    >
      <div ref={body}>
        <SectionNavigation
          label={label}
          items={sections}
          value={value}
          compact
          idPrefix={idPrefix}
          onSelect={(id) => {
            onSelect(id);
            const menu = body.current?.closest('details');
            if (!menu) return;
            menu.open = false;
            menu.querySelector('summary')?.focus();
          }}
        />
      </div>
    </ActionMenu>
  );
}
