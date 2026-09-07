# 공급자 연결과 합성 시험

[시작하기](../README.md) · [사용 안내](USAGE.md)

앱에 구현된 연결·제약을 설명하는 문서예요. 실제 계정·모델별 호환성은 [현재 검증 범위](../project-plan/CURRENT.md)를 확인해요.

## Sol Responses 연결

**설정 → 연결과 모델 → Sol · Responses**에서 Vercel AI Gateway, LLM Gateway 또는 OpenAI Official을 선택해요. 저장한 모델 프리셋을 본문·번역·상태·기억 역할에 사용할 수 있어요. RisuAI 플러그인을 설치할 필요는 없어요. Sol 문맥 제공 방식·최대 도구 라운드·제출 원고 교정·reasoning 옵션을 모델별로 저장하며, 원고 제출 도구의 안내문은 원문에 합치지 않아요.

서버 credential 참조와 허용 origin을 설정한 뒤 사용해요. [연결 주소·설정과 원본 플러그인과의 차이](../project-plan/SOL-RESPONSES.md)를 확인하세요. 로컬 합성 검증만 수행했으며 실제 계정·모델 지원과 품질·청구는 확인하지 않았어요.

## OpenAI·Anthropic·Vercel·별도 호환 연결

설정 → 연결과 모델에서 공급자를 고르면 공식 API 기본 주소와 권장 환경변수 이름을 채워요. 키 값은 서버에 설정하고 저장한 모델을 메인·번역 역할에 지정하세요. 생성 전 설정 저장 자체는 모델을 호출하지 않아요. `모델 목록 새로고침`은 명시한 서버로 목록 GET을 보내며 실패하면 기존 목록을 유지해요. 목록에 없는 모델 ID도 수동 등록할 수 있어요.

| 연결 | 기본 주소 | 서버 환경변수 예시 | 전송 |
| --- | --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `NARRATIVE_PROVIDER_OPENAI` | Responses API, `store:false`, native function calls |
| Anthropic | `https://api.anthropic.com/v1` | `NARRATIVE_PROVIDER_ANTHROPIC` | Messages API, `x-api-key`, native tool use |
| Vercel AI Gateway | `https://ai-gateway.vercel.sh/v1` | `NARRATIVE_PROVIDER_VERCEL` | OpenAI Chat Completions, 모델 `공급자/모델` |
| OpenAI 호환 별도 공급자 | 사용자가 지정한 HTTPS API root | `NARRATIVE_PROVIDER_CUSTOM` | Chat Completions; 인증 없는 literal loopback HTTP도 가능 |

`NR_PROVIDER_ORIGINS`에는 사용할 주소의 origin을 쉼표로 구분해 추가해요. 키는 각 `NARRATIVE_PROVIDER_…` 서버 변수에 설정하며 브라우저에 붙여 넣지 않아요. 서버 환경변수를 바꿨다면 서버를 다시 시작하세요. 공식 세 연결의 기본 주소는 고정이며 별도 게이트웨이는 호환 연결을 사용해요.

모델 프리셋에는 출력 한도·timeout·지원 모델용 reasoning effort/Anthropic thinking 옵션을 저장할 수 있어요. `Temperature`를 비우면 전송하지 않아요. 번역 JSON Schema는 Responses·Messages에서 기본 사용, Chat Completions 연결에서 기본 미사용이며 선택 옵션으로 바꿀 수 있어요. 호환 서버는 SSE, `max_completion_tokens`, 선택한 옵션과 function tools를 지원해야 해요. 미지원 옵션·모델·인증·요금 오류는 그대로 실패 처리하고 다른 모델이나 옵션으로 자동 재요청하지 않아요.

이 네 연결은 로컬 합성 프로토콜·HTTP·앱 검증 대상이며 실제 API 시험은 사용자가 진행해요. `NR_LIVE_MAX_*`는 Vertex 합성 시험 예산이에요. 다른 공급자의 요청·token usage는 저장하지만 USD 단가나 금액 상한을 적용하지 않으며 실제 비용은 미확인으로 남겨요.

## Vertex AI 연결과 합성 시험

Vertex 연결은 `vertex-gemini-v1`, global endpoint, 모델 ID `gemini-3.8-flash`를 지원해요. 기존 합성 시험의 승인 한도는 총 1000회·USD 100이었으며, 아래 값은 그 시험의 설정 예시예요. 품질 실험은 사용자 요청으로 중단됐어요. 새 평가의 자료·모델·호출 수·금액 범위는 별도로 정하고, 승인된 후속 실행은 이전 DB의 사용 기록을 이어서 계산해요. 서비스 계정에 해당 프로젝트의 모델 실행 권한이 필요해요. 키 파일은 저장소·브라우저·작품 자료에 복사하지 않고 서버가 읽을 수 있는 위치에 둬요.

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS = 'C:\보관위치\service-account.json'
$env:NR_PROVIDER_ORIGINS = 'https://aiplatform.googleapis.com'
$env:NR_LIVE_MAX_REQUESTS = '1000'
$env:NR_LIVE_MAX_USD = '100'
$env:NR_VERTEX_REQUEST_TIER = 'flex'
npm run dev
```

1. 설정 → 연결과 모델 → `Vertex AI · Gemini 3.8 Flash`를 선택해요.
2. endpoint에 `https://aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/global/publishers/google/models`를 입력하고 `이 연결 사용`을 켜요. 모델 이름과 `:streamGenerateContent`는 붙이지 않아요.
3. 서버 환경변수 이름을 비우면 `GOOGLE_APPLICATION_CREDENTIALS` 서비스 계정 파일을 사용해요. 선택적으로 `NARRATIVE_PROVIDER_VERTEX_TOKEN` 같은 환경변수 이름을 지정하면 그 서버 변수의 OAuth Bearer token을 사용해요. 이 입력란은 API key나 JSON 키 내용을 받지 않아요.
4. 연결을 지정한 모델 프리셋을 만들어요. ID는 `gemini-3.8-flash`, 최대 출력은 65,536 이하, 기본 thinking은 `MEDIUM`, timeout은 300초예요. Flex 장문·번역 시험에서는 응답 제한 시간을 900초로 저장했어요. Gemini 3.8이 무시하는 Temperature/topP/topK는 보내지 않아요.
5. 새 이야기에서 봇 → 페르소나 → 창작 프리셋과 메인·번역 모델을 선택해요. 명시적으로 선택한 모델은 다음 시작에 복원하고, 비활성 연결은 제외해요. 기존 이야기는 이야기 설정에서 역할별 모델을 바꿀 수 있어요. 번역은 원고의 **번역 보기**를 눌러 시작하며 연결하지 않은 역할은 검사용 모의 경로예요.

Flex는 `shared`와 `flex` 요청 헤더를 함께 보내고 응답에서 적용 여부를 확인해요. 서버의 `NR_VERTEX_REQUEST_TIER=flex`는 저장된 연결보다 우선해요. Standard로 자동 전환하거나 429를 자동 재시도하지 않아요. 모델 프리셋의 응답 제한은 최대 1800초까지 설정할 수 있어요. 요청별 HTTP dispatcher가 이 대기 시간을 사용하며 별도의 기본 5분 headers/body 제한에 먼저 끊기지 않아요.

`로컬 지원 모델 확인`은 앱의 지원 목록 확인이며 공급자 인증·모델 접근권한을 시험하지 않아요. 설정 저장만으로 모델 요청이 발생하지 않아요. 실제 요청은 매번 최신 연결 권한과 서버 origin 정책을 검사하고, attempt를 DB에 기록한 뒤 시작해요.

요청·금액 한도는 **같은 DB의 전체 Vertex attempt**에 적용돼요. 메인·도구 왕복·번역 구간·후보·명시적 재시도·서버 재시작을 모두 합산해요. 한도 환경변수가 없거나 한쪽만 있으면 실제 모델 실행이 차단돼요. 새 DB는 별도 한도를 가지므로 여러 DB/다른 클라이언트의 프로젝트 전체 지출을 제한하는 기능은 아니에요.

금액은 Google 청구 내역과 다를 수 있어요. 현재 API는 실제 금액을 반환하지 않아 `costUsd=null`로 보존해요. 공개 Standard 단가 $1.50/$7.50 per 1M input/output를 보수적으로 적용하고, 요청 하나당 모델 전체 입력·출력 한도에 해당하는 **$2.064384**를 먼저 예약해요. 정상 종료와 정합한 usage가 확인된 때만 그 요청을 token 추정치로 낮춰요. Flex 요청 헤더와 응답의 `usageMetadata.trafficType=ON_DEMAND_FLEX`가 함께 확인되면 입력 $0.75/출력 $3.75 per 1M의 gross 단가를 적용해요. 이전 Standard 기록은 원래 단가를 유지해요. 불확실한 취소·단절·잘림·누락 usage에는 전체 예약을 유지해요. 할인·크레딧·환율·세금·다른 클라이언트 지출과 최종 청구액은 확인하지 않으므로 **청구서 총액의 엄격한 상한은 보장하지 않아요**. 2027년부터는 단가 재확인 전 실행을 차단해요. [공식 가격](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing)

합성 live 검증기는 기존 사용자 DB를 사용하지 않아요. `--preflight`는 모델 요청 없이 설정·최신 빌드만 확인하고, `--execute`만 실제 시험을 시작해요. 먼저 명시적인 요청 수/금액 한도를 정해요.

```powershell
$env:NR_VERTEX_PROJECT = 'PROJECT_ID'
node scripts/verify-live.mjs --preflight
# 위 환경변수와 한도 승인을 확인한 뒤에만 실행
node scripts/verify-live.mjs --execute
```

검증기는 `output/live/` 아래 새 DB와 결과를 보존해요. 불확실한 요청을 자동 재호출하지 않으며 live 결과를 fixture 실패 재현과 구분해요. 사용한 key 파일·Bearer token·reasoning/signature 본문은 진단에 저장하지 않아요. 실행 재시도는 새 유료 요청이므로 결과를 읽은 뒤 판단해야 해요.

번역은 native JSON schema와 source identity를 함께 보내고 host가 anchor 순서·보호구문을 재검증해요. 정상 종료가 확인된 거절·빈 응답과 번역 구조 검증 실패는 같은 구간을 최대 3회 시도해요. 작업 전체 호출 한도를 함께 지키며 완료 구간과 모든 attempt 기록을 보존해요. 취소·한도 초과·시간 초과·단절·HTTP 오류는 자동 재시도하지 않아요. 닫힌 합성 시험의 실패 구간만 재시도하려면 다음 검증기를 사용해요.

```powershell
node scripts/verify-live-retry.mjs --source 'output/live/완료된-시험-폴더' --job '번역-job-ID' --preflight
# 실패 구간과 남은 승인 한도를 확인한 뒤 실행
node scripts/verify-live-retry.mjs --source 'output/live/완료된-시험-폴더' --job '번역-job-ID' --execute
```

이 검증기는 원본 DB+WAL을 함께 보존·복사하고 이전 attempt와 완료 구간을 유지해요. `NR_LIVE_MAX_REQUESTS`/`NR_LIVE_MAX_USD`는 원본 시험의 총한도와 같아야 해요. 요청 수를 별도로 추가 승인한 경우에만 총 요청 수 환경변수를 이전 한도+추가 수로 바꾸고 `--additional-requests 추가수`를 함께 지정해요. 이 추가 요청 옵션은 금액 상한을 그대로 유지해요. 두 한도를 새로 승인한 경우에는 아래의 `--approved-max-requests`·`--approved-max-usd`를 함께 지정하며 환경변수만 늘리면 차단해요. 이 옵션과 preflight의 READY는 사용자 승인을 대신하지 않아요.

사용자가 기존 전체 한도를 늘린 후, 닫힌 이전 시험의 실패 구간을 이어서 검사할 때만 승인한 총합을 명시해요. 새 DB로 사용 기록을 초기화하지 않아요.

```powershell
node scripts/verify-live-retry.mjs --source 'output/live/닫힌-이전-시험' --job '번역-job-ID' --approved-max-requests 1000 --approved-max-usd 100 --preflight
# 같은 옵션에 --preflight 대신 --execute를 지정하면 실패 구간을 명시적으로 재시도해요.
```


이전 후보 UI를 대상으로 한 `scripts/verify-live-journey.mjs`는 포크 간략화로 종료했어요. preflight/execute 모두 `LIVE_JOURNEY_LEGACY_CANDIDATE_UI_RETIRED`와 BLOCKED를 반환하며 DB 복사·인증·모델 호출 전에 멈춰요. 기존 실행 증거와 별도의 API 요청/번역 재시도 검증기는 보존해요.
