import { useId, useMemo, useRef, useState } from 'react';
import { NATIVE_PREFIX, listItemFieldLabels } from './helper-change-location.js';
import { formatNumber, t, useI18n } from './i18n.js';
import { IconButton } from './IconButton.js';
import {
  editorChangeView,
  editorFieldChanges,
  editorItemName,
  type EditorChangeKind,
  type EditorFieldChange,
  type EditorListItem,
  type EditorListKind,
} from './editor-values.js';
import { promptBlockTypeLabels, type ChangedSection } from './studio-sections.js';
import { ProseHunk, TextDiffHunks, TextDiffStats, textDiffOmission } from './TextDiffView.js';
import { DropdownIcon, ForwardIcon } from './ui-icons.js';

const PAGE = 20;
type LabelPart = { text: string; identifier?: boolean };

const fieldLabels: Partial<Record<EditorListKind, Record<string, string>>> = {
  ...listItemFieldLabels,
  regex: {
    comment: 'native.text_9aa18e5071',
    type: 'native.text_81c4f73cf0',
    in: 'native.text_6b5f44ef65',
    out: 'native.text_dce02ee0f0',
    ableFlag: 'native.text_3debd57307',
    flag: 'native.text_ce80b34836',
  },
  triggers: { comment: 'native.text_9aa18e5071' },
};
const topFields: Record<string, string> = {
  '/title': 'visualpanels.name',
  '/description': 'visualpanels.description',
  '/package/nativeRisu/card/name': 'native.text_9aa18e5071',
  '/package/nativeRisu/module/name': 'native.text_9aa18e5071',
  '/package/nativeRisu/card/description': 'native.text_08117feaa5',
  '/package/nativeRisu/module/description': 'native.text_9e7348ca61',
  '/package/nativeRisu/card/first_mes': 'native.text_104a1f537a',
};
const kindLabels: Partial<Record<EditorChangeKind, string>> = {
  added: 'shared.changeAdded',
  removed: 'helperResults.deleted',
  moved: 'helperChanges.reordered',
};

function itemLabel(item: EditorListItem): string {
  const name = editorItemName(item.value);
  const number = `#${formatNumber(item.index + 1)}`;
  switch (item.kind) {
    case 'greetings':
      return t('native.alternateMessage', { number: item.index + 1 });
    case 'lore':
      return name || t('native.unnamedLore');
    case 'regex':
      return name || t('native.regexFallbackName');
    case 'prompt': {
      const value = item.value as { type?: unknown } | null;
      const type = typeof value?.type === 'string' ? value.type : '';
      return name || promptBlockTypeLabels()[type] || type || number;
    }
    default:
      return name || number;
  }
}

function changeLabel(change: EditorFieldChange): LabelPart[] {
  if (change.item) {
    const parts: LabelPart[] = [{ text: itemLabel(change.item) }];
    const [field] = change.field;
    if (field !== undefined) {
      const key = fieldLabels[change.item.kind]?.[field];
      parts.push(
        key && change.field.length === 1
          ? { text: t(key) }
          : { text: change.field.join('/'), identifier: true }
      );
    }
    return parts;
  }
  const known = topFields[change.path];
  if (known) return [{ text: t(known) }];
  const relative = change.path.replace(NATIVE_PREFIX, '').split('/').filter(Boolean);
  return [{ text: relative.join('/') || '/', identifier: true }];
}

function shownValue(value: unknown) {
  if (value === undefined || value === null || value === '') return t('shared.valueEmpty');
  if (typeof value === 'boolean') return t(value ? 'shared.valueOn' : 'shared.valueOff');
  return String(value);
}

function FieldChange({ change }: { change: EditorFieldChange }) {
  const view = useMemo(() => editorChangeView(change), [change]);
  const parts = changeLabel(change);
  const name = parts.map((part) => part.text).join(' / ');
  const kind = kindLabels[change.kind];
  const shown = view.type === 'text' && !('omitted' in view.diff) ? view.diff : null;
  return (
    <li className="editor-field-change" data-kind={change.kind}>
      <div className="editor-field-change-head">
        <span className="editor-field-change-label">
          {parts.map((part, index) =>
            part.identifier ? (
              <code key={index}>{part.text}</code>
            ) : (
              <span key={index}>{part.text}</span>
            )
          )}
        </span>
        {shown && <TextDiffStats diff={shown} />}
        {kind && <span className="editor-field-change-kind">{t(kind)}</span>}
      </div>
      {shown && shown.hunks.length > 0 && (
        <div
          className="text-diff-box editor-field-diff"
          role="region"
          aria-label={t('helperChanges.diffRegion', { title: name })}
          tabIndex={0}
          data-mode={shown.mode}
        >
          <TextDiffHunks diff={shown} />
        </div>
      )}
      {view.type === 'text' && 'omitted' in view.diff && (
        <p className="muted editor-field-change-note">{textDiffOmission(view.diff)}</p>
      )}
      {view.type === 'value' && (
        <div className="text-diff-box editor-field-diff">
          <ProseHunk
            hunk={{
              beforeOffset: 0,
              afterOffset: 0,
              segments: [
                ...(change.kind !== 'added'
                  ? [{ op: 'delete' as const, text: shownValue(view.before) }]
                  : []),
                ...(change.kind === 'changed' ? [{ op: 'equal' as const, text: ' → ' }] : []),
                ...(change.kind !== 'removed'
                  ? [{ op: 'insert' as const, text: shownValue(view.after) }]
                  : []),
              ],
            }}
          />
        </div>
      )}
      {view.type === 'summary' && (
        <p className="muted editor-field-change-note">
          {view.before !== null && view.after !== null
            ? t('shared.changeItemCount', { before: view.before, after: view.after })
            : t('shared.changeNotCompared')}
        </p>
      )}
    </li>
  );
}

function FieldChangeList({
  changes,
  pending,
}: {
  changes: readonly EditorFieldChange[];
  pending: boolean;
}) {
  const [limit, setLimit] = useState(PAGE);
  return (
    <>
      {pending && <p className="muted editor-field-change-note">{t('shared.pendingInputHelp')}</p>}
      {!changes.length && !pending && (
        <p className="muted editor-field-change-note">{t('shared.noFieldChanges')}</p>
      )}
      {changes.length > 0 && (
        <ul className="editor-field-changes">
          {changes.slice(0, limit).map((change, index) => (
            <FieldChange key={`${change.kind}:${change.path}:${index}`} change={change} />
          ))}
        </ul>
      )}
      {changes.length > limit && (
        <button
          type="button"
          className="secondary editor-field-changes-more"
          onClick={() => setLimit((current) => current + PAGE)}
        >
          {t('shared.showMoreChanges', { count: changes.length - limit })}
        </button>
      )}
    </>
  );
}

const leafText = (value: unknown) => (typeof value === 'string' ? value : null);

function groupBySection<K extends string>(
  changes: readonly EditorFieldChange[],
  sectionOf: (path: string) => K
) {
  const groups = new Map<K, EditorFieldChange[]>();
  for (const change of changes) {
    const id = sectionOf(change.path);
    groups.set(id, [...(groups.get(id) ?? []), change]);
  }
  for (const [id, group] of groups)
    groups.set(
      id,
      group.filter(
        (change) =>
          change.item ||
          leafText(change.after) === null ||
          !group.some(
            (other) =>
              other !== change &&
              !other.item &&
              other.path.length > change.path.length &&
              leafText(other.before) === leafText(change.before) &&
              leafText(other.after) === leafText(change.after)
          )
      )
    );
  return groups;
}

function SectionRow<K extends string>({
  section,
  expanded,
  onToggle,
  changes,
  onSelect,
}: {
  section: ChangedSection<K>;
  expanded: boolean;
  onToggle: () => void;
  changes: readonly EditorFieldChange[] | null;
  onSelect?: (id: K) => void;
}) {
  const regionId = useId();
  return (
    <li className="editor-changes-section" data-expanded={expanded}>
      <div className="editor-changes-row">
        <button
          type="button"
          className="editor-changes-item"
          aria-expanded={expanded}
          aria-controls={regionId}
          onClick={onToggle}
        >
          <DropdownIcon size={18} aria-hidden="true" className="editor-changes-chevron" />
          <span className="editor-changes-title">{section.title}</span>
          {section.pending && (
            <span className="editor-changes-badge">{t('shared.pendingInput')}</span>
          )}
        </button>
        {onSelect && (
          <IconButton
            className="ghost"
            label={t('shared.goToSection', { title: section.title })}
            icon={ForwardIcon}
            size={18}
            onClick={() => onSelect(section.id)}
          />
        )}
      </div>
      <div id={regionId} className="editor-changes-fields" hidden={!expanded}>
        {expanded && changes && <FieldChangeList changes={changes} pending={section.pending} />}
      </div>
    </li>
  );
}

export function ChangedSectionList<K extends string>({
  label,
  sections,
  before,
  after,
  sectionOf,
  onSelect,
}: {
  label: string;
  sections: readonly ChangedSection<K>[];
  before: unknown;
  after: unknown;
  sectionOf: (path: string) => K;
  onSelect?: (id: K) => void;
}) {
  useI18n();
  const [expanded, setExpanded] = useState<ReadonlySet<K>>(() => new Set());
  const placer = useRef(sectionOf);
  placer.current = sectionOf;
  const opened = expanded.size > 0;
  const groups = useMemo(
    () => (opened ? groupBySection(editorFieldChanges(before, after), placer.current) : null),
    [opened, before, after]
  );
  return (
    <ul className="editor-changes-list" aria-label={label}>
      {sections.map((section) => (
        <SectionRow
          key={section.id}
          section={section}
          expanded={expanded.has(section.id)}
          onToggle={() =>
            setExpanded((current) => {
              const next = new Set(current);
              if (!next.delete(section.id)) next.add(section.id);
              return next;
            })
          }
          changes={groups ? (groups.get(section.id) ?? []) : null}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}
