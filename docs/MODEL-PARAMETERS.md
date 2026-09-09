# 모델 생성 설정과 연결 테스트

고급 탭의 공식/직접 입력 단가와 호출 후 추정 비용은 [모델 요금](MODEL-PRICING.md)을 봐요. 가격은 모델 실행 지원 여부를 결정하지 않아요.

2026-09-09 기준 구현 계약이에요. 모델별 옵션 힌트와 프로토콜 단위 검증은 `core/model-capabilities.ts`, 요청 변환은 각 공급자 encoder가 관리해요. 실제 공급자 요청·캐시 hit·청구액은 합성 검사만으로 확인하지 않아요.

모델 ID는 실행 조건이 아니에요. 이렇게 정한 근거는 [모델 등록 결정](MODEL-REGISTRATION.md)에 있어요. 앱의 힌트 표는 검토한 모델의 옵션 목록과 한도를 먼저 보여주는 용도이며, 표에 없는 ID나 값도 그대로 공급자에 보내요. 저장 검증은 프로토콜의 encoder가 보낼 수 있는 옵션과 값 어휘만 확인해요. 모델별 지원 여부는 공급자의 응답이 판정하고, 4xx 거절이 가리킨 옵션은 실패 턴 카드·보조 작업 카드·응답 테스트 결과에 이름으로 표시해요. 공급자 메시지 원문은 저장하거나 보여주지 않아요.

모델·연결 편집은 최신 설정 한 벌을 갱신해요. 사용자가 고르는 버전이나 과거 설정 목록은 없어요. 내부 revision은 동시 편집 충돌을 막는 CAS 토큰이며, 새 생성·번역 예약·상태 재구축·문맥 정리은 모델 ID로 최신 설정을 읽어요. 진행 중인 작업과 과거 Run은 자기 모델·연결 snapshot을 유지해요. 연결의 프로토콜을 바꾸면 모델 설정을 다시 검토·저장하기 전까지 새 실행을 차단해요.

입력 컨텍스트 한도와 자동 요약은 [컨텍스트 문서](CONTEXT-LIMITS.md)를 확인해요. 기본 입력 한도 272,000은 로컬 추정 기준이며, 출력 토큰 한도와 별개예요.

## 연결과 지원 모델

연결에는 접속 주소와 서버 인증 참조를 저장하고, 생성 설정은 모델 프리셋에 저장해요. Google 카드 이름은 **Google Agent Platform**, API 프로토콜은 `vertex-gemini-v1`이며 location은 **global 고정**이에요.

| 경로 | 검토한 모델 ID | 주요 옵션 |
| --- | --- | --- |
| Google Agent Platform | `gemini-3.5-flash-lite`, `gemini-3.8-flash`, `gemini-3.1-pro-preview` | Thinking Level, Standard/Flex, 출력 한도. Flash-Lite는 MINIMAL(기본)/MEDIUM/HIGH. 3.1 Pro만 temperature/top-p 제공 |
| OpenAI Responses | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.6`, `gpt-6-astra` | Reasoning Effort/Mode/Context, Verbosity, Service Tier(Flex 포함) |
| Anthropic Messages | `claude-opus-5`, `claude-fable-5-1` | Output Effort, Thinking, Service Tier, 정지 문자열 |
| OpenAI Chat | 위의 등록된 GPT ID | Reasoning Effort와 Service Tier(Flex 포함). Responses 전용 제어와 캐시 설정은 제공하지 않음 |
| Vercel AI Gateway | `spacexai/grok-4.6`, `openai/gpt-5.6-sol` | Grok low/medium/high/xhigh, Sol none/low/medium/high/xhigh 및 Service Tier default/flex. 출력 한도 500,000/128,000 |
| DeepSeek · OpenAI 호환 Chat | `deepseek-v4-pro`, `deepseek-v4-flash` | none(추론 끄기)/low/high/max, 기본 high. 출력 한도 384,000. temperature는 none에서만 제공 |
| 표에 없는 모델 | 수동 모델 ID 또는 목록의 ID | 해당 프로토콜이 보낼 수 있는 옵션 전체. 지원 여부는 공급자 응답으로 확인 |

2026-09-09 추가 모델은 [Google Flash-Lite](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash-lite), [Vercel Grok](https://vercel.com/ai-gateway/models/grok-4.6), [Vercel Sol](https://vercel.com/ai-gateway/models/gpt-5.6-sol), [DeepSeek](https://api-docs.deepseek.com/quick_start/pricing/) 공식 명세를 확인했어요. 표의 출력 상한은 목록에서 모델을 고를 때 미리 채우는 값이고, 저장 검증은 모든 모델에 500,000까지 허용해요. 실제 상한은 공급자가 판정해요. 이 값은 최대 허용량이며 기본 출력량을 늘리지 않아요. 실제 공급자 호출·계정 가용성은 별도 확인이 필요해요.

표에 없는 ID도 저장·실행해요. 모델 목록 API는 ID 발견에 사용하고, 옵션 지원 근거는 표의 힌트와 공급자 응답이에요. 임의 호환 URL에 표의 모델 ID를 넣어도 공식 서버의 가용성을 보증하지 않아요.

`모델 기본값`은 API 필드를 생략해요. `none`, `disabled`, 숫자 0은 명시값이에요. 모델 변경으로 부적합해진 값은 초안에 남겨 표시하고, 사용자가 수정하기 전 저장하지 않아요. provider 오류에 따른 effort 하향이나 Flex→Standard 자동 전환은 없어요.

Fable 5.1은 Adaptive Thinking이 항상 켜져 있어요. 강제 도구 호출을 지원하지 않으므로 평가 도구의 `preloaded` 모드는 함께 저장할 수 없고 `model-selected`를 사용해요. Opus 5는 Thinking을 끌 수 있지만 Output Effort `xhigh/max`와 동시에 끌 수 없어요.

지원 기간 6개월은 힌트 표를 재검토하는 운영 기준이고 실행을 막는 기능은 아니에요. Gemini 3.1 Pro는 사용자가 지정한 기준 모델 예외예요. 새 ID나 suffix는 표에 없어도 바로 쓸 수 있고, 표에 추가하면 옵션 목록이 먼저 보여요. API 출시일을 확인하지 못한 모델의 날짜는 추정하지 않아요.

## 캐시 위치·자동 배치·유지 시간

프롬프트 편집기의 **캐시 기준점** 블록은 그 위치 앞의 메시지를 기준으로 해요. 대상 역할과 메시지 수(1–4), `지원하면 적용`/`지원 필수`를 선택해요. 미리보기의 `캐시 기준과 지원 제한`에는 공급자 변환 결과가 나타나요.

모델의 캐시 설정은 다음과 같아요.

| 설정 | 동작 |
| --- | --- |
| 미지정 | 프롬프트에 기준점이 있으면 사용. 없으면 공급자 기본 동작 |
| 캐시 끄기 | 프롬프트의 필수 기준점까지 명시적으로 억제하고 진단에 남김. Claude는 cache_control 생략, GPT Responses는 explicit 모드와 0개 기준점 |
| 프롬프트 캐시 기준점만 | 작성한 위치만 사용. 기준점이 없으면 캐시를 만들지 않음 |
| 자동 캐싱 + 기준점 | 공급자가 최근 캐시 가능한 블록에 자동 기준점 1개를 배치하고, 작성한 기준점도 함께 사용 |

자동 모드에서는 명시 기준점을 최대 3개까지 사용해요. 4개를 지정하면 전송 전에 거절하며 임의 위치를 제거하지 않아요. 미지정·명시 모드의 기존 prefer/require 지원 제한은 유지해요. 캐시 OFF는 사용자의 모델 설정이므로 필수 기준점보다 우선해요.

- **Claude**: 5분(`5m`) 또는 60분(`1h`). 유지 시간을 생략하면 공급자 기본 5분이에요. 60분은 캐시 쓰기 비용이 더 높아요. 모든 기준점과 자동 캐시에는 같은 시간을 적용해요.
- **GPT-5.6 이후 Responses**: 현재 확인한 TTL은 30분(`30m`)뿐이에요. 선택한 mode는 `prompt_cache_options.mode`, 기준점은 `prompt_cache_breakpoint`로 전달해요.
- TTL을 명시하려면 명시/자동 모드를 선택해요. 캐시 OFF 또는 모드 미지정에 TTL만 남은 조합은 수정 전 저장하지 않아요.
- **Gemini**: 기존 암묵적 캐시는 공급자가 처리해요. 이번 앱에는 `cachedContents` 생성·갱신·삭제 기능이나 프로젝트 전체 암묵적 캐시 제어가 없으므로 OFF·TTL 선택을 제공하지 않아요. Chat/Vercel/호환 연결에도 지원을 추정하지 않아요.

캐시 포인트는 API 요청상의 경계예요. 최소 길이, 같은 prefix, 공급자 가용성 등의 조건에 따라 실제 재사용 여부가 달라져요. Inspector는 공급자가 보고한 읽기/쓰기 토큰과 Claude의 5분/60분 쓰기 항목을 표시해요. 누락된 usage는 `미확인`이고 설정값에서 hit·절감액을 계산하지 않아요.

유미 프로바이더에서는 메시지 경계의 캐시 표시, TTL의 명시 전달, 연속 대화의 reasoning 보존 원리를 참고했어요. 코드 복사나 모델별 이름 추정·임의 body 병합은 하지 않았어요. 자동 배치는 공급자의 공식 자동 캐싱 계약을 사용해요.

## 응답 테스트

저장한 모델의 **응답 테스트** 버튼은 실제 요청을 한 번 보내요. 이 작업을 구현·검증하는 동안에는 합성 응답만 사용하며, 사용자가 버튼을 눌러야 실제 공급자 요청이 시작돼요.

요청 문구는 **API 연결 테스트 중이니 OK만 답해주세요.**예요. 프리셋에 저장한 생성 옵션을 그대로 보내되 출력 한도 256토큰, 25초 제한, 도구 없음, 재시도 없음으로 실행해요. 캐시 모드를 지원하는 프로토콜에서는 캐시를 끄고, Service Tier와 사고 강도는 프리셋 값을 유지해요. 그래서 테스트 결과는 그 프리셋 옵션에 대한 공급자의 판정이에요. 채팅·작품·프롬프트 자료는 보내지 않아요.

결과에는 실제 텍스트(최대 2,000자), 상태·오류·지연·토큰 usage가 있어요. 공급자가 요청을 거절하면 거절된 옵션 이름과 공급자 코드를 함께 표시해요. 응답이 일부만 왔거나 시간 초과인 경우 완료와 구분해요. 실제 응답을 받았다는 사실이 긴 창작·도구 호출·Flex 가용성·캐시 hit 전체를 보증하지 않아요.

서버는 전송 전에 별도 로컬 진단을 기록해요. 같은 idempotency key는 재전송하지 않고, 같은 모델의 동시 테스트는 하나로 제한해요. 재시작으로 미완료된 테스트는 interrupted로 끝내며 자동 재생하지 않아요. `provider_connection_tests`는 작품 JSON archive에서 제외하고 전체 SQLite 백업에는 포함해요.

## 저장·실행 경계

현재 schema/archive는 v15이며 연결의 구형 requestTier, Claude 공통 reasoningEffort, 모델의 capabilityRevision 저장 형식을 받지 않아요. 구버전 자동 이관·호환 UI·자동 백업은 없고 사용자 DB를 자동 초기화하지 않아요.

모델 revision은 생성 옵션을 보관해요. Run/job snapshot은 이를 고정하며, main/translation/status/image/state/context/helper는 공통 추출기로 같은 필드를 전달해요. 최신 연결 enabled·endpoint·인증·origin 권한은 호출마다 다시 확인해요. 평가 절약 모드는 명시 opt-in일 때만 출력 한도·effort를 줄이고 나머지 binding을 바꾸지 않아요.

누적 호출 횟수와 추정 금액으로 차단하던 ProviderBudget은 제거됐어요. 요청별 출력·시간·도구 반복 한도, 전송 전 기록, 취소·중복 방지, 원문/hash 귀속, 실제 usage와 `costUsd=null`은 유지해요.

## 공식 근거

- [Google 명칭](https://docs.cloud.google.com/gemini-enterprise-agent-platform/vertex-ai-name-changes), [Gemini 3.8 Flash](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash), [Gemini 3.1 Pro](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-pro)
- [OpenAI GPT-5.6](https://developers.openai.com/api/docs/guides/latest-model/gpt-5.6), [Reasoning](https://developers.openai.com/api/docs/guides/reasoning), [Flex](https://developers.openai.com/api/docs/guides/flex-processing), [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Claude Opus 5](https://platform.claude.com/docs/en/models/opus-5/whats-new-opus-5), [Fable 5.1](https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1), [Effort](https://platform.claude.com/docs/en/build-with-claude/effort), [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
