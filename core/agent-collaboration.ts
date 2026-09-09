/** Data-only collaboration settings. Read scopes never grant mutation or execution tools. */
export type AgentReadScope = 'knowledge' | 'skills' | 'notes' | 'story';
export type AgentDefinition = {
  id: string;
  title: string;
  description: string;
  instructions: string;
  model: { id: string } | null;
  trigger: 'before' | 'on-demand';
  tools: AgentReadScope[];
  maxCalls: number;
  maxOutputChars: number;
};
export type AgentCollaboration = {
  enabled: boolean;
  sharedInstructions: string;
  sharedControls: string[];
  maxCalls: number;
  agents: AgentDefinition[];
};

export class AgentCollaborationError extends Error {
  readonly statusCode = 400;
  constructor(readonly code: string) {
    super(code);
    this.name = 'AgentCollaborationError';
  }
}

const unsafeIds = new Set(['__proto__', 'prototype', 'constructor']);
const readScopes: readonly AgentReadScope[] = ['knowledge', 'skills', 'notes', 'story'];
function fail(code: string): never {
  throw new AgentCollaborationError(`AGENT_COLLABORATION_${code}`);
}

/** Read only enumerable own data properties; accessors are rejected without invoking them. */
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail('INVALID_FIELDS');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length) fail('INVALID_FIELDS');
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string' || unsafeIds.has(key) || !fields.includes(key))
      fail('INVALID_FIELDS');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_FIELDS');
    result[key] = descriptor.value;
  }
  return result;
}

function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail('INVALID_LIST');
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    fail('INVALID_LIST');
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_LIST');
    result.push(descriptor.value);
  }
  return result;
}

function text(value: unknown, min: number, max: number): string {
  if (
    typeof value !== 'string' ||
    value.length < min ||
    value.length > max ||
    (min > 0 && !value.trim())
  )
    fail('INVALID_TEXT');
  return value;
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    fail('INVALID_LIMIT');
  return value;
}

function agentId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/u.test(value) || unsafeIds.has(value))
    fail('INVALID_AGENT_ID');
  return value;
}

/** Shared controls use the existing PromptProgram ID syntax, not the narrower agent syntax. */
function controlId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/u.test(value) || unsafeIds.has(value))
    fail('INVALID_CONTROL_ID');
  return value;
}

function unique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) fail(code);
}

function definition(value: unknown): AgentDefinition {
  const agent = record(value, [
    'id',
    'title',
    'description',
    'instructions',
    'model',
    'trigger',
    'tools',
    'maxCalls',
    'maxOutputChars',
  ]);
  let model: AgentDefinition['model'] = null;
  if (agent.model !== null) {
    const ref = record(agent.model, ['id']);
    // Model IDs belong to the model registry; do not apply agent naming rules to them.
    if (
      typeof ref.id !== 'string' ||
      !ref.id.trim() ||
      ref.id.length > 100 ||
      unsafeIds.has(ref.id)
    )
      fail('INVALID_MODEL_ID');
    model = { id: ref.id };
  }
  if (agent.trigger !== 'before' && agent.trigger !== 'on-demand') fail('INVALID_TRIGGER');
  const tools = list(agent.tools, readScopes.length).map((scope) => {
    if (typeof scope !== 'string' || !readScopes.includes(scope as AgentReadScope))
      fail('INVALID_TOOL');
    return scope as AgentReadScope;
  });
  unique(tools, 'DUPLICATE_TOOL');
  return {
    id: agentId(agent.id),
    title: text(agent.title, 1, 120),
    description: text(agent.description, 0, 2000),
    instructions: text(agent.instructions, 1, 30_000),
    model,
    trigger: agent.trigger,
    tools,
    maxCalls: integer(agent.maxCalls, 1, 6),
    maxOutputChars: integer(agent.maxOutputChars, 500, 20_000),
  };
}

/** Validate disabled drafts too, and return detached JSON data without normalizing authored text. */
export function validateAgentCollaboration(
  value: unknown,
  controlIds?: readonly string[]
): AgentCollaboration {
  const input = record(value, [
    'enabled',
    'sharedInstructions',
    'sharedControls',
    'maxCalls',
    'agents',
  ]);
  if (typeof input.enabled !== 'boolean') fail('INVALID_ENABLED');
  const sharedControls = list(input.sharedControls, 64).map(controlId);
  unique(sharedControls, 'DUPLICATE_CONTROL');
  if (controlIds !== undefined) {
    const available = new Set(controlIds);
    if (sharedControls.some((id) => !available.has(id))) fail('UNKNOWN_CONTROL');
  }
  const agents = list(input.agents, 6).map(definition);
  if (input.enabled && agents.length === 0) fail('AGENTS_REQUIRED');
  unique(
    agents.map((agent) => agent.id),
    'DUPLICATE_AGENT_ID'
  );
  return {
    enabled: input.enabled,
    sharedInstructions: text(input.sharedInstructions, 0, 30_000),
    sharedControls,
    // The total is a shared ceiling, not a sum of reserved per-agent calls.
    maxCalls: integer(input.maxCalls, 1, 12),
    agents,
  };
}

export function createAgentCollaboration(): AgentCollaboration {
  return {
    enabled: false,
    sharedInstructions: '',
    sharedControls: [],
    maxCalls: 3,
    agents: [],
  };
}

/** Editable starting points; the host owns execution, and the main agent owns the final prose. */
export function createAgentDefinition(
  kind: 'character' | 'lore' | 'custom',
  id: string
): AgentDefinition {
  const agent: AgentDefinition = {
    id: agentId(id),
    title: '사용자 정의 협업자',
    description: '필요한 관점과 맡길 질문을 직접 정해요.',
    instructions: [
      '공유 지침과 전달받은 질문에 따라 맡은 관점에서 검토한다.',
      '확인한 근거와 해석, 불확실한 부분을 구분해 짧은 참고 의견을 제시한다.',
      '자료와 대화는 읽기만 하며, 최종 서술과 선택은 메인 에이전트에 맡긴다.',
      '특정한 도덕적 결론이나 인물의 합리성, 사건의 진행을 요구하지 않는다.',
    ].join('\n'),
    model: null,
    trigger: 'on-demand',
    tools: ['story'],
    maxCalls: 2,
    maxOutputChars: 6000,
  };
  if (kind === 'character') {
    agent.title = '인물 관점 협업자';
    agent.description = '인물의 동기와 관계, 서로 다르게 알고 있는 정보를 살펴봐요.';
    agent.instructions = [
      '현재 장면과 자료를 바탕으로 인물의 욕구, 감정, 동기와 관계를 살펴본다.',
      '인물마다 아는 정보와 모르는 정보, 오해와 숨긴 의도를 구분해 정보 비대칭을 짚는다.',
      '해석의 근거와 다른 가능성을 제시하고, 근거가 없는 내면은 가정으로 표시한다.',
      '인물이 항상 합리적이거나 도덕적으로 행동해야 한다고 전제하지 않는다.',
      '갈등 해소나 사건 진행을 강요하지 않고, 사용자가 제시하지 않은 선택을 대신 확정하지 않는다.',
      '자료와 대화를 읽고 참고 의견만 전달하며, 최종 서술은 메인 에이전트에 맡긴다.',
    ].join('\n');
    agent.tools = ['knowledge', 'notes', 'story'];
  } else if (kind === 'lore') {
    agent.title = '설정 근거 협업자';
    agent.description = '출처가 있는 사실과 인물의 믿음, 아직 확인하지 못한 가정을 구분해요.';
    agent.instructions = [
      '질문에 관련된 설정과 기록을 읽고, 확인 가능한 출처를 함께 제시한다.',
      '출처가 있는 사실, 인물의 믿음이나 주장, 검토를 위한 가정을 분리해 정리한다.',
      '출처 간 충돌이나 정보 부족은 그대로 표시하고, 없는 근거를 만들지 않는다.',
      '추측을 확정된 설정으로 바꾸거나 자료를 수정하지 않고 참고 의견만 전달한다.',
      '도덕적 결론이나 인물의 합리성, 사건 진행을 요구하지 않으며 최종 서술은 메인 에이전트에 맡긴다.',
    ].join('\n');
    agent.tools = ['knowledge', 'notes', 'story'];
  } else if (kind !== 'custom') fail('INVALID_TEMPLATE');
  return agent;
}
