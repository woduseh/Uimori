import { t, useI18n } from './i18n.js';
import { formatUiMessage, uiMessage, uiText, type UiMessage } from './ui-message.js';
import { Switch, SelectionCheckbox } from './BooleanControls.js';
import { useId, useState } from 'react';
import { ExpandIcon, CloseIcon, EditIcon, SearchIcon } from './ui-icons.js';
import {
  createAgentCollaboration,
  createAgentDefinition,
  validateAgentCollaboration,
  type AgentCollaboration,
  type AgentDefinition,
} from '../core/agent-collaboration.js';
import type { ModelPreset } from '../core/product.js';
import type { PromptControl } from '../core/risu-prompt.js';
import { Dialog } from './Dialog.js';
import './agent-collaboration.css';
import './deletion.css';

const templates = () =>
  [
    { kind: 'character', title: t('settings.m113'), description: t('settings.m114') },
    { kind: 'lore', title: t('settings.m115'), description: t('settings.m116') },
    { kind: 'custom', title: t('settings.m117'), description: t('settings.m118') },
  ] as const;
const AGENT_LABEL_KEYS = {
  character: {
    title: 'settings.agentCharacterTitle',
    description: 'settings.agentCharacterDescription',
  },
  lore: { title: 'settings.agentLoreTitle', description: 'settings.agentLoreDescription' },
  custom: { title: 'settings.agentCustomTitle', description: 'settings.agentCustomDescription' },
} as const;
const toolScopes = (): { id: AgentDefinition['tools'][number]; label: string }[] => [
  { id: 'knowledge', label: t('settings.m119') },
  { id: 'skills', label: t('settings.m120') },
  { id: 'notes', label: t('settings.m121') },
  { id: 'story', label: t('settings.m122') },
];
const inRange = (value: number, min: number, max: number) =>
  Number.isSafeInteger(value) && value >= min && value <= max;

export function agentCollaborationIssue(
  value: AgentCollaboration | undefined,
  controls: PromptControl[]
): UiMessage | null {
  if (!value?.enabled) return null;
  if (value.enabled && !value.agents.length) return uiMessage('settings.m123');
  if (value.agents.length > 6) return uiMessage('settings.m124');
  if (!inRange(value.maxCalls, 1, 12)) return uiMessage('settings.m125');
  if (value.sharedControls.length > 64) return uiMessage('settings.m126');
  if (value.sharedControls.some((id) => !controls.some((control) => control.id === id)))
    return uiMessage('settings.m127');
  for (const [index, agent] of value.agents.entries()) {
    const name = agent.title.trim()
      ? uiText(agent.title.trim())
      : uiMessage('settings.m128', { v0: index + 1 });
    if (!agent.title.trim()) return uiMessage('settings.m129', { v0: name });
    if (!agent.instructions.trim()) return uiMessage('settings.m130', { v0: name });
    if (!inRange(agent.maxCalls, 1, 6)) return uiMessage('settings.m131', { v0: name });
  }
  try {
    validateAgentCollaboration(
      value,
      controls.map((control) => control.id)
    );
  } catch {
    return uiMessage('settings.m132');
  }
  return null;
}

type Props = {
  value?: AgentCollaboration;
  controls: PromptControl[];
  models: ModelPreset[];
  onChange: (value: AgentCollaboration) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
};

export function AgentCollaborationEditor({
  value,
  controls,
  models,
  onChange,
  expanded,
  onExpandedChange,
}: Props) {
  useI18n();
  const id = useId();
  const collaboration = value ?? createAgentCollaboration();
  const [removing, setRemoving] = useState<{ id: string; title: string } | null>(null);
  const [controlDialog, setControlDialog] = useState(false);
  const [controlQuery, setControlQuery] = useState('');
  const [controlGroup, setControlGroup] = useState('selected');
  const [openAgents, setOpenAgents] = useState<string[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const issue = agentCollaborationIssue(value, controls);
  const update = (changes: Partial<AgentCollaboration>) =>
    onChange({ ...collaboration, ...changes });
  const updateAgent = (agentId: string, changes: Partial<AgentDefinition>) =>
    update({
      agents: collaboration.agents.map((agent) =>
        agent.id === agentId ? { ...agent, ...changes } : agent
      ),
    });
  const setSharedControl = (controlId: string, checked: boolean) =>
    update({
      sharedControls: checked
        ? [...collaboration.sharedControls, controlId]
        : collaboration.sharedControls.filter((item) => item !== controlId),
    });
  const missingControls = collaboration.sharedControls.filter(
    (controlId) => !controls.some((control) => control.id === controlId)
  );
  const controlGroups = [...new Set(controls.map((control) => control.group || ''))];
  const visibleControls = controls.filter((control) => {
    if (controlGroup === 'selected' && !collaboration.sharedControls.includes(control.id))
      return false;
    if (controlGroup !== 'all' && controlGroup !== 'selected') {
      if ((control.group || '') !== controlGroup) return false;
    }
    return `${control.label} ${control.description ?? ''}`
      .toLocaleLowerCase()
      .includes(controlQuery.trim().toLocaleLowerCase());
  });
  const addAgent = (kind: ReturnType<typeof templates>[number]['kind']) => {
    if (collaboration.agents.length >= 6) return;
    const agent = createAgentDefinition(kind, `agent-${crypto.randomUUID()}`, {
      title: t(AGENT_LABEL_KEYS[kind].title),
      description: t(AGENT_LABEL_KEYS[kind].description),
    });
    update({ agents: [...collaboration.agents, agent] });
    setOpenAgents((current) => [...current, agent.id]);
    setShowTemplates(false);
  };

  return (
    <section className="agent-collaboration" aria-labelledby={`${id}-heading`}>
      <div className="ac-disclosure-heading">
        <button
          type="button"
          className="secondary ac-disclosure"
          aria-expanded={expanded && collaboration.enabled}
          aria-controls={`${id}-content`}
          disabled={!collaboration.enabled}
          onClick={() => onExpandedChange(!expanded)}
        >
          <ExpandIcon size={16} aria-hidden="true" />
          <strong id={`${id}-heading`}>{t('settings.m134')}</strong>
        </button>
        <label className="ac-check ac-enable">
          <Switch
            checked={collaboration.enabled}
            onChange={(event) => {
              update({ enabled: event.target.checked });
              if (event.target.checked) onExpandedChange(true);
            }}
          />
          <span className="sr-only">{t('settings.m135')}</span>
        </label>
      </div>
      {!expanded && issue && (
        <p className="ac-validation" role="status">
          {formatUiMessage(uiMessage('settings.flow3', { v0: issue }))}
        </p>
      )}
      <div id={`${id}-content`} hidden={!expanded || !collaboration.enabled}>
        <div className="ac-content">
          {collaboration.enabled && (
            <div className="ac-settings">
              <div className="ac-heading">
                <h4>{t('settings.m162')}</h4>
                <span className="muted">
                  {t('settings.flow5', { v0: collaboration.agents.length })}
                </span>
              </div>
              <div className="ac-agents">
                {collaboration.agents.map((agent, index) => {
                  const agentLabel = t('settings.m128', { v0: index + 1 });
                  const availableModel =
                    !agent.model || models.some((model) => model.id === agent.model?.id);
                  return (
                    <details
                      className="ac-agent"
                      key={agent.id}
                      open={openAgents.includes(agent.id)}
                      onToggle={(event) => {
                        const opened = event.currentTarget.open;
                        setOpenAgents((current) =>
                          opened
                            ? current.includes(agent.id)
                              ? current
                              : [...current, agent.id]
                            : current.filter((id) => id !== agent.id)
                        );
                      }}
                    >
                      <summary>
                        <strong>{agent.title || agentLabel}</strong>
                        <span className="muted">
                          {agent.trigger === 'before' ? t('settings.m140') : t('settings.m141')}
                        </span>
                      </summary>
                      <div className="ac-agent-fields">
                        <div className="ac-grid">
                          <label className="ac-field">
                            {t('settings.m142')}
                            <input
                              aria-label={t('settings.m143', { v0: agentLabel })}
                              value={agent.title}
                              onChange={(event) =>
                                updateAgent(agent.id, { title: event.target.value })
                              }
                            />
                          </label>
                          <label className="ac-field">
                            {t('settings.m144')}
                            <select
                              aria-label={t('settings.m145', { v0: agentLabel })}
                              value={agent.trigger}
                              onChange={(event) =>
                                updateAgent(agent.id, {
                                  trigger: event.target.value as AgentDefinition['trigger'],
                                })
                              }
                            >
                              <option value="before">{t('settings.m140')}</option>
                              <option value="on-demand">{t('settings.m141')}</option>
                            </select>
                          </label>
                        </div>
                        <label className="ac-field">
                          {t('settings.m146')}
                          <input
                            aria-label={t('settings.m147', { v0: agentLabel })}
                            value={agent.description}
                            onChange={(event) =>
                              updateAgent(agent.id, { description: event.target.value })
                            }
                          />
                        </label>
                        <label className="ac-field">
                          {t('settings.m120')}
                          <textarea
                            rows={6}
                            aria-label={t('settings.m148', { v0: agentLabel })}
                            value={agent.instructions}
                            onChange={(event) =>
                              updateAgent(agent.id, { instructions: event.target.value })
                            }
                          />
                        </label>
                        <label className="ac-field">
                          {t('settings.m149')}
                          <select
                            aria-label={t('settings.m150', { v0: agentLabel })}
                            value={agent.model?.id ?? ''}
                            onChange={(event) =>
                              updateAgent(agent.id, {
                                model: event.target.value ? { id: event.target.value } : null,
                              })
                            }
                          >
                            <option value="">{t('settings.m151')}</option>
                            {!availableModel && (
                              <option value={agent.model!.id}>{t('settings.m152')}</option>
                            )}
                            {models.map((model) => (
                              <option key={model.id} value={model.id}>
                                {model.title}
                                {model.enabled === false ? t('settings.m153') : ''}
                              </option>
                            ))}
                          </select>
                        </label>
                        <fieldset className="ac-options">
                          <legend>{t('settings.flow4', { v0: agentLabel })}</legend>
                          <div className="ac-checks">
                            {toolScopes().map((scope) => (
                              <label className="ac-check" key={scope.id}>
                                <SelectionCheckbox
                                  aria-label={t('settings.m157', {
                                    v0: agentLabel,
                                    v1: scope.label,
                                  })}
                                  checked={agent.tools.includes(scope.id)}
                                  onChange={(event) =>
                                    updateAgent(agent.id, {
                                      tools: event.target.checked
                                        ? [...agent.tools, scope.id]
                                        : agent.tools.filter((tool) => tool !== scope.id),
                                    })
                                  }
                                />
                                {scope.label}
                              </label>
                            ))}
                          </div>
                        </fieldset>
                        <div className="ac-grid">
                          <label className="ac-field">
                            {t('settings.m158')}
                            <input
                              type="number"
                              min={1}
                              max={6}
                              step={1}
                              aria-label={t('settings.m159', { v0: agentLabel })}
                              value={agent.maxCalls || ''}
                              onChange={(event) =>
                                updateAgent(agent.id, { maxCalls: Number(event.target.value) })
                              }
                            />
                          </label>
                        </div>
                        <div className="ac-agent-actions">
                          <button
                            type="button"
                            className="secondary"
                            aria-label={t('settings.m160', { v0: agentLabel })}
                            onClick={() =>
                              setRemoving({ id: agent.id, title: agent.title || agentLabel })
                            }
                          >
                            {t('settings.m161')}
                          </button>
                        </div>
                      </div>
                    </details>
                  );
                })}
              </div>
              <div className="ac-add">
                <button
                  type="button"
                  className="secondary ac-add-trigger"
                  aria-expanded={showTemplates}
                  disabled={collaboration.agents.length >= 6}
                  onClick={() => setShowTemplates((current) => !current)}
                >
                  {t('settings.m164')}
                </button>
                {showTemplates && (
                  <div className="ac-template-picker">
                    <div className="ac-templates">
                      {templates().map((template) => (
                        <button
                          type="button"
                          className="secondary"
                          key={template.kind}
                          aria-label={t('settings.m166', { v0: template.title })}
                          onClick={() => addAgent(template.kind)}
                        >
                          <strong>{template.title}</strong>
                          <span>{template.description}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <label className="ac-field ac-shared-instructions">
                {t('settings.m167')}
                <textarea
                  aria-label={t('settings.m167')}
                  rows={4}
                  value={collaboration.sharedInstructions}
                  placeholder={t('settings.m168')}
                  onChange={(event) => update({ sharedInstructions: event.target.value })}
                />
              </label>
              <section className="ac-shared-summary" aria-label={t('settings.m169')}>
                <div>
                  <strong>{t('settings.m169')}</strong>
                </div>
                <button
                  type="button"
                  className="secondary"
                  disabled={!controls.length && !missingControls.length}
                  onClick={() => {
                    setControlGroup(collaboration.sharedControls.length ? 'selected' : 'all');
                    setControlDialog(true);
                  }}
                >
                  <EditIcon size={18} aria-hidden="true" />
                  {t('settings.m171')}
                </button>
                <div className="ac-shared-tags">
                  {collaboration.sharedControls.length ? (
                    collaboration.sharedControls.map((controlId, index) => (
                      <span
                        className={
                          controls.some((control) => control.id === controlId) ? '' : 'missing'
                        }
                        key={controlId}
                      >
                        {controls.find((control) => control.id === controlId)?.label ??
                          t('settings.m172', { v0: index + 1 })}
                      </span>
                    ))
                  ) : (
                    <small className="muted">{t('settings.m173')}</small>
                  )}
                </div>
              </section>
              <label className="ac-field ac-budget">
                {t('settings.m177')}
                <input
                  type="number"
                  min={1}
                  max={12}
                  step={1}
                  value={collaboration.maxCalls || ''}
                  aria-label={t('settings.m177')}
                  onChange={(event) => update({ maxCalls: Number(event.target.value) })}
                />
              </label>
              {issue && (
                <p className="ac-validation" role="status">
                  {formatUiMessage(issue)}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
      <Dialog
        open={controlDialog}
        title={t('settings.m169')}
        className="ac-control-dialog"
        wide
        onClose={() => setControlDialog(false)}
      >
        <div className="ac-control-picker">
          <aside>
            <label className="ac-control-search">
              <SearchIcon size={18} aria-hidden="true" />
              <span className="sr-only">{t('settings.m179')}</span>
              <input
                type="search"
                aria-label={t('settings.m179')}
                placeholder={t('settings.m179')}
                value={controlQuery}
                onChange={(event) => setControlQuery(event.target.value)}
              />
            </label>
            <div className="ac-control-groups" role="group" aria-label={t('settings.m180')}>
              <button
                type="button"
                aria-pressed={controlGroup === 'selected'}
                onClick={() => setControlGroup('selected')}
              >
                <strong>{t('settings.m181')}</strong>
                <small>{t('settings.flow7', { v0: collaboration.sharedControls.length })}</small>
              </button>
              <button
                type="button"
                aria-pressed={controlGroup === 'all'}
                onClick={() => setControlGroup('all')}
              >
                <strong>{t('settings.m183')}</strong>
                <small>{t('settings.flow8', { v0: controls.length })}</small>
              </button>
              {controlGroups.map((group) => (
                <button
                  type="button"
                  key={group}
                  aria-pressed={controlGroup === group}
                  onClick={() => setControlGroup(group)}
                >
                  <strong>{group || t('settings.m133')}</strong>
                  <small>
                    {t('settings.flow9', {
                      v0: controls.filter((control) => (control.group || '') === group).length,
                    })}
                  </small>
                </button>
              ))}
            </div>
          </aside>
          <section aria-label={t('settings.m184')}>
            <div className="ac-control-picker-heading">
              <span>{t('settings.flow10', { v0: collaboration.sharedControls.length })}</span>
            </div>
            {(controlGroup === 'selected' || controlGroup === 'all') &&
              missingControls.map((controlId, index) => (
                <label className="ac-control-row missing" key={controlId}>
                  <SelectionCheckbox checked onChange={() => setSharedControl(controlId, false)} />
                  <strong>{t('settings.flow11', { v0: index + 1 })}</strong>
                </label>
              ))}
            {visibleControls.map((control) => (
              <label className="ac-control-row" key={control.id}>
                <SelectionCheckbox
                  aria-label={control.label}
                  checked={collaboration.sharedControls.includes(control.id)}
                  disabled={
                    collaboration.sharedControls.length >= 64 &&
                    !collaboration.sharedControls.includes(control.id)
                  }
                  onChange={(event) => setSharedControl(control.id, event.target.checked)}
                />
                <strong>{control.label}</strong>
                {control.description && <small>{control.description}</small>}
              </label>
            ))}
            {!visibleControls.length &&
              !(
                (controlGroup === 'selected' || controlGroup === 'all') &&
                missingControls.length
              ) && <p className="muted ac-control-empty">{t('settings.m190')}</p>}
          </section>
        </div>
      </Dialog>
      <Dialog
        open={!!removing}
        title={t('settings.m192')}
        role="alertdialog"
        className="delete-dialog"
        onClose={() => setRemoving(null)}
      >
        <p>
          <strong>{removing?.title}</strong>
          {t('settings.m193')}
        </p>
        <p className="muted">{t('settings.m194')}</p>
        <div className="form-actions">
          <button type="button" className="secondary" onClick={() => setRemoving(null)}>
            <CloseIcon size={18} aria-hidden="true" />
            {t('settings.m195')}
          </button>
          <button
            type="button"
            className="delete-button"
            onClick={() => {
              if (!removing) return;
              update({ agents: collaboration.agents.filter((agent) => agent.id !== removing.id) });
              setRemoving(null);
            }}
          >
            {t('settings.m196')}
          </button>
        </div>
      </Dialog>
    </section>
  );
}
