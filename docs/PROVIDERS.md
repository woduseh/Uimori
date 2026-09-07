# 공급자 연결과 합성 시험

[시작하기](../README.md) · [사용 안내](USAGE.md)

앱에 구현된 연결·제약을 설명하는 문서예요. 실제 계정·모델별 호환성은 [현재 검증 범위](../project-plan/CURRENT.md)를 확인해요.

개인 ChatGPT 구독을 사용하는 Codex는 **설정 → 에이전트**에서 공식 로그인을 준비한 뒤 **연결과 모델**에 저장해요. 본문·모든 보조 역할·모델 등록 요청에서 선택할 수 있어요. 준비 상태 조회는 Codex 프로세스의 로그인 메타데이터를 읽으며 모델을 호출하지 않아요. 서버 설치·Docker 선택 옵션과 실행 한계는 [Codex 연결](CODEX.md)을 확인하세요.

## 등록과 관리

설정 → 연결과 모델은 **모델 프리셋**과 **연결 관리** 목록으로 나뉘어요. **빠른 연결 시작**에서 제공자 카드 → 연결 정보 → 모델 선택 순서로 등록해요. 목록을 떠나면 편집 화면 하나만 표시하고, 목록으로 돌아가도 초안은 **편집 이어서**에서 복원해요. 다른 항목으로 초안을 교체할 때는 확인해요. 모델 편집은 **기본 정보 / 생성 설정 / 고급 옵션**으로 나뉘며, 저장된 카탈로그를 검색해 선택하면 이름·ID를 채워요.  준비 상태는 서버의 허용 주소와 인증 참조 설정 여부만 확인하며, 실제 인증이나 모델 요청을 실행하지 않아요. 모델 목록을 명시적으로 조회하거나 모델 ID를 직접 입력하고, 지원 여부를 확인한 옵션을 저장한 뒤 새 이야기/이야기 설정에서 역할에 배정해요. Vertex는 이 어댑터가 지원하는 고정 로컬 모델만 등록할 수 있어요.

저장 목록에서 연결 이름·주소·모델 ID를 검색하고 수정·복제·비활성화할 수 있어요. 수정은 새 버전을 만들며 기존 이야기와 과거 실행의 모델 버전을 바꾸지 않아요. 연결 비활성화와 주소·인증 참조 변경은 과거 버전을 사용하는 다음 요청도 차단할 수 있어요. 모델 비활성화는 새 선택에서 제외하며 기존 배정은 유지해요. 비활성 연결에 모델을 먼저 저장했다면 연결 활성화 후 모델 편집에서 최신 연결 버전을 선택해 저장하세요.

조회 실패 시 마지막 모델 목록과 수동 ID를 유지해요. 편집 도중 다른 창에서 저장하면 409 충돌을 표시하고 입력을 보존해요. 최신 내용 다시 불러오기는 현재 초안을 교체하는 명시적 동작이에요. 모델 기능은 조회 결과·미확인·사용자 확인값을 구분하고 실제 가격은 추정하지 않아요.

## 에이전트에게 모델 등록 요청하기

이미 저장한 보조 모델을 선택하고 등록 요청을 입력해 **설정안 제안 요청**을 누르세요. 요청 내용과 설정 목록의 이름·ID·프로토콜을 선택한 공급자에 전송해요. 이야기 본문·사용자 연결 주소·인증 참조·키 원문은 모델 문맥에 넣지 않아요. 키는 요청문에도 입력하지 마세요.

최대 한 번·60초 요청으로 새 연결/모델 설정안을 받아 기존 저장 검증을 적용해요. **검토한 연결·모델 등록 적용**을 눌러야 저장하며 새 연결은 비활성으로 생성해요. 활성화·역할 배정은 관리 화면에서 직접 진행해요. 기존 설정을 자동 수정하거나 새 API 코드·플러그인을 설치하는 기능은 없어요. 모델 ID·옵션·가격의 실제 지원을 검증하는 기능도 아니에요.

중단되거나 응답이 불확실한 요청은 자동 재실행하지 않아요. 같은 요청 키는 원래 결과를 반환하며 새로고침 후 상태를 다시 확인할 수 있어요. 등록 보조는 새 설정안을 제안하는 `registration.propose`만 사용하며, 제안할 모델에 평가 도구 옵션이 있더라도 평가 도구를 실행하지 않아요. Vertex 요청은 같은 DB의 기존 예산에 합산하고 보조 요청의 예약은 보수적으로 전액 유지해요. 실제 금액 미확인은 0원으로 바꾸지 않아요.

[공급자 관리 결과·검증과 한계](../project-plan/PROVIDER-MANAGEMENT-RESULTS.md)

## 모델 프리셋의 선택형 평가 도구

평가 도구는 별도 provider가 아니며 기본적으로 꺼져 있어요. **모델 프리셋 편집 → 고급 옵션 → 이 모델 프리셋에 평가 도구 4개 사용**을 켠 프리셋에만 네 도구를 추가해요. 같은 연결의 다른 프리셋에는 영향을 주지 않으며 도구를 지원하지 않는다고 확인한 모델에는 저장할 수 없어요.

도구의 세션·preloaded 흐름·case receipt·terminal content/notice 분리·잘림 복구와 원본 비교는 [선택형 평가 도구](../project-plan/EVALUATION-TOOLS.md)를 확인하세요. 로컬 합성 검증만 수행했으며 실제 계정·모델 지원과 품질·청구는 확인하지 않았어요.

## OpenAI·Anthropic·Vercel·별도 호환 연결

설정 → 연결과 모델에서 공급자를 고르면 공식 API 기본 주소와 권장 환경변수 이름을 채워요. 키 값은 서버에 설정하고 저장한 모델을 메인·번역 역할에 지정하세요. 생성 전 설정 저장 자체는 모델을 호출하지 않아요. `모델 목록 새로고침`은 명시한 서버로 목록 GET을 보내며 실패하면 기존 목록을 유지해요. 목록에 없는 모델 ID도 수동 등록할 수 있어요.

| 연결 | 기본 주소 | 서버 환경변수 예시 | 전송 |
| --- | --- | --- | --- |
| Responses 호환 | `https://api.openai.com/v1` | `OPENAI_API_KEY` | Responses API, `store:false`, native function calls; 허용한 HTTPS/loopback API root 지정 가능 |
| Anthropic | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` | Messages API, `x-api-key`, native tool use |
| Vercel AI Gateway | `https://ai-gateway.vercel.sh/v1` | `VERCEL_API_KEY` | OpenAI Chat Completions, 모델 `공급자/모델` |
| OpenAI 호환 별도 공급자 | 사용자가 지정한 HTTPS API root | `PROVIDER_API_KEY` | Chat Completions; 인증 없는 literal loopback HTTP도 가능 |

`NR_PROVIDER_ORIGINS`에는 사용할 주소의 origin을 쉼표로 구분해 추가해요. 키는 사용자가 선택한 이름의 서버 환경변수에 설정하며, 이름은 영문자 또는 `_`로 시작하는 영문자·숫자·`_` 조합이면 돼요. 특정 접두사는 요구하지 않아요. 키 원문은 브라우저에 붙여 넣지 말고 서버 환경변수를 바꿨다면 서버를 다시 시작하세요. Anthropic과 Vercel 기본 주소는 고정하며 Responses와 Chat 호환 연결은 허용한 HTTPS 또는 literal loopback HTTP API root를 사용할 수 있어요.

모델 프리셋에는 출력 한도·timeout·지원 모델용 reasoning effort/Anthropic thinking 옵션을 저장할 수 있어요. `Temperature`를 비우면 전송하지 않아요. 번역 JSON Schema는 Responses·Messages에서 기본 사용, Chat Completions 연결에서 기본 미사용이며 선택 옵션으로 바꿀 수 있어요. 호환 서버는 SSE, `max_completion_tokens`, 선택한 옵션과 function tools를 지원해야 해요. 미지원 옵션·모델·인증·요금 오류는 그대로 실패 처리하고 다른 모델이나 옵션으로 자동 재요청하지 않아요.

이 네 연결은 로컬 합성 프로토콜·HTTP·앱 검증 대상이며 실제 API 시험은 사용자가 진행해요. `NR_LIVE_MAX_*`는 Vertex 합성 시험 예산이에요. 다른 공급자의 요청·token usage는 저장하지만 USD 단가나 금액 상한을 적용하지 않으며 실제 비용은 미확인으로 남겨요.

## Vertex AI 연결과 합성 시험

Vertex 연결은 `vertex-gemini-v1`, global endpoint, 모델 ID `gemini-3.8-flash`를 지원해요. 기존 합성 시험의 승인 한도는 총 1000회·USD 100이었으며, 아래 값은 그 시험의 설정 예시예요. 품질 실험은 사용자 요청으로 중단됐어요. 새 평가의 자료·모델·호출 수·금액 범위는 별도로 정하고, 승인된 후속 실행은 이전 DB의 사용 기록을 이어서 계산해요. 서비스 계정에 해당 프로젝트의 모델 실행 권한이 필요해요. 서비스 계정 JSON을 UI에서 서버로 등록하거나, 기존 서버 ADC 파일을 사용할 수 있어요. 업로드한 키는 서버의 별도 파일에 보관하며 브라우저 저장소·작품 DB에는 넣지 않아요.

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS = 'C:\보관위치\service-account.json'
$env:NR_PROVIDER_ORIGINS = 'https://aiplatform.googleapis.com'
$env:NR_LIVE_MAX_REQUESTS = '1000'
$env:NR_LIVE_MAX_USD = '100'
$env:NR_VERTEX_REQUEST_TIER = 'flex'
npm run dev
```

1. 설정 → 연결과 모델 → **빠른 연결 시작** → `Vertex AI · Gemini 3.8 Flash`를 선택해요.
2. **Vertex 키 JSON 파일**에 Google Cloud 서비스 계정 파일(64 KiB 이하)을 선택해요. 서버에 등록되면 프로젝트 ID와 global endpoint, 인증 참조를 채워요. 업로드·연결 저장은 OAuth 토큰이나 모델을 요청하지 않아요.
3. 기존 서버 인증을 쓰려면 파일을 선택하지 않고 **Google Cloud 프로젝트 ID**를 입력해요. 환경변수 이름을 비우거나 `GOOGLE_APPLICATION_CREDENTIALS`를 지정하면 그 변수의 ADC 파일을 사용하고, `VERTEX_ACCESS_TOKEN`처럼 다른 이름을 지정하면 해당 서버 변수의 OAuth Bearer token을 사용해요. JSON 등록 후 **서버 ADC / 환경변수 방식으로 변경**은 현재 연결 초안의 인증 방식을 바꾸며 서버 키 파일을 삭제하지 않아요.
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

### 업로드한 Vertex 키 보관

키 파일은 `NR_DB` 파일 옆의 `<DB 파일명>.vertex-credentials/`에 저장돼요. 재시작 후에도 같은 DB 경로와 키 디렉터리가 필요해요. 기본 Compose는 `/data` 볼륨 안에 함께 보관해요. JSON 내보내기와 SQLite 백업에는 키 원문이 포함되지 않으므로 다른 서버로 복원하면 해당 서버에서 키 파일을 다시 등록하고 연결·모델 버전을 선택해 주세요. 키 파일을 수동 이전하는 경우에도 서버의 보호된 위치와 동일한 DB 파일명을 유지해야 해요.

서비스 계정 형식·RSA 키·Google 토큰 주소를 서버가 검사하고, 등록 참조는 해당 프로젝트의 Vertex 연결에서만 사용할 수 있어요. `NR_PROVIDER_ORIGINS`의 Google origin 허용과 기존 요청 예산·접속 권한은 별도로 유지해요. 업로드한 파일은 Git 및 Docker 빌드 입력에서 제외해요. Linux 파일 생성 권한은 디렉터리 0700·파일 0600이며, Windows는 호스트의 파일 접근 권한을 따라요. 실제 Google 인증·모델 응답 검증과 파일 저장 검증은 구분해요.
