# Uimori · Narrative Runtime

긴 원고를 읽고 다음 장면을 이어 쓰는 로컬 창작 앱이에요. 데스크톱과 모바일 너비에서 이야기 탐색, 독립적으로 스크롤되는 원고, 하단 입력창을 사용해요. 콘텐츠와 창작 제어, 역할별 모델 설정, 원문·번역·이미지 표시, 이야기 포크와 백업을 제공해요. **M1 로컬 경로**를 구현했으며, 기본 생성은 scripted mock이며 검증용 `fixture-sse-v1`을 유지해요. M1 후속으로 **Vertex AI global · Gemini 3.8 Flash**의 메인·번역 adapter를 구현했어요. 실제 호출 결과와 남은 전제는 [M1 결과](project-plan/M1-RESULTS.md)에 구분해요. 실제 폰 접속·문학/번역 품질은 별도 검증이에요.

## Windows에서 실행

M2의 상태·장기기억 로컬 경로를 추가했어요. **이야기 설정 → 이야기 상태와 기억**에서 상태 모듈과 보조 모델을 선택하고, 작가 선언·기억·장면 예약을 관리해요. 실제 장기 작품의 의미 품질과 특정 사용자 봇의 native 포팅은 별도 인수 항목이에요. 구현과 검증 범위는 [M2 결과](project-plan/M2-RESULTS.md)에 있어요.

Node 24.14 이상 24.x, npm, Chrome 또는 Edge가 필요해요. SQLite는 Node의 `node:sqlite`를 사용하며 별도 SQLite CLI·WSL·Docker는 필요하지 않아요.

```powershell
Set-Location C:\Users\wodus\ai-workspace\uimori
npm ci
npm run doctor
npm run dev
```

[로컬 앱 열기](http://127.0.0.1:4310) → **새 이야기**에서 봇 선택 → 페르소나와 창작 프리셋 선택 → **이야기 만들기** → 하단에 장면 요청을 적고 보내는 순서예요. 봇이나 페르소나 없이 시작할 수도 있고, 제목을 비워 두면 기본 이름을 사용해요. 시작 설정을 저장한 뒤 첫 요청을 보낼 수 있어요. 모델을 설정하지 않으면 기능 검증용 합성 원문과 모의 번역이 나와요.

- **서재**: 봇·페르소나·로어·작가 설정·창작 스킬·명칭집과 창작 프리셋을 분류별로 검색하고 편집해요. 관련 자료는 이름으로 선택해요. 서재에서 수정해도 기존 이야기에 장착된 버전은 유지돼요.
- **이야기 설정**: 인물·세계와 자료·창작 제어·역할별 모델, 이야기 이미지와 자동 후속 작업을 설정해요. 현재 창작 제어를 새 프리셋으로 저장할 수도 있어요. 입력창의 빠른 선택기로 페르소나·창작 프리셋·본문 모델을 바꿔요. CreativePreset을 적용하면 창작 제어 그룹 전체가 교체되며 모델 연결은 유지돼요.
- **작업 현황**: 원문과 보조 작업의 진행·실패·재시도를 확인해요. 요청별 실행 상세와 전체 역할의 사용량 Inspector에서 실제 입력·도구 결과·호출 수·미확인 비용을 볼 수 있어요.
- **읽기 설정**: 새 원고의 기본 보기 언어, 본문 글꼴·크기와 테마를 정해요. 번역이 없으면 원문을 보여 주며 **번역 보기**를 눌렀을 때 번역을 시작해요. 저장된 번역과 원문 사이의 보기 전환은 모델을 호출하지 않아요. 집중 읽기는 탐색과 입력창을 숨기는 표시 옵션이에요.
- **설정**: 앱 테마와 Enter 보내기, 재사용할 연결·모델 프리셋, 내보내기·복원과 접속 해제를 관리해요. 모바일에서는 탐색 메뉴에서 서재·작업 현황·설정을 열어요.

기본 Enter는 줄바꿈이고 Ctrl/Cmd+Enter로 보내요. 설정에서 Enter 보내기를 선택하면 Shift+Enter로 줄을 바꿔요. 실제 휴대폰 키보드·IME 동작의 검증은 별도예요.

원고의 **여기서 새 이야기로 이어가기**를 누르면 그 장면까지 별도의 이야기로 복사해요. 상단 **이야기 포크**는 현재 전개의 마지막 장면까지 복사해요. 별도 분기 설정이나 확인 창 없이 이야기 목록에 사본이 생기고, 원본과 사본의 이후 설정·프롬프트·초안·생성은 독립적으로 유지돼요. 복사 자체에는 모델 호출이 없어요. 완료된 원문과 완료된 번역·표시 결과를 보존하고, 아직 진행 중이거나 실패한 작업을 복사하거나 재실행하지 않아요. 같은 복사 요청의 응답이 끊겨 다시 눌러도 사본을 중복 생성하지 않아요.

이전 버전에서 만든 분기는 **보관된 전개**의 단순 목록에서 계속 읽을 수 있어요. 보기 전환은 모델을 호출하지 않아요. 번역은 최신 내용 하나만 표시해요. 정상 종료된 거절·빈 응답·구조 손상은 완료 구간을 보존하고 해당 구간만 최대 3회 시도해요. 시간 초과·연결 단절·HTTP 오류처럼 실행이 불확실한 실패는 사용자가 재시도를 눌러요. 다른 이야기를 열거나 화면을 닫아도 서버 작업을 취소하지 않아요.

`dev`는 빌드 후 실행해요. 이미 빌드했다면 `npm start`로 시작해요. **이전 버전 서버를 사용 중이면 그 터미널에서 Ctrl+C 후 `npm run dev`로 다시 시작해요.** 기본 DB는 `.local/narrative.sqlite`이고 검증 DB와 달라요. 기존 schema v1은 `.pre-m1-….sqlite`, v2는 `.pre-v3-….sqlite`, v3는 `.pre-m2-….sqlite` 일관 백업을 같은 디렉터리에 만든 뒤 schema v4까지 업그레이드해요. 이전 자동 번역의 대기·진행 작업은 중단 상태로 보존하며 번역 보기를 눌러 다시 시작해요. 같은 DB의 두 번째 서버는 복구 전에 거절하며, 사용 중인 포트를 비우기 위해 다른 프로세스를 종료하지 않아요.

별도 합성 DB와 빈 포트가 필요하면 아래처럼 실행해요. 실제 선택된 URL은 `ready` JSON에 나와요.

```powershell
$env:NR_DB = Join-Path $PWD '.local/demo/story.sqlite'
$env:NR_PORT = '0'
npm start
# 종료 후 이 shell의 override 해제
Remove-Item Env:NR_DB, Env:NR_PORT -ErrorAction SilentlyContinue
```

앱은 `127.0.0.1`에만 바인딩해요. 선택적으로 서버 환경변수 `NR_ACCESS_TOKEN`을 설정하면 HttpOnly 세션 로그인과 데이터·SSE·이미지 접근 검사를 사용해요. 이는 실제 폰/외부 배포 검증을 대신하지 않아요. 키 원문을 앱 자료나 대화에 넣지 마세요.

**설정 → 연결과 모델**에서 프로토콜을 선택해요. fixture는 `NR_PROVIDER_ORIGINS`에 있는 정확한 origin과 literal loopback HTTP만 허용해요. Vertex는 아래 공식 global 주소만 지원하며, 비밀값은 서버 환경변수/서비스 계정 파일에서 읽어요. 브라우저와 DB에는 credential 환경변수 이름만 저장해요.

**설정 → 내보내기와 복원**에서 JSON 또는 일관된 SQLite 백업을 다운로드해요. JSON 복원은 **새 빈 DB**에서만 가능하고 연결은 비활성화하며 비밀키 참조를 지워요. 원문 hash·분기·참조·파생 결과를 검사하고 잘못된 복원은 전체 rollback해요. SQLite 백업은 서버를 종료한 뒤 새로운 `NR_DB` 파일로 복사해 열 수 있어요. 작은 PNG/JPEG 에셋은 파일당 2,000,000 bytes 이하로 SQLite 안에 함께 보관하므로 별도 에셋 디렉터리 복사가 필요 없어요.

## Sol Responses 연결

**설정 → 연결과 모델 → Sol · Responses**에서 Vercel AI Gateway, LLM Gateway 또는 OpenAI Official을 선택해요. 저장한 모델 프리셋을 본문·번역·상태·기억 역할에 사용할 수 있어요. RisuAI 플러그인을 설치할 필요는 없어요. Sol 문맥 제공 방식·최대 도구 라운드·제출 원고 교정·reasoning 옵션을 모델별로 저장하며, 원고 제출 도구의 안내문은 원문에 합치지 않아요.

서버 credential 참조와 허용 origin을 설정한 뒤 사용해요. [연결 주소·설정과 원본 플러그인과의 차이](project-plan/SOL-RESPONSES.md)를 확인하세요. 로컬 합성 검증만 수행했으며 실제 계정·모델 지원과 품질·청구는 확인하지 않았어요.

## 원문과 번역 직접 수정

원고의 **원문 수정** 또는 **번역 수정**을 눌러 내용을 고치고 저장해요. 직접 저장에는 모델 호출이 없으며 번역 버전 선택은 제공하지 않아요. 원문을 수정하면 기존 번역은 무효화하고, 다음 **번역 보기**에서 수정한 원문을 번역해요. 수정된 원문은 다음 작문 요청의 이력에 반영하며, 이미 실행한 요청의 입력과 기존 후속 원고는 보존해요. M2 상태·기억은 영향을 받은 파생물을 무효로 표시하며, 의미적 재계산은 별도 복구 요청으로 진행해요.

다른 탭에서 먼저 저장했다면 충돌을 표시하고 작성 중인 초안을 유지해요. 새로고침 뒤에도 같은 탭의 편집 초안을 복원하며, 최신 저장 내용을 불러오는 동작은 별도로 선택해요. 편집 전에 시작한 번역이 늦게 끝나도 사용자가 저장한 내용을 덮어쓰지 않아요.

## 이야기 상태와 장기 기억

상태 모듈은 숫자·문자·enum·불리언 필드와 허용 변화 규칙을 정의해요. 보조 모델은 원문 구간을 근거로 제안하고, 앱의 reducer가 필드·근거·범위·중복을 검사한 뒤 값을 계산해요. **authoritative**는 직전 상태가 준비될 때까지 다음 원문 요청을 대기시키고, **continuity**는 원문을 바로 생성하되 상태 계산만 이전 결과를 기다려요. **annotation**은 화면에만 표시해요. 모듈 활성화 시 현재 장면을 초기값의 시작점으로 삼아요.

원문 수정이나 작가 선언 변경으로 무효해진 결과는 과거 기록으로 보존하면서 새 입력에서 제외해요. 상태는 앞 장면부터 **현재 원문에서 상태 다시 확인**, 기억은 **기존 원문 기억 정리**로 복구해요. 상태를 켰던 장면을 수정했다면 해당 장면 복구는 초기값에서 그 장면의 사건을 다시 계산해요. **현재 장면에서 초기값으로 새 기준 적용**은 값을 확인한 뒤 새 상태 기준을 만들며 이전 규칙을 기다리던 요청은 취소해요. 실패·중단된 실제 보조 호출은 자동 재실행하지 않아요.

장기 기억은 작가 선언, 관찰 사건, 요약, 인물 믿음, 가설을 구분해요. 처리한 원문이 연속으로 이어진 지점까지 색인 기준을 만들고, 이후 미처리 원문과 최근 원문을 다음 입력에 보완해요. 오래된 원문은 `story.search/read`, 기억은 `memory.search/read`로 현재 전개 안에서 회수해요. 원문을 삭제하거나 사용자가 수동으로 작품을 복제할 필요는 없어요. 필수 문맥이 설정한 한도를 넘으면 누락시키지 않고 복구·한도 조정을 안내해요.

장면 예약은 원문 저장이 성공했을 때 소비돼요. 상태창과 제한된 정규식 미리보기는 원문을 바꾸지 않으며 HTML 문자열을 실행하지 않아요. 에셋 manifest는 설명·인물·의상·장소를 검색하고 실제 존재하는 조합을 확인해요. 모델 미선택 상태는 합성 규칙으로 동작하며 실제 의미 추출 능력을 뜻하지 않아요.

M2는 schema v4를 사용해요. 기존 DB는 `.pre-m2-….sqlite` 일관 백업 후 상태·기억·예약 테이블을 추가해요. JSON archive v2/v3/v4를 새 빈 DB로 복원할 수 있으며 과거 상태·source hash·의존성과 입력 snapshot을 검증해요. 사용자 DB는 자동 검사에 사용하지 않아요.

```powershell
npm run verify -- --milestone M2-local
# 같은 로컬 검사 후 외부 품질/실제 봇 전제가 없으면 BLOCKED
npm run verify -- --milestone M2
```

## 작문·번역 프롬프트 직접 편집

**이야기 설정 → 프롬프트**에서 작문과 번역 지침을 각각 선택해요. 기본 지침의 전체 내용을 불러와 고치거나, 빈 지침부터 작성하거나, UTF-8 `.txt`/`.md` 파일을 열어 저장할 수 있어요. **서재 → 프롬프트**에서도 재사용할 지침을 관리해요. 저장한 지침은 기본 본문을 완전히 교체하며, 빈 문자열을 저장한 경우도 기본 지침으로 되돌리지 않아요. 기본 사용은 별도로 선택해요.

선택·저장에는 모델 호출이 없어요. 작문은 다음 새 요청부터 적용하고, 이미 실행한 요청과 복사된 과거 원고는 당시 버전을 유지해요. 번역 보기를 눌러 새 번역을 시작하면 그때의 번역 지침과 모델 선택을 고정해요. 이미 저장된 번역은 선택만 바꿔도 재생성하지 않아요. 실패 구간 재시도는 기존 작업의 지침과 완료 구간을 보존해요. 프롬프트를 수정해도 이미 생성된 원문·번역은 바뀌지 않아요.

이 편집기는 지침 텍스트를 그대로 전달해요. 봇·페르소나·자료·창작 제어와 도구는 별도 문맥으로 전달하고, 결과를 저장하기 위한 JSON·원문 식별자·anchor·보호구문 검증은 앱이 유지해요. RisuAI CBS 매크로나 `.risup` 구성은 해석하지 않아요. 기본 모의 모델은 사용자 지침을 이해하는 실제 모델이 아니므로, 내용 반영을 확인하려면 역할별 실제 모델을 연결해요.

## Vertex AI 연결과 합성 시험

Vertex 연결은 `vertex-gemini-v1`, global endpoint, 모델 ID `gemini-3.8-flash`를 지원해요. 이번 합성 테스트 승인은 기존 20회를 포함한 총 1000회·USD 100이며 후속 검증은 이전 DB의 사용 기록을 이어서 계산해요. 서비스 계정에 해당 프로젝트의 모델 실행 권한이 필요해요. 키 파일은 저장소·브라우저·작품 자료에 복사하지 않고 서버가 읽을 수 있는 위치에 둬요.

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

## 변경과 검증

```powershell
npm run check
npm run build
npm run verify:ui
npm run verify -- --milestone M0
npm run verify -- --milestone M1-local
npm run verify -- --milestone M1-local --case P07,P08
npm run verify -- --case F04
npm run verify:selftest
npm run cleanup
npm run cleanup -- --run <summary에 나온 run-id>
```

`check`는 TypeScript 타입 검사이고, `build`는 실행 파일과 빌드 식별 정보를 만들어요. `verify:ui`는 **현재 소스와 일치하는 최신 빌드가 이미 있어야 실행**되며 스스로 빌드하지 않아요. 별도 파일 DB·포트에서 안전한 원고 렌더링 단위 검사와 UI 브라우저 검사를 실행하고 소스·빌드 동일성, 새 reporter의 필수 검사·skip·실패, 소유 프로세스와 임시 파일 정리를 확인해요. 보고서와 화면은 `output/playwright/ui-<run-id>/`에 남아요. 이 명령은 M0/M1-local 회귀, 별도의 시각적 검토·성능 측정·실제 기기 검증을 대체하지 않아요.

`verify`는 doctor → typecheck/build → 새 서버 ready/build/DB identity 확인 → Vitest → Playwright → 실패 감지 selftest → 소유 프로세스 종료/임시 DB 정리를 실행해요. reporter JSON, 커밋 경계 DB 백업, 실제 입력·이벤트, 화면과 `summary.json`은 `output/playwright/<run-id>/`에 남아요. 핵심 검사는 retry 0이고, 필수 skip/0개/누락/실패를 성공으로 바꾸지 않아요. source와 build의 SHA-256은 실행 전후 확인해요. 같은 source의 오래된 다른 서버를 재사용하지 않아요.

`M0`는 F01–F06 회귀와 검증기 selftest를 실행하고, `M1-local`은 P01–P13의 로컬 계약을 검사해요. `--milestone M1`은 같은 로컬 검사 후 미충족 live/device/quality 전제를 포함해 **BLOCKED와 nonzero exit**를 반환해요. M1-local PASS를 M1 전체 완료로 취급하지 않아요.

브라우저가 없거나 권한이 막히면 해당 관찰은 BLOCKED예요. 가능한 서버·자료 조회 검사는 계속 실행해요. 이번 Codex Windows sandbox에서는 일부 자식 프로세스가 `spawn EPERM`으로 막혀, 승인된 로컬 실행으로 동일 명령을 검증했어요. 실패 증거는 성공 기록으로 덮어쓰지 않아요.

F01의 두 작업트리 격리는 Git 기준 commit이 준비된 뒤 별도로 확인해요. 각 작업트리에 의존성을 따로 설치하고 빌드한 다음 실행해요.

```powershell
node scripts/verify-worktrees.mjs --a '<준비된 작업트리 A>' --b '<준비된 작업트리 B>'
```

이 명령은 같은 commit/source의 깨끗한 두 작업트리에서 서버와 브라우저를 동시에 실행하고, 독립 포트·파일 DB·profile·temp·원문을 확인한 후 정리해요. 작업트리 생성이나 사용자 파일 삭제는 이 스크립트가 수행하지 않아요.

## 코드의 경계

- `web/`: 이야기 셸·서재·설정·작업 패널, 안전한 원고 표시, 탭별 URL/초안/독서 위치, SSE 재구독과 갱신 묶음 처리, 늦은 HTTP 응답 폐기.
- `core/`: 창작 제어·콘텐츠 타입, 역할별 context/읽기 도구, 실제 fetch/SSE의 fixture·Vertex adapter, 번역 보호구문·anchor·표현 검증. 개발용 지침과 앱 자료는 별개예요.
- `server/`: schema v2, SQLite WAL, revision/idempotency, 분기, Run/job/chunk/attempt 수명, 인증·SSE·백업. DB 트랜잭션은 모델이나 브라우저를 기다리지 않아요.
- `tests/`: 실제 파일 DB/HTTP/프로세스 재시작과 Playwright 브라우저 검사. `scripts/`는 기존 reporter와 작은 수명주기 코드를 연결해요.

원문·Run 완료·적격 보조 예약은 한 트랜잭션에 저장하고 worker는 커밋 뒤에 실행해요. job 결과·완료도 한 트랜잭션이며 source/hash와 worker generation/owner를 검사해요. 재시작은 완료 원문을 다시 생성하지 않아요. 실행 중이던 메인 요청은 `interrupted`로 남고, 로컬 결정적 모의 job만 재개해요. 표시 상태는 다음 원고의 사실로 주입하지 않아요.

현재 코드/검증 증거와 남은 범위는 [CURRENT](project-plan/CURRENT.md), [M1 결과](project-plan/M1-RESULTS.md), 제품 계약은 [계획 시작점](project-plan/README.md)에 있어요. 실제 모델 호출·배포는 승인된 연결과 예산 범위가 정해진 뒤 진행해요.


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

이번처럼 사용자가 기존 전체 한도를 늘린 후, 닫힌 이전 시험의 실패 구간을 이어서 검사할 때만 승인한 총합을 명시해요. 새 DB로 사용 기록을 초기화하지 않아요.

```powershell
node scripts/verify-live-retry.mjs --source 'output/live/닫힌-이전-시험' --job '번역-job-ID' --approved-max-requests 1000 --approved-max-usd 100 --preflight
# 같은 옵션에 --preflight 대신 --execute를 지정하면 실패 구간을 명시적으로 재시도해요.
```


이전 후보 UI를 대상으로 한 `scripts/verify-live-journey.mjs`는 포크 간략화로 종료했어요. preflight/execute 모두 `LIVE_JOURNEY_LEGACY_CANDIDATE_UI_RETIRED`와 BLOCKED를 반환하며 DB 복사·인증·모델 호출 전에 멈춰요. 기존 실행 증거와 별도의 API 요청/번역 재시도 검증기는 보존해요.
