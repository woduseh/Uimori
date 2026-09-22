# 모델 생성 설정과 응답 테스트

고급 탭의 공식/직접 입력 단가와 호출 후 추정 비용은 [모델 요금](MODEL-PRICING.md)을 봐요. 가격은 모델 실행 지원 여부를 결정하지 않아요.

## 모델 계열과 생성 옵션

프로바이더에는 접속 주소와 앱에서 등록한 API 키를, 모델 프리셋에는 모델 ID와 생성 옵션을 저장해요. **모델 ID는 Uimori의 지원 목록에 있을 필요가 없어요.** 목록과 검토 표는 입력을 돕는 힌트이며 실제 모델 지원 여부는 공급자가 판정해요.

직접 연결은 해당 API의 생성 옵션을 사용해요. Vercel AI Gateway에서는 **모델 계열**을 자동 또는 OpenAI·Anthropic·Google·DeepSeek·xAI로 선택해요. 자동은 `provider/model`의 prefix를 참고하며 모르는 제조사에는 공통 옵션을 보여 줘요. 계열을 반드시 선택해야 저장할 수 있는 제약은 없어요. 수동 선택은 모델 ID를 바꿔도 유지되며, 자동으로 되돌릴 수도 있어요.

계열은 **화면에서 고를 옵션의 묶음**이지 추가 API 허용 목록이 아니에요. 직접 계열이나 프로바이더를 바꾸면 새 경로에서 사용할 수 없는 초안 옵션만 초기화하고 공통 설정은 유지해요. 모델 ID만 바꿀 때는 기존 값을 유지해 사용자가 검토할 수 있어요. 직접 연결의 프로토콜을 다른 제조사 형식으로 바꾸는 기능은 아니에요.

`모델 기본값`은 API 필드를 생략해요. `none`, `disabled`, 숫자 0은 명시값이에요. 저장 시 JSON·숫자 범위와 해당 encoder가 표현할 수 있는 필드를 확인하되, 모델 이름이나 계열을 이유로 보내기 가능한 값을 추가로 차단하지 않아요. 공급자의 실패 응답을 보고 effort를 낮추거나 Flex를 Standard로 자동 변경하지 않아요.

현재 옵션 정의는 [모델 계열](../core/model-family.ts), [프로토콜 정의](../core/provider-definitions.ts), [모델별 힌트와 값 검증](../core/model-capabilities.ts)이 기준이에요. 모델 ID·한도·옵션 목록을 문서에 별도로 복제하지 않아요. 계열의 옵션 목록을 보여주는 것과 특정 모델이 모든 옵션을 지원한다고 확인하는 것은 달라요. 공급자 목록이나 검토 표에서 확인한 값만 확인된 힌트로 표시해요.

### Vercel 추가 옵션

표준 옵션은 Chat 요청 필드나 `providerOptions`로 변환해요. Claude effort/thinking은 `anthropic`, GPT verbosity는 `openai`, Gemini thinking level은 `google`·`vertex` 양쪽에 같은 형태로 전달해요. 실제 적용은 라우팅된 공급자의 지원을 따라요. 계열이 자동이거나 없는 저장 모델도 명시한 생성 옵션은 누락하지 않아요. 제조사와 실제 라우팅 공급자는 다를 수 있으므로 Claude를 Bedrock 등으로 라우팅할 때는 필요에 따라 해당 공급자의 추가 옵션을 지정해요. 계열 선택이 공급자 라우팅을 강제로 고정하지는 않아요.

**고급 → 추가 공급자 옵션 (JSON)**은 라우팅이나 새 공급자 옵션을 직접 지정하는 선택 기능이에요. 같은 namespace의 옵션을 직접 적으면 해당 값이 UI에서 만든 값보다 우선해요. 예를 들어 `anthropic.thinking`을 직접 쓰면 그 객체 전체를 대체하며 임의의 깊은 병합은 하지 않아요. API 키는 프로바이더의 키 입력란에 등록해요.

모델 계열 선택만으로 아직 구현하지 않은 API 필드·캐시 방식·도구 기능이 추가되지는 않아요. 실제 요청의 성공·모델별 조합·청구 결과는 공급자에서 확인해야 해요. 이 경로의 로컬 테스트는 합성 요청 변환과 저장 동작을 검증해요.

### 저장과 실행

모델·프로바이더 편집은 최신 설정 한 벌을 갱신해요. 새 호출은 현재 설정을 읽고 진행 중인 작업과 과거 Run은 자기 snapshot을 유지해요. 내부 revision은 동시 편집 충돌을 확인하기 위한 값이에요. 프로토콜을 바꾸면 모델 설정을 다시 검토·저장해야 해요.

모델 목록은 프로바이더별로 묶고 그룹 안에서 위·아래로 정렬해요. 정렬은 한 요청·한 트랜잭션에서 표시 순서만 변경해요. 모델의 생성 옵션·revision·응답 테스트 결과나 진행 중인 요청은 변경하지 않아요. 검색 중에는 그룹을 펼치고 순서 변경을 잠시 비활성화해요.

입력 컨텍스트 한도와 자동 요약은 [컨텍스트 문서](CONTEXT-LIMITS.md)를 확인해요. 기본 입력 한도 272,000은 로컬 추정 기준이며 출력 토큰 한도와 별개예요.

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
- **Gemini**: 기존 암묵적 캐시는 공급자가 처리해요. 이번 앱에는 `cachedContents` 생성·갱신·삭제 기능이나 프로젝트 전체 암묵적 캐시 제어가 없으므로 OFF·TTL 선택을 제공하지 않아요. Chat/Vercel/호환 프로바이더에도 캐시 지원을 추정하지 않아요.

캐시 포인트는 API 요청상의 경계예요. 최소 길이, 같은 prefix, 공급자 가용성 등의 조건에 따라 실제 재사용 여부가 달라져요. Inspector는 공급자가 보고한 읽기/쓰기 토큰과 Claude의 5분/60분 쓰기 항목을 표시해요. 누락된 usage는 `미확인`이고 설정값에서 hit·절감액을 계산하지 않아요.

유미 프로바이더에서는 메시지 경계의 캐시 표시, TTL의 명시 전달, 연속 대화의 reasoning 보존 원리를 참고했어요. 코드 복사나 모델별 이름 추정·임의 body 병합은 하지 않았어요. 자동 배치는 공급자의 공식 자동 캐싱 계약을 사용해요.

## 응답 테스트

저장한 모델의 **응답 테스트** 버튼은 실제 요청을 한 번 보내요. 이 작업을 구현·검증하는 동안에는 합성 응답만 사용하며, 사용자가 버튼을 눌러야 실제 공급자 요청이 시작돼요.

요청 문구는 **API 연결 테스트 중이니 OK만 답해주세요.**예요. 프리셋에 저장한 생성 옵션을 그대로 보내되 출력 한도 256토큰, 25초 제한, 도구 없음, 재시도 없음으로 실행해요. 캐시 모드를 지원하는 프로토콜에서는 캐시를 끄고, Service Tier와 사고 강도는 프리셋 값을 유지해요. 그래서 테스트 결과는 그 프리셋 옵션에 대한 공급자의 판정이에요. 채팅·작품·프롬프트 자료는 보내지 않아요.

결과에는 실제 텍스트(최대 2,000자), 상태·오류·지연·토큰 usage가 있어요. 공급자가 요청을 거절하면 거절된 옵션 이름과 공급자 코드를 함께 표시해요. 응답이 일부만 왔거나 시간 초과인 경우 완료와 구분해요. 실제 응답을 받았다는 사실이 긴 창작·도구 호출·Flex 가용성·캐시 hit 전체를 보증하지 않아요.

서버는 전송 전에 별도 로컬 진단을 기록해요. 같은 idempotency key는 재전송하지 않고, 같은 모델의 동시 테스트는 하나로 제한해요. 재시작으로 미완료된 테스트는 interrupted로 끝내며 자동 재생하지 않아요. `provider_connection_tests`는 작품 JSON archive에서 제외하고 전체 SQLite 백업에는 포함해요.

## 저장·실행 경계

모델 revision은 생성 옵션을 보관해요. Run/job snapshot은 이를 고정하며, main/translation/status/image/state/context/helper는 공통 추출기로 같은 필드를 전달해요. 호출 시 현재 프로바이더의 활성 상태와 인증을 확인해요. 평가 절약 모드는 명시 opt-in일 때만 출력 한도·effort를 줄이고 나머지 binding을 바꾸지 않아요.

## 공식 근거

- [Google 명칭](https://docs.cloud.google.com/gemini-enterprise-agent-platform/vertex-ai-name-changes), [Gemini 3.8 Flash](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash), [Gemini 3.1 Pro](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-pro)
- [OpenAI GPT-5.6](https://developers.openai.com/api/docs/guides/latest-model/gpt-5.6), [Reasoning](https://developers.openai.com/api/docs/guides/reasoning), [Flex](https://developers.openai.com/api/docs/guides/flex-processing), [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Claude Opus 5](https://platform.claude.com/docs/en/models/opus-5/whats-new-opus-5), [Fable 5.1](https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1), [Effort](https://platform.claude.com/docs/en/build-with-claude/effort), [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

Vercel 요청 변환 참고: [Chat 확장 옵션](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/advanced), [Claude 사고 옵션](https://vercel.com/docs/ai-gateway/models-and-providers/reasoning/anthropic), [Gemini/Vertex 사고 옵션](https://vercel.com/docs/ai-gateway/models-and-providers/reasoning/google).
