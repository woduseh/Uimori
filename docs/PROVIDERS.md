# 공급자 연결과 합성 시험

[시작하기](../README.md) · [사용 안내](USAGE.md) · [모델 파라미터·캐시·응답 테스트](MODEL-PARAMETERS.md)

앱에 구현된 연결·제약을 설명하는 문서예요. 실제 계정·모델별 호환성은 [현재 검증 범위](../project-plan/CURRENT.md)를 확인해요.

일반 실행에서는 각 역할에 모델을 지정해야 해요. 모델 없이 채팅을 만들거나 작성된 도입문을 저장할 수 있지만, 생성·번역 요청을 모의 응답으로 대신 실행하지 않아요. 사용할 모델이 없다면 **설정 → 연결과 모델**에서 연결을 등록해요. 모의 실행과 개발자용 모의 제어는 `NR_TEST_MODE=1`인 로컬 합성 검증 서버에서만 사용할 수 있어요.

개인 ChatGPT 구독을 사용하는 Codex는 **설정 → 에이전트**에서 공식 로그인을 준비한 뒤 **연결과 모델**에 저장해요. 본문·모든 보조 역할에서 선택할 수 있어요. 준비 상태 조회는 Codex 프로세스의 로그인 메타데이터를 읽으며 모델을 호출하지 않아요. 서버 설치·Docker 선택 옵션과 실행 한계는 [Codex 연결](CODEX.md)을 확인하세요.

## 등록과 관리

설정 → 연결과 모델은 **모델 프리셋**과 **연결 관리** 목록으로 나뉘어요. **빠른 연결 시작**에서 제공자 카드 → 연결 정보 → 모델 선택 순서로 등록해요. 목록을 떠나면 편집 화면 하나만 표시하고, 목록으로 돌아가도 초안은 **편집 이어서**에서 복원해요. 다른 항목으로 초안을 교체할 때는 확인해요. 모델 편집은 **기본 / 고급** 두 화면이에요. 기본에는 이름·연결·모델 선택·최대 출력 토큰·사고 강도만 있고 나머지 옵션은 고급에 있어요. 저장된 목록에서 모델을 고르면 이름·ID와 공급자 목록이나 앱 표가 아는 출력 한도를 미리 채워요.  준비 상태는 서버의 허용 주소와 인증 참조 설정 여부만 확인하며, 실제 인증이나 모델 요청을 실행하지 않아요. 모델 목록을 명시적으로 조회하거나 모델 ID를 직접 입력하고, 생성 설정을 저장한 뒤 설정 → 현재 모델에서 앱 전체의 역할에 배정해요. 앱의 모델 힌트 표는 알려진 모델의 옵션 목록을 먼저 보여주는 용도이며 실행 조건이 아니에요. 표에 없는 ID나 값도 그대로 보내고, 공급자가 거절하면 어느 설정이 거절됐는지 실패 턴과 응답 테스트에 표시해요.

저장 목록에서 연결 이름·주소·모델 ID를 검색하고 수정·복제·비활성화할 수 있어요. 수정은 같은 ID의 최신 설정을 갱신하며, 내부 revision은 편집 충돌 확인에만 사용해요. 역할별 모델 ID는 전역 설정에서 선택하고 모든 채팅의 새 실행·작업 예약에는 현재 전역 설정을 읽어요. 채팅별 선택은 없어요. 이미 예약된 작업과 과거 Run은 자기 모델·연결 snapshot을 유지해요. 연결의 활성 여부·주소·인증 참조·origin 권한은 호출마다 최신 상태로 다시 검사해요. 모델 비활성화는 새 선택에서 제외하고 해당 모델로 새 작업을 시작하지 못하게 해요. 전역 선택에는 복구할 대상을 표시하며 과거 snapshot은 보존해요. 연결의 프로토콜을 바꾸면 모델 설정을 검토·저장한 뒤 새 실행을 시작해요.

조회 실패 시 마지막 모델 목록과 수동 ID를 유지해요. 편집 도중 다른 창에서 저장하면 409 충돌을 표시하고 입력을 보존해요. 최신 내용 다시 불러오기는 현재 초안을 교체하는 명시적 동작이에요. 모델 기능은 공급자 목록·앱 확인 힌트·미확인 값을 구분해요. 고급 탭의 요금 설정과 별도 추정 비용은 [모델 요금](MODEL-PRICING.md)을 봐요.

## 새 모델 사용하기

공급자가 새 모델을 내놓으면 앱 코드를 바꾸지 않고 바로 써요. 연결의 **모델 목록 새로고침**으로 ID를 받아오거나 ID를 직접 입력하고, 생성 설정을 저장한 뒤 역할에 배정하면 돼요. 앱의 힌트 표에 없는 모델은 프로토콜이 보낼 수 있는 옵션을 모두 고를 수 있고 지원 여부는 공급자가 판정해요. 옵션이 맞지 않으면 공급자가 생성 전에 400으로 거절하며 과금은 없어요. 그 응답에서 읽은 거절 옵션 이름을 실패 턴 카드·보조 작업 카드·응답 테스트 결과에 표시하고, 공급자 메시지 원문은 저장하거나 보여주지 않아요.

모델을 대신 등록해 주는 에이전트 보조 기능은 2026-09-09에 제거했어요. 이 결정의 근거와 버린 대안은 [모델 등록 결정](MODEL-REGISTRATION.md)에, 과거 구현과 검증 기록은 [공급자 관리 결과·검증과 한계](../project-plan/PROVIDER-MANAGEMENT-RESULTS.md)에 있어요.

## 모델 프리셋의 선택형 평가 도구

평가 도구는 별도 provider가 아니며 기본적으로 꺼져 있어요. **모델 프리셋 편집 → 고급 → 이 모델 프리셋에 평가 도구 4개 사용**을 켠 프리셋에만 네 도구를 추가해요. 같은 연결의 다른 프리셋에는 영향을 주지 않으며 도구를 지원하지 않는다고 확인한 모델에는 저장할 수 없어요.

도구의 세션·preloaded 흐름·case receipt·terminal content/notice 분리·잘림 복구와 원본 비교는 [선택형 평가 도구](../project-plan/EVALUATION-TOOLS.md)를 확인하세요. 로컬 합성 검증만 수행했으며 실제 계정·모델 지원과 품질·청구는 확인하지 않았어요.

## 모델 프리셋의 선택형 문맥 도구

**모델 프리셋 편집 → 고급 → 선택형 문맥 도구**를 켠 프리셋이 본문 역할일 때만 `context.read/write/new`를 추가해요. 본문 모델이 작업 요약을 직접 저장하고 같은 요청 안에서 컨텍스트 창을 넘기는 선택 기능이며 기본은 꺼져 있어요. 평가 도구를 켠 프리셋에서는 사용하지 않아요. 계약·저장·한도 알림·결정 기록은 [입력 문맥의 모델 주도 메모·전환](CONTEXT-LIMITS.md#선택형-모델-주도-메모전환)에 있어요.

## OpenAI·Anthropic·Vercel·별도 호환 연결

설정 → 연결과 모델에서 공급자를 고르면 공식 API 기본 주소와 권장 환경변수 이름을 채워요. 키 값은 서버에 설정하고 저장한 모델을 메인·번역 역할에 지정하세요. 생성 전 설정 저장 자체는 모델을 호출하지 않아요. `모델 목록 새로고침`은 명시한 서버로 목록 GET을 보내며 실패하면 기존 목록을 유지해요. 목록에 없는 모델 ID도 수동 등록할 수 있어요.

| 연결 | 기본 주소 | 서버 환경변수 예시 | 전송 |
| --- | --- | --- | --- |
| Responses 호환 | `https://api.openai.com/v1` | `OPENAI_API_KEY` | Responses API, `store:false`, native function calls; 허용한 HTTPS/loopback API root 지정 가능 |
| Anthropic | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` | Messages API, `x-api-key`, native tool use |
| Vercel AI Gateway | `https://ai-gateway.vercel.sh/v1` | `VERCEL_API_KEY` | OpenAI Chat Completions, 모델 `공급자/모델` |
| OpenAI 호환 별도 공급자 | 사용자가 지정한 HTTPS API root | `PROVIDER_API_KEY` | Chat Completions; 인증 없는 literal loopback HTTP도 가능 |

공식 Gemini global·OpenAI·Anthropic·Vercel 주소는 연결 방식에 맞는 API 기본 주소일 때 기본 허용해요. 별도 `NR_PROVIDER_ORIGINS` 설정이 필요하지 않아요. 사용자 지정 프록시·호환 API·로컬 검사용 주소만 `NR_PROVIDER_ORIGINS`에 origin(경로와 마지막 `/` 제외)을 쉼표로 구분해 추가해요. 이 목록은 공식 주소에 더하는 추가 허용 목록이에요. 연결 편집의 주소 확인 안내는 서버 정책만 조회하며 인증이나 모델 요청을 보내지 않아요. Windows 사용자 환경변수나 서버 실행 설정에 저장하면 매번 입력할 필요가 없어요. 키는 사용자가 선택한 이름의 서버 환경변수에 설정하며, 이름은 영문자 또는 `_`로 시작하는 영문자·숫자·`_` 조합이면 돼요. 특정 접두사는 요구하지 않아요. 키 원문은 브라우저에 붙여 넣지 말고 서버 환경변수를 바꿨다면 서버를 다시 시작하세요. Anthropic과 Vercel 기본 주소는 고정하며 Responses와 Chat 호환 연결은 허용한 HTTPS 또는 literal loopback HTTP API root를 사용할 수 있어요.

생성 옵션은 연결에 속한 **모델 프리셋**에 저장해요. 사고 강도는 프로토콜의 native 필드로 저장하고 어느 요청 필드로 나가는지 선택 아래에 표시해요. Responses는 `reasoning.effort`, Claude는 `output_config.effort`, Gemini는 `generationConfig.thinkingConfig.thinkingLevel`이에요. Vercel과 OpenAI 호환 연결은 Chat Completions의 `reasoning_effort`로 보내며, 게이트웨이나 호환 서버가 모델 공급자의 값으로 변환해요. 모델 공급자의 필드를 직접 지정하려면 그 공급자의 직접 연결을 사용해요. 힌트 표에 있는 모델은 문서로 확인한 값을 먼저 보여주고 나머지 프로토콜 값은 미확인으로 표시해요. 출력 한도·timeout과 sampling·service tier 옵션도 같은 프리셋에 저장해요. 빈 선택은 모델 기본값을 사용하며 명시적 `none`·`disabled`와 구분해요. 프로토콜의 encoder가 보낼 수 없는 옵션만 저장 검증에서 거절하고, 모델별 지원은 공급자 응답으로 확인하며 다른 값으로 조용히 바꾸지 않아요.

번역 JSON Schema는 Responses·Messages에서 기본 사용, Chat Completions 연결에서 기본 미사용이며 선택 옵션으로 바꿀 수 있어요. 호환 서버는 SSE, `max_completion_tokens`, 선택한 옵션과 function tools를 지원해야 해요. Vercel 등 여러 공급자를 연결하는 gateway에는 확인한 공통 옵션만 제공해요. OpenAI의 native 옵션을 다른 공급자 모델에도 전달한다고 보장하지 않아요. 별도 tokenizer 선택은 연결 설정에 필요하지 않으며 provider의 token usage와 실제 비용 미확인 상태를 보존해요.

이 네 연결은 로컬 합성 프로토콜·HTTP·앱 검증 대상이며 실제 API 시험은 사용자가 진행해요. 서버의 누적 호출 수·금액 제한은 제거했어요. 추정 비용은 [모델 요금](MODEL-PRICING.md)의 별도 참고값이에요. 작업별 `maxCalls`, timeout, 최대 출력 토큰 한도는 유지하며 요청 기록과 provider가 보고한 usage를 보존해요. 비용을 보고하지 않는 공급자의 `costUsd`는 `null`로 남겨요.

## Google Agent Platform 연결과 합성 시험

Google Agent Platform은 `vertex-gemini-v1`을 사용하는 **Gemini 계열 전용 연결**이에요. 연결에서 프로젝트·리전·인증을 설정하고 모델 프리셋에서 모델 ID·생성 옵션을 선택해요. Agent Platform에는 파라미터 정보를 주는 모델 목록 API가 없어서 기본으로는 앱의 힌트 표를 목록으로 보여주고, 표에 없는 Gemini ID도 직접 입력해 시도할 수 있어요. 연결에 **Gemini 목록용 API 키 환경변수 이름**을 넣으면 모델 목록 새로고침이 Gemini Developer API의 `models.list`에서 `generateContent`를 지원하는 Gemini 모델과 입력·출력 토큰 한도를 받아와요. 이 키는 목록 조회에만 쓰고 생성 요청에는 쓰지 않으며, 두 API의 모델 ID가 같다는 점에 의존해요. Agent Platform 계정의 실제 가용성은 보증하지 않아요. 서비스 계정에 해당 프로젝트·리전의 모델 실행 권한이 필요해요. 서비스 계정 JSON을 UI에서 서버로 등록하거나 기존 서버 ADC 파일을 사용할 수 있어요. 업로드한 키는 서버의 별도 파일에 보관하며 브라우저 저장소·작품 DB에는 넣지 않아요.

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS = 'C:\보관위치\service-account.json'
$env:NR_VERTEX_REQUEST_TIER = 'flex'
npm run dev
```

1. 설정 → 연결과 모델 → **빠른 연결 시작** → **Google Agent Platform**을 선택해요.
2. 서비스 계정 JSON 파일(64 KiB 이하)을 선택해요. 서버에 등록되면 프로젝트 ID와 인증 참조를 채워요. 현재 Gemini 연결은 `global` endpoint만 지원하며 공식 주소를 기본 허용해요. 업로드·연결 저장은 OAuth 토큰이나 모델을 요청하지 않아요.
3. 기존 서버 인증을 쓰려면 파일을 선택하지 않고 **Google Cloud 프로젝트 ID**를 입력해요. 환경변수 이름을 비우거나 `GOOGLE_APPLICATION_CREDENTIALS`를 지정하면 그 변수의 ADC 파일을 사용하고, `VERTEX_ACCESS_TOKEN`처럼 다른 이름을 지정하면 해당 서버 변수의 OAuth Bearer token을 사용해요. JSON 등록 후 **서버 ADC / 환경변수 방식으로 변경**은 현재 연결 초안의 인증 방식을 바꾸며 서버 키 파일을 삭제하지 않아요.
4. 연결을 지정한 모델 프리셋을 만들어요. 예를 들어 `gemini-3.8-flash`는 문서상 최대 출력 65,536과 Thinking Level LOW·MEDIUM·HIGH를 지원해요. 서비스 티어는 **Standard** 또는 **Flex**를 선택해요. 모델·리전에서 지원하지 않는 조합은 공급자가 거절하며 거절된 옵션 이름을 표시해요. Flex 장문·번역 시험에서는 응답 제한 시간을 900초로 저장했어요.
5. 새 이야기에서 봇 → 페르소나 → 창작 프리셋과 메인·번역 모델을 선택해요. 명시적으로 선택한 모델은 다음 시작에 복원하고, 비활성 연결은 제외해요. 기존 이야기는 이야기 설정에서 역할별 모델을 바꿀 수 있어요. 번역은 번역 모델을 선택한 뒤 원고의 **번역 보기**를 눌러 시작해요. 모델을 선택하지 않은 역할은 실행 전에 선택을 안내해요.

Flex는 `shared`와 `flex` 요청 헤더를 함께 보내고 응답에서 적용 여부를 확인해요. 서버의 `NR_VERTEX_REQUEST_TIER=flex`는 모델 프리셋보다 우선하는 운영 설정이에요. Standard로 자동 전환하거나 429를 자동 재시도하지 않아요. 모델 프리셋의 응답 제한은 최대 1800초까지 설정할 수 있어요. 요청별 HTTP dispatcher가 이 대기 시간을 사용하며 별도의 기본 5분 headers/body 제한에 먼저 끊기지 않아요.

목록 새로고침은 Gemini 목록용 키가 없으면 앱의 힌트 표를 보여주고, 키가 있으면 Gemini Developer API 목록을 받아와요. 어느 쪽도 Agent Platform 인증이나 모델 접근권한을 시험하지 않아요. 설정 저장만으로 모델 요청이 발생하지 않아요. 실제 요청은 매번 최신 연결 권한과 서버 origin 정책을 검사하고, attempt를 DB에 기록한 뒤 시작해요.

과거 합성 시험에 사용한 DB 누적 예산·요청당 예약금·단가 유효기간 차단은 현행 실행 계약에서 제거했어요. `NR_LIVE_MAX_REQUESTS`·`NR_LIVE_MAX_USD`도 사용하지 않아요. 참고용 추정 비용과 실제 청구 비용을 구분하며 보고되지 않은 `costUsd`는 `null`로 보존해요. 과거 시험의 호출 수·추정 금액·FAIL/INCOMPLETE 결과는 당시 기록으로 남아요.

`scripts/verify-live.mjs --preflight`는 모델 요청 없이 설정·최신 빌드 메타데이터만 확인해요. 이전 유료 시나리오는 채팅 프롬프트 참조와 번역 구간·앵커를 전제로 하므로 종료했어요. 환경 준비 여부는 `environmentReady`로 별도 기록하며 preflight/execute 모두 `LIVE_VERIFY_CURRENT_CONTRACT_REVIEW_REQUIRED`와 BLOCKED를 반환해요. 현재 프롬프트·전체 번역·거절 판정 모델을 포함하는 새 live 평가 계획과 실행 승인은 별도 작업이에요.

```powershell
$env:NR_VERTEX_PROJECT = 'PROJECT_ID'
node scripts/verify-live.mjs --preflight
# --execute도 현재는 BLOCKED이며 인증·서버·DB·모델 요청을 시작하지 않아요.
```

사전 검사 결과는 `output/live/`에 남고 DB를 생성하지 않아요. 과거 실행 DB와 결과는 그대로 보존해요. key 파일 본문·Bearer token은 읽거나 진단에 저장하지 않아요.

번역은 전체 원문과 원문 시점의 추가 문맥을 보내고 일반 텍스트를 받아요. 설정한 거절 판정 모델에는 응답 앞 1,000자만 보내요. 명확한 거절만 기본 1회 추가 요청하며 0~5회로 설정해요. 판정 실패·불확실·빈 응답·부분 응답·취소·시간 초과·단절·HTTP 오류는 자동 재시도하지 않아요. 수동 재번역은 현재 모델·프롬프트로 새 작업을 만들며 실패 시 이전 성공 번역을 유지해요. [전체 계약](RUNTIME-SIMPLIFICATION.md)을 봐요.

기존 `scripts/verify-live-retry.mjs`는 실패 구간만 유료 재시도한다는 승인·검증 계약으로 작성됐어요. 현재 전체 장면 재번역을 그 승인으로 실행하지 않도록 preflight/execute 모두 `LIVE_RETRY_FAILED_CHUNK_CONTRACT_RETIRED`와 BLOCKED를 반환해요. DB 본문 열람·복사·인증·모델 호출 전에 멈추며 과거 증거는 유지해요. 전체 장면용 live 검증기 개편과 실행은 이번 범위에 포함하지 않아요.


이전 후보 UI를 대상으로 한 `scripts/verify-live-journey.mjs`는 포크 간략화로 종료했어요. preflight/execute 모두 `LIVE_JOURNEY_LEGACY_CANDIDATE_UI_RETIRED`와 BLOCKED를 반환하며 DB 복사·인증·모델 호출 전에 멈춰요. 기존 실행 증거와 별도의 API 요청/번역 재시도 검증기는 보존해요.

### DeepSeek · OpenAI 호환

`deepseek-chat-v1` 연결은 `https://api.deepseek.com/v1/chat/completions`에 OpenAI Chat Completions JSON/SSE 형식으로 요청해요. 기본 인증 환경변수는 `DEEPSEEK_API_KEY`이고 공식 API root만 허용해요. `deepseek-v4-pro`와 `deepseek-v4-flash`를 로컬 지원 목록에서 선택할 수 있어요. 사용자 연결이나 모델 프리셋을 자동 생성하지 않아요.

출력 한도는 `max_tokens`로 보내요. Reasoning Effort의 `none`은 `thinking.type=disabled`, `low/high/max`는 사고 활성화와 해당 effort로 보내며 기본값은 공급자의 high예요. temperature는 사고를 끈 경우에만 사용해요. 도구 후속 요청에 필요한 `reasoning_content`는 opaque continuation 안에서 보존하며 원문이나 진단 본문에 노출하지 않아요. usage의 input/output token과 `prompt_cache_hit_tokens`를 공급자 보고값으로 기록하고, 별도 추정 비용은 호출 당시 시간대와 고정 단가로 계산해요.

근거(2026-09-09): [모델 명세](https://api-docs.deepseek.com/quick_start/pricing/), [사고·도구 후속 계약](https://api-docs.deepseek.com/guides/thinking_mode/), [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/). 로컬 합성 검사는 요청·응답 계약의 증거이며 실제 인증·계정 가용성·창작 품질은 별도예요.

### 업로드한 Vertex 키 보관

키 파일은 `NR_DB` 파일 옆의 `<DB 파일명>.vertex-credentials/`에 저장돼요. 재시작 후에도 같은 DB 경로와 키 디렉터리가 필요해요. 기본 Compose는 `/data` 볼륨 안에 함께 보관해요. JSON 내보내기와 SQLite 백업에는 키 원문이 포함되지 않으므로 다른 서버로 복원하면 해당 서버에서 키 파일을 다시 등록하고 연결·모델을 선택해 주세요. 키 파일을 수동 이전하는 경우에도 서버의 보호된 위치와 동일한 DB 파일명을 유지해야 해요.

서비스 계정 형식·RSA 키·Google 토큰 주소를 서버가 검사하고, 등록 참조는 해당 프로젝트의 Gemini 연결에서만 사용할 수 있어요. 공식 Google global 주소는 기본 허용하지만 프로젝트·인증 참조·최신 연결 권한 검사는 별도로 유지해요. 업로드한 파일은 Git 및 Docker 빌드 입력에서 제외해요. Linux 파일 생성 권한은 디렉터리 0700·파일 0600이며, Windows는 호스트의 파일 접근 권한을 따라요. 실제 Google 인증·모델 응답 검증과 파일 저장 검증은 구분해요.
