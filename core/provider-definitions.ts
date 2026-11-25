import { JEV_PROVIDER_DEFINITION } from './jev-provider.js';
import type { ProviderProtocol } from './product.js';

export type ProviderDefinition = Readonly<{
  id: ProviderProtocol;
  revision: 1;
  label: string;
  endpointDefault: string;
  credentialRefDefault: string;
  auth: 'none' | 'bearer' | 'api-key' | 'adc-or-bearer' | 'codex-login';
  catalog: 'remote' | 'agent-runtime';
  optionKeys: readonly string[];
  source: Readonly<{ kind: 'adapter'; reference: string; checkedAt: '2026-09-07' | '2026-10-08' }>;
  modelCapabilities: Readonly<{ tools: null; structuredOutput: null }>;
  price: 'unknown';
  limitations: readonly string[];
}>;

type DefinitionInput = Pick<
  ProviderDefinition,
  | 'id'
  | 'label'
  | 'endpointDefault'
  | 'credentialRefDefault'
  | 'auth'
  | 'catalog'
  | 'optionKeys'
  | 'limitations'
> & { reference: string; checkedAt?: ProviderDefinition['source']['checkedAt'] };
function definition({
  reference,
  checkedAt = '2026-09-07',
  ...input
}: DefinitionInput): ProviderDefinition {
  return Object.freeze({
    ...input,
    revision: 1,
    optionKeys: Object.freeze([...input.optionKeys]),
    limitations: Object.freeze([...input.limitations]),
    source: Object.freeze({ kind: 'adapter', reference, checkedAt }),
    modelCapabilities: Object.freeze({ tools: null, structuredOutput: null }),
    price: 'unknown',
  });
}
const responsesOptions = [
  'maxOutputTokens',
  'temperature',
  'timeoutMs',
  'structuredOutput',
  'reasoningEffort',
];

export const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = Object.freeze([
  definition({
    id: 'codex-app-server-v1',
    label: 'Codex, ChatGPT 구독',
    endpointDefault: 'codex://local',
    credentialRefDefault: '',
    auth: 'codex-login',
    catalog: 'agent-runtime',
    optionKeys: ['maxOutputTokens', 'timeoutMs', 'reasoningEffort'],
    reference: 'core/codex-protocol.ts#buildCodexTurn',
    limitations: [
      '서버의 공식 Codex 실행기에 직접 로그인해 사용해요. API 키를 저장하지 않아요.',
      '도구 실행은 Uimori가 관리해요. 최대 출력 토큰은 출력량을 조절하는 참고값이며, 실제 출력이 이 값을 넘을 수 있어요.',
      '작업 횟수와 내부 모델 호출 횟수는 별개예요.',
      'Risu 프롬프트는 메시지 역할과 순서를 담은 JSON으로 전달해요. Codex 자체 지침도 추가돼 API에 메시지를 직접 보낼 때와 역할 해석이 다를 수 있어요. 응답 시작 부분을 미리 채우는 prefill과 캐시 사용을 필수로 지정하는 옵션은 지원하지 않아요.',
    ],
  }),
  definition({
    id: 'fixture-sse-v1',
    label: '로컬 fixture (검사용)',
    endpointDefault: '',
    credentialRefDefault: '',
    auth: 'none',
    catalog: 'remote',
    optionKeys: ['maxOutputTokens', 'temperature', 'timeoutMs', 'thinkingLevel'],
    reference: 'core/transport.ts#executeProvider',
    limitations: [
      '이 컴퓨터의 127.0.0.1 또는 [::1] 주소에서만 사용하는 검사용 연결이에요.',
      '모델 목록은 로컬 검사 서버에서 가져와요.',
    ],
  }),
  definition({
    id: 'vertex-gemini-v1',
    label: 'Google Agent Platform',
    endpointDefault: '',
    credentialRefDefault: '',
    auth: 'adc-or-bearer',
    catalog: 'remote',
    optionKeys: [
      'maxOutputTokens',
      'temperature',
      'timeoutMs',
      'thinkingLevel',
      'topP',
      'stopSequences',
      'safetySettings',
      'serviceTier',
    ],
    reference: 'core/vertex.ts#executeGeminiProvider',
    limitations: [
      'Gemini 모델에 연결해요. 위치를 global로 두면 Google이 처리 위치를 정해요.',
      '등록한 Vertex 인증으로 Google Model Garden의 Gemini 목록을 조회할 수 있어요.',
      'ADC는 서버의 GOOGLE_APPLICATION_CREDENTIALS에 지정한 파일을 사용해요. Flex는 모델의 Service Tier에서 선택해요.',
    ],
  }),
  definition({
    id: 'google-gemini-v1',
    checkedAt: '2026-10-08',
    label: 'Google AI Studio Gemini',
    endpointDefault: 'https://generativelanguage.googleapis.com/v1beta',
    credentialRefDefault: 'GEMINI_API_KEY',
    auth: 'api-key',
    catalog: 'remote',
    optionKeys: [
      'maxOutputTokens',
      'temperature',
      'timeoutMs',
      'thinkingLevel',
      'topP',
      'stopSequences',
      'safetySettings',
      'serviceTier',
    ],
    reference: 'core/vertex.ts#executeGeminiProvider',
    limitations: [
      'Google AI Studio에서 발급한 Gemini API 키를 등록해요. Google Cloud 서비스 계정은 필요하지 않아요.',
      '공식 Gemini API에서 생성과 모델 목록 조회에 같은 API 키를 사용해요.',
      '요금은 모델 프리셋에서 직접 설정해요.',
    ],
  }),
  definition({
    id: 'openai-responses-v1',
    label: 'OpenAI Responses',
    endpointDefault: 'https://api.openai.com/v1',
    credentialRefDefault: 'OPENAI_API_KEY',
    auth: 'bearer',
    catalog: 'remote',
    optionKeys: [
      ...responsesOptions,
      'verbosity',
      'reasoningMode',
      'reasoningContext',
      'serviceTier',
      'cacheMode',
      'cacheTtl',
    ],
    reference: 'core/openai-protocol.ts#encodeResponses',
    limitations: ['서버에서 허용한 HTTPS 주소나 이 컴퓨터의 로컬 HTTP 주소를 사용할 수 있어요.'],
  }),
  definition({
    id: 'anthropic-messages-v1',
    label: 'Anthropic Messages',
    endpointDefault: 'https://api.anthropic.com/v1',
    credentialRefDefault: 'ANTHROPIC_API_KEY',
    auth: 'api-key',
    catalog: 'remote',
    optionKeys: [
      'maxOutputTokens',
      'timeoutMs',
      'structuredOutput',
      'outputEffort',
      'thinkingMode',
      'stopSequences',
      'serviceTier',
      'cacheMode',
      'cacheTtl',
    ],
    reference: 'core/anthropic-protocol.ts#encodeAnthropic',
    limitations: [
      '공식 API 기본 주소와 API 키 인증을 사용해요.',
      'Claude 모델의 추론 강도와 사고 모드를 모델이 지원하는 조합으로 사용해요.',
    ],
  }),
  definition({
    id: 'vercel-chat-v1',
    label: 'Vercel AI Gateway',
    endpointDefault: 'https://ai-gateway.vercel.sh/v1',
    credentialRefDefault: 'VERCEL_API_KEY',
    auth: 'bearer',
    catalog: 'remote',
    optionKeys: [
      ...responsesOptions,
      'serviceTier',
      'topP',
      'stopSequences',
      'outputEffort',
      'thinkingMode',
      'thinkingLevel',
      'verbosity',
    ],
    reference: 'core/openai-chat-protocol.ts#encodeChat',
    limitations: [
      'Vercel의 공식 API 기본 주소에서 Chat Completions 형식을 사용해요.',
      '모델 계열을 선택하면 OpenAI, Anthropic, Google, DeepSeek, xAI 계열의 생성 옵션을 같은 게이트웨이에서 사용할 수 있어요. providerOptions는 추가 라우팅이나 새 프로바이더 옵션용이에요.',
    ],
  }),
  definition({
    id: 'deepseek-chat-v1',
    label: 'DeepSeek, OpenAI 호환',
    endpointDefault: 'https://api.deepseek.com/v1',
    credentialRefDefault: 'DEEPSEEK_API_KEY',
    auth: 'bearer',
    catalog: 'remote',
    optionKeys: ['maxOutputTokens', 'temperature', 'timeoutMs', 'reasoningEffort', 'serviceTier'],
    reference: 'core/openai-chat-protocol.ts#encodeChat',
    limitations: [
      'DeepSeek 공식 주소에서 OpenAI Chat Completions 형식을 사용해요.',
      'V4 Pro와 V4.1 Flash를 지원해요. Reasoning Effort의 none은 사고를 끄며 기본값은 high예요.',
      '사고를 켜면 temperature를 사용할 수 없어요.',
    ],
  }),
  definition({
    id: 'openai-chat-v1',
    label: 'OpenAI 호환, 별도 프로바이더',
    endpointDefault: '',
    credentialRefDefault: 'PROVIDER_API_KEY',
    auth: 'bearer',
    catalog: 'remote',
    optionKeys: [...responsesOptions, 'serviceTier'],
    reference: 'core/openai-chat-protocol.ts#encodeChat',
    limitations: ['서버에서 허용한 HTTPS 주소나 이 컴퓨터의 로컬 HTTP 주소를 사용할 수 있어요.'],
  }),
]);

export function providerDefinition(protocol: ProviderProtocol): ProviderDefinition {
  const found = PROVIDER_DEFINITIONS.find((item) => item.id === protocol);
  if (!found) throw new Error('UNSUPPORTED_PROTOCOL');
  return found;
}

export const PROVIDER_CHOICES = Object.freeze([
  ...PROVIDER_DEFINITIONS.map((provider) => ({ ...provider, kind: 'generation' as const })),
  JEV_PROVIDER_DEFINITION,
]);
