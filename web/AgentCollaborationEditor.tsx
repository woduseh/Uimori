import { Switch, SelectionCheckbox } from './BooleanControls.js';
import { useId, useState } from 'react';
import { ExpandIcon, CloseIcon } from './ui-icons.js';
import {
  createAgentCollaboration,
  createAgentDefinition,
  validateAgentCollaboration,
  type AgentCollaboration,
  type AgentDefinition,
} from '../core/agent-collaboration.js';
import type { ModelPreset } from '../core/product.js';
import type { PromptControl } from '../core/prompt-program.js';
import { Dialog } from './Dialog.js';
import './agent-collaboration.css';

const templates = [
  { kind: 'character', title: '인물', description: '개성과 동기, 관계를 살펴봐요.' },
  { kind: 'lore', title: '설정과 기억', description: '자료와 앞선 이야기를 살펴봐요.' },
  { kind: 'custom', title: '직접 만들기', description: '원하는 역할과 지침을 정해요.' },
] as const;
const toolScopes: { id: AgentDefinition['tools'][number]; label: string }[] = [
  { id: 'knowledge', label: '자료' },
  { id: 'skills', label: '지침' },
  { id: 'notes', label: '사용자 메모' },
  { id: 'story', label: '이야기' },
];
const inRange = (value: number, min: number, max: number) =>
  Number.isSafeInteger(value) && value >= min && value <= max;

/** Keep incomplete edits in the prompt draft, but never send them to the save endpoint. */
export function agentCollaborationIssue(
  value: AgentCollaboration | undefined,
  controls: PromptControl[]
): string {
  if (!value) return '';
  if (value.enabled && !value.agents.length)
    return '아래에서 템플릿을 골라 에이전트를 추가해 주세요. 추가한 뒤 저장할 수 있어요.';
  if (value.agents.length > 6) return '에이전트는 최대 6명까지 함께할 수 있어요.';
  if (!inRange(value.maxCalls, 1, 12)) return '전체 추가 호출 한도는 1~12회로 입력해 주세요.';
  if (value.sharedInstructions.length > 30_000)
    return '함께 따를 지침은 30,000자 이내로 적어 주세요.';
  if (value.sharedControls.length > 64) return '공유할 옵션은 최대 64개까지 선택할 수 있어요.';
  if (value.sharedControls.some((id) => !controls.some((control) => control.id === id)))
    return '공유할 옵션에서 삭제된 옵션의 선택을 해제해 주세요.';
  for (const [index, agent] of value.agents.entries()) {
    const name = agent.title.trim() || `${index + 1}번째 에이전트`;
    if (!agent.title.trim()) return `${name}의 이름을 입력해 주세요.`;
    if (agent.title.length > 120) return '에이전트 이름은 120자 이내로 적어 주세요.';
    if (agent.description.length > 2000) return `${name}의 역할 설명은 2,000자 이내로 적어 주세요.`;
    if (!agent.instructions.trim()) return `${name}의 지침을 입력해 주세요.`;
    if (agent.instructions.length > 30_000) return `${name}의 지침은 30,000자 이내로 적어 주세요.`;
    if (!inRange(agent.maxCalls, 1, 6)) return `${name}의 호출 한도는 1~6회로 입력해 주세요.`;
    if (!inRange(agent.maxOutputChars, 500, 20_000))
      return `${name}의 최대 응답 길이는 500~20,000자로 입력해 주세요.`;
  }
  try {
    validateAgentCollaboration(
      value,
      controls.map((control) => control.id)
    );
  } catch {
    return '협업 설정에 올바르지 않은 값이 있어요. 에이전트와 공유 옵션을 확인해 주세요.';
  }
  return '';
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
  const id = useId();
  const collaboration = value ?? createAgentCollaboration();
  const [removing, setRemoving] = useState<{ id: string; title: string } | null>(null);
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

  return (
    <section className="agent-collaboration" aria-labelledby={`${id}-heading`}>
      <div className="ac-disclosure-heading">
        <button
          type="button"
          className="secondary ac-disclosure"
          aria-expanded={expanded}
          aria-controls={`${id}-content`}
          onClick={() => onExpandedChange(!expanded)}
        >
          <ExpandIcon size={16} aria-hidden="true" />
          <strong id={`${id}-heading`}>에이전트 협업</strong>
        </button>
        <label className="ac-check ac-enable">
          <Switch
            checked={collaboration.enabled}
            onChange={(event) => update({ enabled: event.target.checked })}
          />
          <span className="sr-only">협업 사용</span>
        </label>
      </div>
      {!expanded && issue && (
        <p className="ac-validation" role="status">
          {issue} 협업 상세를 펼쳐 확인해 주세요.
        </p>
      )}
      <div id={`${id}-content`} hidden={!expanded}>
        <div className="ac-content">
          <p className="muted">
            에이전트가 인물이나 설정에 관한 의견을 제안하고, 메인이 최종 문장을 써요.
          </p>
          {!collaboration.enabled && (
            <p className="muted">
              {collaboration.agents.length
                ? '협업을 꺼 두었어요. 설정은 보관돼요. 다시 켜면 이어서 편집할 수 있어요.'
                : '기본은 꺼져 있어요. 켠 뒤 함께할 에이전트를 골라 주세요.'}
            </p>
          )}
          {collaboration.enabled && (
            <div className="ac-settings">
              <label className="ac-field ac-budget">
                전체 추가 호출 한도
                <input
                  type="number"
                  min={1}
                  max={12}
                  step={1}
                  value={collaboration.maxCalls || ''}
                  aria-describedby={`${id}-budget-note`}
                  aria-label="전체 추가 호출 한도"
                  onChange={(event) => update({ maxCalls: Number(event.target.value) })}
                />
                <small id={`${id}-budget-note`} className="muted">
                  모든 에이전트가 나눠 쓰는 한도예요. 채팅의 전체 호출 한도에도 포함돼요.
                </small>
              </label>
              <label className="ac-field">
                함께 따를 지침
                <textarea
                  aria-label="함께 따를 지침"
                  rows={4}
                  maxLength={30_000}
                  value={collaboration.sharedInstructions}
                  placeholder="모든 에이전트가 함께 고려할 창작 방향을 적어 주세요."
                  onChange={(event) => update({ sharedInstructions: event.target.value })}
                />
              </label>
              <fieldset className="ac-options">
                <legend>공유할 프롬프트 옵션</legend>
                <p className="muted">선택한 옵션의 현재 값을 에이전트에게 알려 줘요.</p>
                {controls.length || missingControls.length ? (
                  <div className="ac-checks">
                    {controls.map((control) => (
                      <label className="ac-check" key={control.id}>
                        <SelectionCheckbox
                          checked={collaboration.sharedControls.includes(control.id)}
                          disabled={
                            collaboration.sharedControls.length >= 64 &&
                            !collaboration.sharedControls.includes(control.id)
                          }
                          onChange={(event) => setSharedControl(control.id, event.target.checked)}
                        />
                        <span>{control.label}</span>
                      </label>
                    ))}
                    {missingControls.map((controlId, index) => (
                      <label className="ac-check" key={controlId}>
                        <SelectionCheckbox
                          checked
                          onChange={() => setSharedControl(controlId, false)}
                        />
                        <span>삭제된 옵션 {index + 1} · 선택을 해제해 주세요.</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="muted">이 프롬프트에는 아직 공유할 옵션이 없어요.</p>
                )}
              </fieldset>
              <div className="ac-add">
                <div className="ac-heading">
                  <h4>함께할 에이전트</h4>
                  <span className="muted">{collaboration.agents.length} / 6명</span>
                </div>
                <p className="muted">템플릿으로 시작한 뒤 이름과 지침을 자유롭게 바꿀 수 있어요.</p>
                <div className="ac-templates">
                  {templates.map((template) => (
                    <button
                      type="button"
                      className="secondary"
                      key={template.kind}
                      disabled={collaboration.agents.length >= 6}
                      aria-label={`${template.title} 에이전트 추가`}
                      onClick={() => {
                        if (collaboration.agents.length >= 6) return;
                        update({
                          agents: [
                            ...collaboration.agents,
                            createAgentDefinition(template.kind, `agent-${crypto.randomUUID()}`),
                          ],
                        });
                      }}
                    >
                      <strong>{template.title}</strong>
                      <span>{template.description}</span>
                    </button>
                  ))}
                </div>
              </div>
              {issue && (
                <p className="ac-validation" role="status">
                  {issue}
                </p>
              )}
              <div className="ac-agents">
                {collaboration.agents.map((agent, index) => {
                  const agentLabel = `${index + 1}번째 에이전트`;
                  const availableModel =
                    !agent.model || models.some((model) => model.id === agent.model?.id);
                  return (
                    <details className="ac-agent" key={agent.id} open>
                      <summary>
                        <strong>{agent.title || agentLabel}</strong>
                        <span className="muted">
                          {agent.trigger === 'before' ? '작성 전' : '메인이 필요할 때'}
                        </span>
                      </summary>
                      <div className="ac-agent-fields">
                        <div className="ac-grid">
                          <label className="ac-field">
                            이름
                            <input
                              aria-label={`${agentLabel} 이름`}
                              maxLength={120}
                              value={agent.title}
                              onChange={(event) =>
                                updateAgent(agent.id, { title: event.target.value })
                              }
                            />
                          </label>
                          <label className="ac-field">
                            참여 시점
                            <select
                              aria-label={`${agentLabel} 참여 시점`}
                              value={agent.trigger}
                              onChange={(event) =>
                                updateAgent(agent.id, {
                                  trigger: event.target.value as AgentDefinition['trigger'],
                                })
                              }
                            >
                              <option value="before">작성 전</option>
                              <option value="on-demand">메인이 필요할 때</option>
                            </select>
                          </label>
                        </div>
                        <label className="ac-field">
                          역할 설명
                          <input
                            aria-label={`${agentLabel} 역할 설명`}
                            maxLength={2000}
                            value={agent.description}
                            onChange={(event) =>
                              updateAgent(agent.id, { description: event.target.value })
                            }
                          />
                        </label>
                        <label className="ac-field">
                          지침
                          <textarea
                            rows={6}
                            maxLength={30_000}
                            aria-label={`${agentLabel} 지침`}
                            value={agent.instructions}
                            onChange={(event) =>
                              updateAgent(agent.id, { instructions: event.target.value })
                            }
                          />
                        </label>
                        <label className="ac-field">
                          모델
                          <select
                            aria-label={`${agentLabel} 모델`}
                            value={agent.model?.id ?? ''}
                            onChange={(event) =>
                              updateAgent(agent.id, {
                                model: event.target.value ? { id: event.target.value } : null,
                              })
                            }
                          >
                            <option value="">메인 모델을 함께 사용해요</option>
                            {!availableModel && (
                              <option value={agent.model!.id}>
                                찾을 수 없는 모델 · 다시 선택해 주세요
                              </option>
                            )}
                            {models.map((model) => (
                              <option key={model.id} value={model.id}>
                                {model.title}
                                {model.enabled === false ? ' · 사용 중지' : ''}
                              </option>
                            ))}
                          </select>
                        </label>
                        <fieldset className="ac-options">
                          <legend>{agentLabel}의 추가 조회</legend>
                          <p className="muted">
                            현재 요청과 작문에 쓰는 문맥은 함께 받아요. 필요한 내용을 더 찾아볼 조회
                            도구를 선택해요.
                          </p>
                          <div className="ac-checks">
                            {toolScopes.map((scope) => (
                              <label className="ac-check" key={scope.id}>
                                <SelectionCheckbox
                                  aria-label={`${agentLabel} ${scope.label} 읽기`}
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
                            호출 한도 · 1~6회
                            <input
                              type="number"
                              min={1}
                              max={6}
                              step={1}
                              aria-label={`${agentLabel} 호출 한도`}
                              value={agent.maxCalls || ''}
                              onChange={(event) =>
                                updateAgent(agent.id, { maxCalls: Number(event.target.value) })
                              }
                            />
                          </label>
                          <label className="ac-field">
                            메인에게 전달할 최대 길이 · 글자 수
                            <input
                              type="number"
                              min={500}
                              max={20_000}
                              step={1}
                              aria-label={`${agentLabel} 최대 응답 길이`}
                              value={agent.maxOutputChars || ''}
                              onChange={(event) =>
                                updateAgent(agent.id, {
                                  maxOutputChars: Number(event.target.value),
                                })
                              }
                            />
                          </label>
                        </div>
                        <div className="ac-agent-actions">
                          <button
                            type="button"
                            className="secondary"
                            aria-label={`${agentLabel} 삭제`}
                            onClick={() =>
                              setRemoving({ id: agent.id, title: agent.title || agentLabel })
                            }
                          >
                            에이전트 삭제
                          </button>
                        </div>
                      </div>
                    </details>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
      <Dialog
        open={!!removing}
        title="에이전트 삭제 확인"
        role="alertdialog"
        onClose={() => setRemoving(null)}
      >
        <p>
          <strong>{removing?.title}</strong> 에이전트를 이 프롬프트에서 삭제할까요?
        </p>
        <p className="muted">프롬프트를 저장하면 반영돼요.</p>
        <div className="form-actions">
          <button type="button" className="secondary" onClick={() => setRemoving(null)}>
            <CloseIcon size={18} aria-hidden="true" />
            취소
          </button>
          <button
            type="button"
            onClick={() => {
              if (!removing) return;
              update({ agents: collaboration.agents.filter((agent) => agent.id !== removing.id) });
              setRemoving(null);
            }}
          >
            삭제
          </button>
        </div>
      </Dialog>
    </section>
  );
}
