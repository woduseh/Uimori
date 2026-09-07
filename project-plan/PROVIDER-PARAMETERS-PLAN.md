# 공급자·모델 파라미터 개편 계획

상태: **구현 후 통합 검증 중**. 아래는 2026-09-07 검토한 설계 근거예요. 사용자가 구현과 병행 조율을 요청한 뒤 Fable 5.1·GPT Flex·캐시 ON/OFF/TTL·짧은 연결 테스트를 추가했어요. Google은 global 고정, ProviderBudget은 제거, schema/archive는 v9예요. 최종 동작은 [모델 파라미터·캐시·연결 테스트](../docs/MODEL-PARAMETERS.md)를 봐요. 실제 외부 API 호출이나 사용자 DB 초기화는 하지 않았어요.

후속 요청으로 모델·연결의 편집 버전 선택을 제거했고, 최신 설정 한 벌과 실행 snapshot을 분리했어요. 입력 한도·이전 대화 자동 요약은 [현재 컨텍스트 계약](../docs/CONTEXT-LIMITS.md)으로 확장했어요. 출력 한도 확대 요청은 사용자가 바로 철회해 변경하지 않았어요. 2026-09-08 사용자가 병행 작업과 함께 main 병합·커밋을 승인했으며 통합 검증 뒤 진행해요.

## 1. 목표와 현재 원인

연결은 인증과 접속 위치를, 모델 프리셋은 생성 파라미터를 담당해요. 선택한 모델에서 지원하는 옵션만 표시하고, 저장한 값이 모든 역할의 실제 API 요청까지 전달되게 해요. 최신 주력 모델에 집중하며 구형 모델을 위한 예외와 임의 파라미터 우회 경로를 늘리지 않아요.

| 사용자 요구 | 현재 확인한 상태 | 제안 |
| --- | --- | --- |
| Vertex 뒤의 Gemini 3.8 Flash 제거·이름 변경 | `core/provider-definitions.ts:37`이 공급자와 단일 모델을 함께 표시해요. | 카드 이름은 **Google Agent Platform**, 부제는 **Gemini 모델 연결**로 해요. 모델명은 모델 선택 화면에만 표시해요. |
| global 고정으로 범위 축소 | `core/product.ts:38`, `web/ProviderManagement.tsx:150`이 global만 허용·생성해요. | 현재 global endpoint를 유지해요. 리전 선택기를 추가하지 않아요. |
| Flex 문구 단순화 | `web/ProviderManagement.tsx:154`의 긴 선택지예요. | 선택지에는 **Flex**만 표시해요. 서비스 등급은 모델별 지원을 검증하는 생성 설정에 둬요. |
| Gemini 추론 수준 | `web/ProviderModelFields.tsx:40`에 LOW/MEDIUM/HIGH가 있어요. | **Thinking Level**로 표시하고 모델별 허용값·기본값을 적용해요. |
| OpenAI Reasoning Effort·Verbosity | effort는 같은 파일 48행의 고급 details 안에 있고, verbosity는 타입·UI·요청에 없어요. | 둘 다 생성 설정에 바로 표시하고 Responses의 `reasoning.effort`·`text.verbosity`로 연결해요. |
| Claude Output Effort | UI 이름은 공통 Reasoning effort이고, `core/anthropic-protocol.ts:127`에서 `output_config.effort`로 전달해요. | **Output Effort**로 구분하고 Thinking과의 모델별 조합을 검증해요. |
| 최신 모델 중심 지원 | 지금은 protocol 단위 옵션 목록과 Gemini 단일 모델 상수예요. | 작은 모델 지원 명세와 공급자별 encoder를 사용해요. |

Google의 공식 전체 명칭은 **Gemini Enterprise Agent Platform**이에요. 앱의 짧은 표시는 요청한 **Google Agent Platform**으로 하고 상세 설명에 공식 명칭을 써요. API hostname과 `X-Vertex-*` 헤더는 마케팅 이름과 별개이므로 그대로 실제 계약을 따라요. 내부 `vertex-gemini-v1`도 실제 어댑터 식별자로 유지할 수 있어요. [공식 명칭 변경표](https://docs.cloud.google.com/gemini-enterprise-agent-platform/vertex-ai-name-changes)

## 2. 지원 모델 정책

**최소 세대 + 최근 6개월 우선 + 주력 모델의 명시적 예외**를 기준으로 제안해요.

- 세대 하한: GPT-5 계열 이후, Gemini 3.1 Pro 이후 세대의 범용 Gemini, Claude Opus 5 이후 세대예요. 버전 문자열의 대소 비교로 판정하지 않고 정확한 모델 ID를 등록해요.
- 기본 지원 후보는 조사 시점에서 API 출시 후 6개월 이내의 주력 텍스트 생성 모델이에요. 출시일은 공식 API 공개일을 사용하며 카탈로그의 `created`나 지식 cutoff로 대체하지 않아요.
- 최근 모델이라고 전부 등록하지 않아요. 첫 대상은 Gemini 3.8 Flash·3.1 Pro, Claude Opus 5, GPT-5.6 Sol·Terra·Luna와 GPT-6 Astra로 좁혀요. OpenAI의 각 변형은 개별 문서 검증 후 명세를 확정해요. 사용자가 쓰는 GPT-5 이후 다른 모델은 같은 정책으로 추가할 수 있어요.
- Gemini 3.1 Pro는 2026-02-19 출시라 이번 조사일에는 6개월을 넘었어요. 사용자가 직접 기준으로 지정한 주력 모델 예외로 남기는 안이에요. GPT-5라는 세대 하한이 2025년의 초기 GPT-5 전 모델까지 의무 지원한다는 뜻은 아니에요. [Gemini 3.1 Pro 사양·출시일](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-pro)
- `supportWindowMonths: 6`, 예외 ID·이유, 공식 출처·확인일을 지원 목록 옆의 작은 정책 데이터로 둬요. 기간 변경을 위한 일반 사용자 설정 화면은 만들지 않아요.
- 6개월은 다음 릴리스에서 목록을 재검토하는 기준이에요. 날짜가 지났다는 이유로 실행 중인 요청이나 저장된 프리셋을 갑자기 끄지 않아요. 명시적으로 지원을 종료한 모델은 새 실행 전에 이유를 알려주고 다른 모델로 자동 치환하지 않아요.
- preview는 표시를 구분해 명시적으로 선택할 수 있게 해요. 모든 새 모델·alias가 자동으로 최신 capability를 상속하지 않아요. 공식 직접 연결의 미등록 모델은 **미확인 상태로 저장·검토는 가능하지만 실행은 차단**해요. ID와 표시 정보는 보관하되 임의 생성 필드를 허용하거나 다른 모델의 옵션 명세를 추정하지 않아요. 모델 명세를 검증해 등록한 뒤 실행할 수 있어요. 별도 호환 연결은 7절의 별도 보장 범위를 따라요.

Google 연결의 보장 범위는 Gemini의 범용 텍스트 생성·도구·구조화 출력 경로예요. 같은 플랫폼의 Claude·Gemma·Imagen·Veo와 별도 Live/음성/임베딩 API는 포함하지 않아요. 현재 Uimori의 image 역할이 있다는 이유로 이미지 생성 endpoint를 추가하지 않아요.

## 3. 화면과 저장 위치

| 위치 | 내용 |
| --- | --- |
| 연결 등록·편집 | 표시 이름, 공급자/프로토콜, 인증 참조. Google은 프로젝트 ID와 global 고정 안내. endpoint는 계산 결과를 상세 정보에서 보여줘요. |
| 모델 프리셋 → 기본 정보 | 모델 ID·표시 이름·연결, 지원/preview 상태. Google의 고정 모델 ID·readOnly를 제거해요. |
| 모델 프리셋 → 생성 설정 | 최대 출력 토큰, Thinking Level / Reasoning Effort / Output Effort, Verbosity, 지원되는 Service Tier, 응답 제한 시간. 주요 제어는 details 안에 숨기지 않아요. |
| 모델 프리셋 → 고급 옵션 | 모델이 지원하는 추가 생성 옵션, 기존 구조화 출력·평가 도구. API 지원 조건과 충돌을 해당 필드 가까이에 보여줘요. |

미지정 선택지 이름은 **모델 기본값**이며 해당 API 필드를 생략해요. `none`, `disabled`, 숫자 0은 각각 명시적인 값으로 구분해요. 문서의 기본값은 설명용이고 미지정을 임의의 고정값으로 바꾸지 않아요. 기존에 명시적으로 저장된 값은 모델 기본값과 구별해요.

모델 변경으로 옵션이 부적합해지면 초안에서 표시하고 저장을 막아요. 사용자가 해당 필드를 기본값으로 되돌리거나 다른 지원값을 선택해요. `xhigh → high`, `MINIMAL → LOW`, Flex → Standard 같은 조용한 변환은 하지 않아요.

Service Tier는 모델별 요청 옵션으로 통일해 Google의 연결 `requestTier`도 모델 프리셋으로 옮기는 안이에요. 현재 tier는 `ProductStore.authorize`의 연결 동일성 검사와 등록 보조의 연결 검증에도 포함돼 있어요. 해당 검사를 새 저장 위치에 맞게 바꾸고 tier 검증은 모델 명세·서버 정책에서 유지해요. 서버가 Flex를 강제하면 실제 적용값과 서버 제한을 화면에 표시하고 충돌하는 설정을 허용하지 않아요. `Flex` 선택지에 긴 운영 설명을 붙일 필요는 없어요.

## 4. 모델별 파라미터 계약

| 공급자/경로 | 우선 연결할 설정 | 실제 API 필드·조건 |
| --- | --- | --- |
| Google Gemini | Thinking Level, 최대 출력, Service Tier | `generationConfig.thinkingConfig.thinkingLevel`, `generationConfig.maxOutputTokens`, Flex 전용 요청 헤더. global에서 모델·tier의 조합을 검증해요. |
| OpenAI Responses | Reasoning Effort, Verbosity, 최대 출력 | `reasoning.effort`, `text.verbosity`, `max_output_tokens`. Verbosity는 `low/medium/high`예요. 기존 번역용 `text.format`과 병합해서 둘 다 보존해요. |
| OpenAI Responses의 지원 모델 | Reasoning Mode·Context, Service Tier | `reasoning.mode`, `reasoning.context`, `service_tier`를 고급 생성 옵션으로 연결해요. 모드/문맥의 모델별 지원·기본값과 opaque continuation 계약을 먼저 확인해요. |
| Anthropic Messages | Output Effort, Thinking, 최대 출력 | `output_config.effort`, `thinking.type`, `max_tokens`. 기존 구조화 출력의 `output_config.format`과 함께 보존해요. |
| 샘플링·정지 옵션 | temperature, top-p, stop 등 | 모델과 API가 실제 지원하는 값만 명세에 추가해요. 숫자 입력을 모든 공급자에 일괄 노출하지 않아요. |

공식 문서에서 확인한 중요한 차이예요.

- Gemini 3.8 Flash는 `LOW/MEDIUM/HIGH`, 기본은 `MEDIUM`이에요. `MINIMAL`은 오류이고 temperature/top-p/top-k는 무시돼요. penalty와 candidate-count도 허용하지 않아요. 따라서 이 모델에는 효과 없는 샘플링 입력을 제공하지 않아요. [3.8 Flash 개발 가이드](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash)
- Gemini 3.1 Pro도 `LOW/MEDIUM/HIGH`지만 기본은 `HIGH`예요. 같은 Gemini 세대라고 기본값을 MEDIUM으로 통일하지 않아요. 3.1 Pro 모델 페이지의 샘플링 지원은 3.8 Flash와 다르므로 별도 명세로 관리해요. [Thinking 모델별 표](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking), [3.1 Pro 사양](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-pro)
- GPT-5.6 Sol은 `none/low/medium/high/xhigh/max`, 기본 `medium`이고 GPT-6 Astra는 `none`을 지원하지 않아요. 앱 전체 effort enum을 그대로 모든 모델에 노출하면 안 돼요. [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [Reasoning](https://developers.openai.com/api/docs/guides/reasoning)
- GPT-5.6의 Verbosity·Reasoning Mode·Context는 별개의 제어예요. `pro` 실행 모드는 effort와 독립적이며 호출량·토큰 사용에 영향을 줄 수 있어요. [GPT-5.6 가이드](https://developers.openai.com/api/docs/guides/latest-model/gpt-5.6)
- Claude Opus 5의 Output Effort는 `low/medium/high/xhigh/max`, 기본 `high`예요. adaptive thinking이 기본이고 `disabled`는 effort가 high 이하일 때만 허용돼요. 최신 모델 경로에는 구형 manual `enabled + budget_tokens` 입력을 노출하지 않는 안이에요. Thinking block·signature의 도구 왕복 보존도 필요해요. [Opus 5 변경점](https://platform.claude.com/docs/en/models/opus-5/whats-new-opus-5), [Effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- 최신 Claude의 temperature/top-p/top-k는 실질적인 생성 조절로 사용할 수 없어요. 호환을 위해 허용하는 일부 기본 숫자를 굳이 UI에 노출하지 않고 필드를 생략해요. [Messages API](https://platform.claude.com/docs/en/api/http/messages/create)

이번 개편에서 API의 모든 필드를 무조건 설정창에 복제하지는 않아요. 생성 행동을 바꾸는 안정된 옵션은 지원 명세에 포함하고, messages/input, model, stream, store, 도구 목록·선택 권한, 역할별 JSON schema, 원문/hash 귀속은 Uimori가 소유해요. 임의 JSON/body/header 병합으로 이 계약을 덮어쓰지 못하게 해요. 캐시 breakpoint/TTL의 사용자 편집, provider 내장 검색·코드 실행, beta per-message effort 변경, 멀티모달 endpoint 확장은 별도 후속 범위로 남겨요.

## 5. Google global 고정과 기존 예산 제한 제거

사용자의 후속 결정에 따라 `https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/publishers/google/models` 경로를 유지해요. 리전 선택 UI, us/eu hostname, regional endpoint, location별 가격 분기는 만들지 않아요. 기존 프로젝트 일치·인증·origin 검증을 유지하며 global에서 지원하는 Gemini 모델만 목록에 넣어요. [공식 endpoint 형식](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations)

Flex도 global에서 사용해요. 표시 문구를 **Flex**로 줄이되 모델별 지원 확인, 요청 헤더·적용 결과 확인, Standard 자동 전환 없음은 유지해요. [Flex 지원 범위](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/flex-paygo)

사용자가 제거를 선택했으므로 `server/provider-budget.ts`의 누적 호출·추정 금액 제한을 삭제해요. 모델별 가격표·지출 관리 UI를 새로 만들지 않고, 단가 미등록이나 가격 유효기간 때문에 모델 실행을 막지 않아요.

- 제거 대상: `ProviderBudget`, 고정 단가와 비용 예약/합산, `NR_LIVE_MAX_REQUESTS`·`NR_LIVE_MAX_USD`, `liveBudget` 서버 옵션·health 표시, 예산/가격 관련 실행 차단 오류예요.
- 연결 정리: `server/index.ts`, `server/app.ts`, `server/provider-registration-routes.ts`에서 예산 wrapper를 걷어내요. 기존 `onAttemptStart`는 전송 전에 attempt를 저장하도록 직접 연결하고, story job 연결의 트랜잭션도 유지해요.
- 보관·진단 정리: 새 요청의 `budgetReservation`과 예산 전용 메타데이터·archive 검증을 제거해요. request/response·성공/실패/취소·실제 token usage 기록은 유지하고, 공급자가 실제 금액을 제공하지 않으면 `costUsd=null`을 유지해요.
- 검증·문서 정리: 예산 전용 테스트는 제거하고 함께 묶였던 attempt 기록·중복 방지·보관 검사는 독립 검증으로 남겨요. `scripts/verify-live.mjs`와 관련 시험 도구의 제거된 모듈·환경변수 의존성, 개발/배포 안내도 정리해요. 과거 시험 결과의 당시 한도·측정값은 역사적 기록으로 보존해요.
- 범위 구분: 요청당 최대 출력 토큰·timeout·도구 반복 한도와 취소·중복 실행 방지·인증/origin 검증은 각각 실행 계약이므로 유지해요. 제거하는 것은 같은 DB의 누적 유료 호출 횟수와 추정 지출로 실행을 차단하는 기능이에요.

완료 기준은 예산 환경변수가 없어도 지원 모델의 합성 요청이 실행되고, 과거 누적 기록이나 고정 가격 만료일이 다음 요청을 막지 않으며, 전송 전 attempt 저장·usage·원문 귀속은 보존되는 것이에요. 실제 API 실행을 통한 검증은 이번 계획 범위가 아니에요.

## 6. 코드 구조

거대한 범용 provider framework 대신, 기존 encoder를 유지하며 작은 지원 명세와 공통 생성 옵션 추출기를 추가해요.

1. **지원 명세**: provider identity/transport + 정확한 model ID, API 출시일·지원 상태, 허용 필드/값/상한·조합, 지원 tier, 근거 URL·확인일·명세 revision을 보관해요. Google의 location은 global 고정이에요. 같은 명세를 UI·서버 저장·실행 검증에서 사용해요. 유사 모델은 검증된 profile을 공유할 수 있지만 새로운 suffix를 자동 허용하지 않아요.
2. **공급자별 생성 옵션**: `ModelGeneration`의 공통 출력 한도와 공급자별 typed options를 구분해요. Google Thinking Level, OpenAI Reasoning/Verbosity, Anthropic Output Effort는 각각 이름과 타입을 가지며 공통 effort 필드의 우연한 재사용을 없애요. 코드로 표현 가능한 작은 union이면 충분해요.
3. **실제 공급자와 protocol 구분**: 임의 Responses 호환 URL에 `gpt-*`를 입력했다고 공식 OpenAI 모델 지원을 보증하지 않아요. 공식 직접 연결·gateway·별도 호환 연결의 출처를 구분해요. protocol은 요청 문법만 결정해요.
4. **공통 추출·검증**: `server/main-request.ts:68`, `product-auxiliary.ts:144`, `story-runner.ts:143`, `provider-registration-agent.ts:68`의 수동 옵션 복사를 하나의 함수로 모아요. main/translation/status/image/state/memory와 모델 등록 보조가 같은 규칙을 사용해요.
5. **실행 동결**: 모델 revision의 생성 옵션과 선택한 지원 명세 revision을 Run/job에 고정해요. 매 요청의 실제 적용 옵션·location/tier는 attempt 진단에 남겨요. 실행 중 프리셋 편집이나 카탈로그 갱신이 진행 중인 Run을 바꾸지 않아요. 인증·enabled·허용 origin은 기존대로 최신 권한을 재검사해요.
6. **host의 명시적 조정**: 평가 도구의 첫 case 절약 모드는 기존 opt-in 계약을 유지하되 지원값으로 검증해요. `server/evaluation-session.ts:17`과 `core/transport.ts:102`의 generation binding 비교도 새 구조를 따라요. 설정값과 실제 적용값을 구분하고 일반 provider 오류를 이유로 값을 자동 낮추지 않아요.
7. **다른 입구도 동일 검증**: 모델 등록 보조의 proposal schema/apply, archive export/import, 복제·수정, snapshot, preview에 동일 계약을 적용해요. 모델 목록 API는 ID 발견용이며 완전한 파라미터 명세라고 취급하지 않아요.
8. **기존 기능 판정 통합**: `core/provider-messages.ts:9`의 모델 ID별 cache·메시지 기능 판정도 필요한 범위에서 같은 명세를 참조해요. 메시지 순서·도구 ID·opaque 내용은 재작성하지 않아요.

저장 형식이 바뀌면 schema/archive를 함께 새 버전으로 올려요. 정식 배포 전 프로젝트 방침에 따라 구버전 자동 이관·호환 UI·자동 백업을 만들지 않아요. 실제 개발 DB 초기화는 구현 시 별도 명시 동작이고 이번 계획에서 실행하지 않아요. 현재 실행의 snapshot·취소·중복 처리 계약은 계속 보존해요.

## 7. Vercel·별도 호환 연결·Codex

Vercel은 **gateway → 모델 제공사 → API 형식**을 함께 고려해야 해요. 현재 Uimori는 `vercel-chat-v1`을 `core/openai-chat-protocol.ts`로 보내며 직접 OpenAI의 의미를 모두 보장할 수 없어요.

- 직접 연결 3종을 먼저 완성하고 Vercel 전용 작업 단계를 둬요. 기존 연결을 유지하되 새로운 native 옵션을 무조건 전달하지 않아요.
- 지원은 **선택 모델의 native 기능 ∩ Vercel 해당 API의 전달 기능 ∩ Uimori 구현**으로 정해요. 생성 옵션과 gateway의 routing/fallback/BYOK는 다른 설정이에요.
- AI SDK의 `providerOptions` 예시를 현재 raw Chat JSON에 그대로 복사하지 않아요. Vercel의 실제 Chat/Responses/Messages endpoint별 요청 schema와 값 우선순위를 따로 검증한 뒤 serializer를 정해요. [Vercel Chat API](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions), [Provider Options](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options)
- 현 플러그인만으로 Vercel의 지원을 확정하지 않아요. 서로 다른 모델·리전·공급자로 자동 바뀌는 routing을 이번 개편의 기본 동작으로 추가하지 않아요. Gateway 자체 fallback을 허용할지와 강제 고정 방법은 Vercel 단계에서 명시해요.
- 별도 OpenAI 호환 연결은 확인한 adapter 옵션만 제공하며 공식 GPT 모델과 같은 보장 목록에 넣지 않아요. 임의 JSON editor를 대체 수단으로 추가하지 않아요.
- Codex는 API 직접 연결과 별개예요. 설치된 app-server의 모델 metadata·지원 effort를 따르며 OpenAI API의 Verbosity·출력 hard limit을 지원한다고 추정하지 않아요. 이번 공통 구조 변경의 회귀 대상으로 포함해요.

## 8. Tokenizer 판단

**사용자에게 tokenizer 선택을 요구하지 않는 안**이에요. 토크나이저는 provider가 텍스트를 생성할 때 바꾸는 API 옵션이 아니에요. 유미의 `RN/NN/KT`는 Risu의 `addProvider`에 tokenizer 메타데이터를 등록하며, Uimori는 같은 호스트 요구가 없어요.

Uimori의 현재 기억 제한은 `core/memory.ts:132`의 JSON 문자 수 기준이고 실제 사용 토큰은 provider usage로 기록해요. 따라서 이번에 숨겨진 정밀 tokenizer가 이미 있다고 가정하거나 문자열 길이를 정확한 토큰 수로 표시하지 않아요.

향후 입력 문맥 자르기·토큰 수 미리보기에 필요하면 내부 `TokenCounter`를 따로 설계해요. 모델별 자동 추정, 공급자의 count API, 최종 usage를 구별해요. 도구 schema·메시지 구조·이미지는 로컬 plain-text tokenizer만으로 정확히 계산하기 어려워요. count API는 본문을 외부로 보내므로 설정 화면을 열기만 해도 호출하지 않아요. [OpenAI 토큰 계수 가이드](https://developers.openai.com/api/docs/guides/token-counting)

## 9. 유미 프로바이더에서 참고할 것

파일: `C:/Users/wodus/ai-workspace/RisuToki/risu/plugins/provider-manager-v1.16.2.js`, 1,016,732 bytes, SHA-256 `FD5F599BD19BFE66837EA558FC717D907C890E6F4BCB5D16207059FA7B81B7A8`. 메타데이터 1–7행 뒤의 번들이 8행에 축소돼 있어요. 파일은 ignored이므로 RisuToki HEAD의 추적 소스라고 표시하지 않아요.

| 심볼·위치 | 참고하는 원리 | Uimori의 적용·검증 |
| --- | --- | --- |
| 8행 `uv` / `Um` | Responses와 Chat의 reasoning·verbosity 필드 차이 | 기존 encoder를 분리 유지하고 저장 옵션→실제 body를 비교해요. |
| 8행 `vp` / `Zp` | Claude effort/Thinking과 Gemini Thinking 분리 | 공급자별 typed options와 허용 조합 검증을 사용해요. |
| 8행 `Kt`, 플랫폼/format switch | 인증·플랫폼과 API 형식 분리 | 프로젝트·인증과 모델 생성 옵션을 분리해요. Uimori의 Google 연결은 global만 유지해요. |
| 8행 `yv/bv/kv/xv` | 모델에 맞는 옵션 UI | 지원 명세를 UI·저장·wire에서 공유해요. |
| 8행 `RN/NN/KT` | tokenizer와 Risu host 모델 등록 | API 생성 옵션과 내부 토큰 계수를 구분해요. |

비채택: 구형 모델별 정규식 예외 누적, Gemini minimal→low나 Claude xhigh/max의 조용한 보정, 임의 body/header deep merge, 키 회전·라우터·자동 원격 registry. 이번 파일에서 `vercel`·`providerOptions` 구현은 확인되지 않았어요. 플러그인의 재배포 라이선스를 확인하지 못해 설계 원리만 참고하고 코드는 복사하지 않아요.

## 10. 구현 순서와 완료 기준

| 단계 | 작업 | 완료 기준 |
| --- | --- | --- |
| P0 | 지원 정책·모델 명세 확정 | exact ID, 출시일, 옵션/조합·tier·공식 출처가 표로 고정돼요. API 지원 미확인 항목은 실행 보장 목록에 없어요. 가격표 등록은 요구하지 않아요. |
| P1 | 타입·공통 generation 추출·저장/archive/등록 보조·snapshot 정리 | 한 번 저장한 옵션이 모든 역할의 새 Run/job에 동일하게 들어가고 CAS·기존 실행 불변성이 유지돼요. |
| P2 | Google 이름·모델 선택·Flex·Thinking·기존 예산 제한 제거 | global endpoint·origin과 모델/tier 검증을 유지해요. 예산 설정 없는 요청 실행·전송 전 attempt 기록·usage 보존을 합성 검증해요. |
| P3 | OpenAI·Claude 옵션과 UI 정리 | effort/verbosity/thinking/mode/context/tier 등 명세의 옵션이 실제 body에 전달되고 금지 조합은 전송 전에 거절돼요. |
| P4 | 격리된 앱 회귀·문서 | 저장→재접속→역할 실행→attempt 확인, 390px·데스크톱 UI, preview와 실제 body 일치를 검증해요. |
| P5 | Vercel 전용 전달·routing 계약 | 모델별 gateway 매핑을 별도로 확정하고 해당 endpoint의 합성 wire 검증을 추가해요. 직접 연결 완료와 별도로 결과를 보고해요. |

필수 반례는 OpenAI Verbosity + 번역 JSON schema 동시 유지, GPT-6 Astra의 none 거절, Claude max + Thinking disabled 거절, Gemini 3.8 MINIMAL 거절, global 외 endpoint 거절, API 미지원 모델 차단, 예산 환경변수·단가표 없이 지원 모델 실행, 프리셋/명세 변경 중 실행 불변, archive/등록 보조를 통한 검증 우회 차단, 평가 절약 모드 뒤 원래 옵션 복원이에요. 실패 후 파라미터·모델·tier가 자동으로 바뀌거나 유료 요청이 재생되지 않는지도 확인해요.

검증은 새 DB·포트와 loopback 합성 provider를 사용해요. 변경에 맞는 단위/통합 검사 후 `npm run check`, `npm run build`, `npm run verify:providers`, 공통 runtime 영향에 해당하는 회귀를 실행해요. 최종 범위가 준비되면 `npm run verify:redesign`과 필요한 평가 도구 경로로 통합을 확인하고 같은 검사를 근거 없이 반복하지 않아요. 결과·첫 실패·source/build·cleanup은 기존 `output/` 규칙에 남겨요. 이 계획 단계에는 이러한 검사를 실행하지 않았어요.

실제 계정의 모델 접근·리전 가용성·API 수락·청구·생성 품질은 로컬 PASS와 구분해요. 유료 공급자 시험은 기존 방침대로 사용자가 진행하며, 이번 계획이나 UI 설정 저장이 새 live 실행 승인을 뜻하지 않아요.
