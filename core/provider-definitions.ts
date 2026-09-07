import type { ProviderProtocol } from './product.js';
import { SOL_GATEWAYS } from './sol-config.js';

/** Local adapter metadata, not a provider catalog or a grant of connection authority. */
export type ProviderDefinition = Readonly<{
  id: ProviderProtocol;
  revision: 1;
  label: string;
  /** Empty means the user must supply the existing adapter's endpoint. */
  endpointDefault: string;
  /** An environment-variable name only; never a credential value. */
  credentialEnvDefault: string;
  auth: 'none' | 'bearer' | 'api-key' | 'adc-or-bearer';
  catalog: 'remote' | 'local-support';
  /** Top-level model-preset options accepted by the local adapter. Model support is unknown. */
  optionKeys: readonly string[];
  source: Readonly<{ kind: 'adapter'; reference: string; checkedAt: '2026-09-07' }>;
  modelCapabilities: Readonly<{ tools: null; structuredOutput: null }>;
  price: 'unknown';
  limitations: readonly string[];
}>;

type DefinitionInput = Pick<ProviderDefinition, 'id' | 'label' | 'endpointDefault' | 'credentialEnvDefault' | 'auth' | 'catalog' | 'optionKeys' | 'limitations'> & { reference: string };
function definition({ reference, ...input }: DefinitionInput): ProviderDefinition {
  return Object.freeze({ ...input, revision: 1,
    optionKeys: Object.freeze([...input.optionKeys]), limitations: Object.freeze([...input.limitations]),
    source: Object.freeze({ kind: 'adapter', reference, checkedAt: '2026-09-07' }),
    modelCapabilities: Object.freeze({ tools: null, structuredOutput: null }), price: 'unknown',
  });
}
const responsesOptions = ['maxOutputTokens', 'temperature', 'timeoutMs', 'structuredOutput', 'reasoningEffort'];

export const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = Object.freeze([
  definition({ id: 'fixture-sse-v1', label: '로컬 fixture · 검사용', endpointDefault: '', credentialEnvDefault: '', auth: 'none', catalog: 'remote',
    optionKeys: ['maxOutputTokens', 'temperature', 'timeoutMs', 'thinkingLevel'], reference: 'core/transport.ts#executeProvider',
    limitations: ['이 컴퓨터의 127.0.0.1 또는 [::1] 주소에서만 사용하는 검사용 연결이에요.', '모델 목록은 로컬 검사 서버에서 가져와요. 실제 공급자 호환성과 모델의 옵션 지원은 별도로 확인해야 해요.', '인증이 필요한 검사 서버에는 서버 환경변수 이름을 지정할 수 있어요.'] }),
  definition({ id: 'vertex-gemini-v1', label: 'Vertex AI · Gemini 3.8 Flash', endpointDefault: '', credentialEnvDefault: '', auth: 'adc-or-bearer', catalog: 'local-support',
    optionKeys: ['maxOutputTokens', 'timeoutMs', 'thinkingLevel'], reference: 'core/vertex.ts#executeVertexProvider',
    limitations: ['global 프로젝트 endpoint와 gemini-3.8-flash만 지원해요. temperature는 null로 저장해요.', '모델 목록은 어댑터의 로컬 지원 목록이며 인증이나 원격 가용성을 확인하지 않아요.', 'ADC는 서버의 GOOGLE_APPLICATION_CREDENTIALS 파일을 사용해요. requestTier는 모델 옵션이 아닌 연결 옵션이에요.', '서버의 기존 요청 수·금액 예산 검사를 유지하며 실제 청구액은 미확인이에요.'] }),
  definition({ id: 'openai-responses-v1', label: 'OpenAI · Responses', endpointDefault: 'https://api.openai.com/v1', credentialEnvDefault: 'NARRATIVE_PROVIDER_OPENAI', auth: 'bearer', catalog: 'remote',
    optionKeys: responsesOptions, reference: 'core/openai-protocol.ts#encodeResponses',
    limitations: ['공식 API 기본 주소만 허용해요.', '번역 JSON Schema 기본값과 개별 모델의 옵션 지원은 별개예요. 실제 외부 호환성은 확인하지 않았어요.'] }),
  definition({ id: 'anthropic-messages-v1', label: 'Anthropic · Messages', endpointDefault: 'https://api.anthropic.com/v1', credentialEnvDefault: 'NARRATIVE_PROVIDER_ANTHROPIC', auth: 'api-key', catalog: 'remote',
    optionKeys: [...responsesOptions, 'thinkingMode', 'thinkingBudgetTokens'], reference: 'core/anthropic-protocol.ts#encodeAnthropic',
    limitations: ['공식 API 기본 주소와 x-api-key 인증을 사용해요.', 'thinkingMode가 enabled일 때만 thinkingBudgetTokens를 지정해요. enabled·adaptive thinking은 temperature와 함께 사용하지 않아요.', 'temperature와 reasoningEffort는 기존 Anthropic 검증 범위를 따르며 모델별 지원은 미확인이에요.'] }),
  definition({ id: 'vercel-chat-v1', label: 'Vercel AI Gateway', endpointDefault: 'https://ai-gateway.vercel.sh/v1', credentialEnvDefault: 'NARRATIVE_PROVIDER_VERCEL', auth: 'bearer', catalog: 'remote',
    optionKeys: responsesOptions, reference: 'core/openai-chat-protocol.ts#encodeChat',
    limitations: ['Vercel의 공식 API 기본 주소에서 Chat Completions 형식을 사용해요.', '번역 JSON Schema는 명시 선택할 때만 요청하며 모델별 옵션·도구 지원은 미확인이에요.'] }),
  definition({ id: 'openai-chat-v1', label: 'OpenAI 호환 · 별도 공급자', endpointDefault: '', credentialEnvDefault: 'NARRATIVE_PROVIDER_CUSTOM', auth: 'bearer', catalog: 'remote',
    optionKeys: responsesOptions, reference: 'core/openai-chat-protocol.ts#encodeChat',
    limitations: ['서버에서 허용한 HTTPS 주소나 이 컴퓨터의 로컬 HTTP 주소를 사용할 수 있어요.', '인증이 필요한 공급자에는 서버 환경변수 이름을 지정해 주세요.', 'Chat Completions 지원 여부는 공급자에서 확인해 주세요. 번역 구조화 출력은 필요할 때 직접 켜요.'] }),
  definition({ id: 'sol-responses-v1', label: 'Sol · Responses', endpointDefault: SOL_GATEWAYS[0].endpoint, credentialEnvDefault: SOL_GATEWAYS[0].credentialEnv, auth: 'bearer', catalog: 'remote',
    optionKeys: [...responsesOptions, 'sol'], reference: 'core/sol-protocol.ts#encodeSolResponses',
    limitations: ['목록의 세 게이트웨이와 서버에서 허용한 로컬 /v1 주소를 지원해요.', '도구를 사용한 추가 요청도 이야기의 전체 호출 한도에 포함돼요.', '완성된 원고만 본문으로 저장해요. 도구는 이야기에서 허용한 자료만 읽을 수 있어요.', '게이트웨이와 모델의 실제 호환성 및 가격은 별도로 확인해 주세요.'] }),
]);

export function providerDefinition(protocol: ProviderProtocol): ProviderDefinition {
  const found = PROVIDER_DEFINITIONS.find(item => item.id === protocol);
  if (!found) throw new Error('UNSUPPORTED_PROTOCOL');
  return found;
}
