import type {
  CbsReferenceFinding,
  CbsReferenceIndex,
  CbsVariableReferences,
  CbsVariableUse,
} from '../core/cbs-references.js';
import { useI18n } from './i18n.js';
import './cbs-references.css';

export type CbsUseLocator = (use: CbsVariableUse) => string[];
type Translate = ReturnType<typeof useI18n>['t'];

function itemLabel(use: CbsVariableUse, t: Translate) {
  if (use.item === null) return null;
  const number = use.item + 1;
  switch (use.section) {
    case 'greetings':
      return use.item === 0
        ? t('native.text_104a1f537a')
        : t('native.alternateMessage', { number: use.item });
    case 'lore':
      return use.label || t('native.unnamedLore');
    case 'regex':
      return use.label || t('native.regexNumber', { number });
    case 'triggers':
      return use.label || t('native.triggerNumber', { number });
    default:
      return use.label || t('cbsRefs.itemNumber', { number });
  }
}

function fieldLabel(use: CbsVariableUse, t: Translate) {
  if (use.field.startsWith('conditions.')) return t('cbsRefs.field.condition');
  if (use.field.startsWith('effect.'))
    return use.origin === 'lua' ? null : t('cbsRefs.field.effect');
  switch (use.field) {
    case 'description':
      return t('cbsRefs.field.description');
    case 'post_history_instructions':
      return t('native.text_2d2a2c8204');
    case 'mes_example':
      return t('native.text_07b2960ad0');
    case 'in':
      return t('cbsRefs.field.in');
    case 'out':
      return t('cbsRefs.field.out');
    case 'text':
      return t('cbsRefs.field.text');
    case 'innerFormat':
      return t('cbsRefs.field.innerFormat');
    case 'defaultText':
      return t('native.text_d955c69f94');
    default:
      return null;
  }
}

export function cbsUseLocator(
  t: Translate,
  sectionTitle: (section: string) => string
): CbsUseLocator {
  return (use) =>
    [sectionTitle(use.section), itemLabel(use, t), fieldLabel(use, t)].filter(
      (part): part is string => !!part
    );
}

export const listedUses = (entry: CbsVariableReferences) =>
  entry.uses.filter((use) => use.access !== 'default' && use.access !== 'define');

export function CbsUseList({
  uses,
  locate,
  onJump,
}: {
  uses: CbsVariableUse[];
  locate: CbsUseLocator;
  onJump: (use: CbsVariableUse) => void;
}) {
  const { t } = useI18n();
  if (!uses.length) return <p className="muted cbs-use-empty">{t('cbsRefs.notFound')}</p>;
  return (
    <ul className="cbs-use-list">
      {uses.map((use, index) => (
        <li key={index}>
          <button type="button" className="cbs-use" onClick={() => onJump(use)}>
            <span className="cbs-use-location">
              {locate(use).map((part, i) => (
                <span key={i}>{part}</span>
              ))}
            </span>
            <span className="cbs-use-access">
              {use.origin === 'lua' && <span className="cbs-tag">Lua</span>}
              {use.access === 'update'
                ? t('cbsRefs.access.update')
                : use.access === 'write'
                  ? t('cbsRefs.access.write')
                  : t('cbsRefs.access.read')}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function cbsFindingLabel(finding: CbsReferenceFinding, t: Translate): string {
  switch (finding.code) {
    case 'read-without-default':
      return t('cbsRefs.finding.readWithoutDefault');
    case 'never-read':
      return t(finding.certain ? 'cbsRefs.finding.neverRead' : 'cbsRefs.finding.maybeNeverRead');
    case 'toggle-unused':
      return t(
        finding.certain ? 'cbsRefs.finding.toggleUnused' : 'cbsRefs.finding.maybeToggleUnused'
      );
    case 'toggle-undefined':
      return t('cbsRefs.finding.toggleUndefined');
  }
}

export const findingsFor = (index: CbsReferenceIndex, entry: CbsVariableReferences) =>
  index.findings.filter((item) => item.scope === entry.scope && item.name === entry.name);

export const hasDynamicNames = (index: CbsReferenceIndex) =>
  Object.values(index.dynamic).some((counts) => counts.reads || counts.writes);

export function CbsReferenceList({
  index,
  include = () => true,
  locate,
  onJump,
  onAddDefault,
  heading,
}: {
  index: CbsReferenceIndex;
  heading?: string;
  include?: (entry: CbsVariableReferences) => boolean;
  locate: CbsUseLocator;
  onJump: (use: CbsVariableUse) => void;
  onAddDefault?: (name: string) => void;
}) {
  const { t } = useI18n();
  const entries = index.variables.filter(include);
  const missing = onAddDefault
    ? index.findings
        .filter((finding) => finding.code === 'read-without-default')
        .map((finding) => finding.name)
    : [];
  const title = heading ?? t('cbsRefs.heading');
  return (
    <section className="cbs-references" aria-label={title}>
      <h3>{title}</h3>
      {missing.length > 0 && (
        <div className="cbs-missing-defaults">
          <h4>{t('cbsRefs.missingDefaults')}</h4>
          <ul>
            {missing.map((name) => (
              <li key={name}>
                <code>{name}</code>
                <button
                  type="button"
                  className="ghost"
                  aria-label={t('cbsRefs.addDefaultFor', { name })}
                  onClick={() => onAddDefault?.(name)}
                >
                  {t('cbsRefs.addDefault')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {entries.length === 0 ? (
        <p className="muted cbs-use-empty">{t('cbsRefs.notFound')}</p>
      ) : (
        <ul className="cbs-reference-list">
          {entries.map((entry) => (
            <li key={`${entry.scope}:${entry.name}`}>
              <CbsReferenceRow
                entry={entry}
                findings={findingsFor(index, entry)}
                locate={locate}
                onJump={onJump}
              />
            </li>
          ))}
        </ul>
      )}
      {hasDynamicNames(index) && (
        <p className="muted cbs-dynamic-note">{t('cbsRefs.dynamicNote')}</p>
      )}
    </section>
  );
}

function CbsReferenceRow({
  entry,
  findings,
  locate,
  onJump,
}: {
  entry: CbsVariableReferences;
  findings: CbsReferenceFinding[];
  locate: CbsUseLocator;
  onJump: (use: CbsVariableUse) => void;
}) {
  const { t } = useI18n();
  const scope =
    entry.toggle !== null
      ? t('cbsRefs.scope.toggle')
      : entry.scope === 'temp'
        ? t('cbsRefs.scope.temp')
        : entry.scope === 'global'
          ? t('cbsRefs.scope.global')
          : null;
  return (
    <details className="cbs-reference">
      <summary>
        <span className="cbs-reference-name">
          <code>{entry.toggle ?? entry.name}</code>
          {scope && <span className="cbs-tag">{scope}</span>}
        </span>
        <span className="cbs-reference-counts">
          <span>{t('cbsRefs.reads', { count: entry.reads })}</span>
          <span>{t('cbsRefs.writes', { count: entry.writes })}</span>
        </span>
        {findings.map((finding) => (
          <span key={finding.code} className="cbs-finding" data-certain={finding.certain}>
            {cbsFindingLabel(finding, t)}
          </span>
        ))}
      </summary>
      <CbsUseList uses={listedUses(entry)} locate={locate} onJump={onJump} />
    </details>
  );
}
