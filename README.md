# 여백 · Narrative Runtime

모바일 너비에서 원문을 읽는 로컬 창작 앱이에요. 콘텐츠와 창작 제어, 역할별 모델 설정, 원문·번역·이미지 표시, 후보 분기와 백업을 제공해요. **M1 로컬 경로**를 구현했으며, 기본 생성은 scripted mock이고 연결 프로토콜은 검증용 `fixture-sse-v1`이에요. 실제 provider와 모델은 아직 선택되지 않았고 유료 호출·실제 폰 접속·문학/번역 품질은 검증하지 않았어요.

## Windows에서 실행

Node 24.14 이상 24.x, npm, Chrome 또는 Edge가 필요해요. SQLite는 Node의 `node:sqlite`를 사용하며 별도 SQLite CLI·WSL·Docker는 필요하지 않아요.

```powershell
Set-Location C:\Users\wodus\ai-workspace\ui-ai
npm ci
npm run doctor
npm run dev
```

[로컬 앱 열기](http://127.0.0.1:4310) → 이야기 만들기 → 자료실에서 bot/persona/lore/canon/용어집 등록 → 창작 제어에서 revision 장착·저장 → 원문 생성 순서예요. CreativePreset을 적용하면 제어 그룹 전체가 교체돼요. 모델을 설정하지 않으면 기능 검증용 합성 원문과 모의 번역이 나와요.

원문과 번역을 전환하고, 원문에서 새 분기를 만들거나 같은 요청의 다른 후보를 생성할 수 있어요. 후보는 원래 실행의 설정과 입력을 재사용해요. 분기·초안·독서 위치는 탭별로 보관하며 서버의 분기 head와 구분해요. 번역 실패는 완료 구간을 보존하며 실패 구간만 재시도해요. 실행·보조 작업·총 사용량 Inspector에서 실제 입력, 도구 결과, 역할별 호출과 미확인 비용을 확인해요.

`dev`는 빌드 후 실행해요. 이미 빌드했다면 `npm start`로 시작해요. **기존 M0 서버를 사용 중이면 그 터미널에서 Ctrl+C 후 `npm run dev`로 다시 시작해요.** 기본 DB는 `.local/narrative.sqlite`이고 검증 DB와 달라요. 데이터가 있는 schema v1은 첫 재실행 때 같은 디렉터리에 `.pre-m1-….sqlite` 일관 백업을 만든 뒤 schema v2로 업그레이드해요. 같은 DB의 두 번째 서버는 복구 전에 거절하며, 사용 중인 포트를 비우기 위해 다른 프로세스를 종료하지 않아요.

별도 합성 DB와 빈 포트가 필요하면 아래처럼 실행해요. 실제 선택된 URL은 `ready` JSON에 나와요.

```powershell
$env:NR_DB = Join-Path $PWD '.local/demo/story.sqlite'
$env:NR_PORT = '0'
npm start
# 종료 후 이 shell의 override 해제
Remove-Item Env:NR_DB, Env:NR_PORT -ErrorAction SilentlyContinue
```

앱은 `127.0.0.1`에만 바인딩해요. 선택적으로 서버 환경변수 `NR_ACCESS_TOKEN`을 설정하면 HttpOnly 세션 로그인과 데이터·SSE·이미지 접근 검사를 사용해요. 이는 실제 폰/외부 배포 검증을 대신하지 않아요. 키 원문을 앱 자료나 대화에 넣지 마세요.

연결 화면은 비밀키 대신 `NARRATIVE_PROVIDER_…` 형태의 서버 환경변수 이름을 저장해요. 현재 fixture 호출은 `NR_PROVIDER_ORIGINS`의 쉼표로 구분한 정확한 origin과 literal loopback HTTP만 허용해요. provider/model/예산 선택 후 실서비스 프로토콜을 추가할 예정이며, 이 설정만으로 실제 OpenAI/Anthropic API가 연결되는 것은 아니에요.

내보내기에서 JSON 또는 일관된 SQLite 백업을 다운로드해요. JSON 복원은 **새 빈 DB**에서만 가능하고 연결은 비활성화하며 비밀키 참조를 지워요. 원문 hash·분기·참조·파생 결과를 검사하고 잘못된 복원은 전체 rollback해요. SQLite 백업은 서버를 종료한 뒤 새로운 `NR_DB` 파일로 복사해 열 수 있어요. 작은 PNG/JPEG 에셋은 파일당 2,000,000 bytes 이하로 SQLite 안에 함께 보관하므로 별도 에셋 디렉터리 복사가 필요 없어요.

## 변경과 검증

```powershell
npm run check
npm run verify -- --milestone M0
npm run verify -- --milestone M1-local
npm run verify -- --milestone M1-local --case P07,P08
npm run verify -- --case F04
npm run verify:selftest
npm run cleanup
npm run cleanup -- --run <summary에 나온 run-id>
```

`verify`는 doctor → typecheck/build → 새 서버 ready/build/DB identity 확인 → Vitest → Playwright → 실패 감지 selftest → 소유 프로세스 종료/임시 DB 정리를 실행해요. reporter JSON, 커밋 경계 DB 백업, 실제 입력·이벤트, 화면과 `summary.json`은 `output/playwright/<run-id>/`에 남아요. 핵심 검사는 retry 0이고, 필수 skip/0개/누락/실패를 성공으로 바꾸지 않아요. source와 build의 SHA-256은 실행 전후 확인해요. 같은 source의 오래된 다른 서버를 재사용하지 않아요.

`M0`는 F01–F06 회귀와 검증기 selftest를 실행하고, `M1-local`은 P01–P13의 로컬 계약을 검사해요. `--milestone M1`은 같은 로컬 검사 후 미충족 live/device/quality 전제를 포함해 **BLOCKED와 nonzero exit**를 반환해요. M1-local PASS를 M1 전체 완료로 취급하지 않아요.

브라우저가 없거나 권한이 막히면 해당 관찰은 BLOCKED예요. 가능한 서버·자료 조회 검사는 계속 실행해요. 이번 Codex Windows sandbox에서는 일부 자식 프로세스가 `spawn EPERM`으로 막혀, 승인된 로컬 실행으로 동일 명령을 검증했어요. 실패 증거는 성공 기록으로 덮어쓰지 않아요.

F01의 두 작업트리 격리는 Git 기준 commit이 준비된 뒤 별도로 확인해요. 각 작업트리에 의존성을 따로 설치하고 빌드한 다음 실행해요.

```powershell
node scripts/verify-worktrees.mjs --a '<준비된 작업트리 A>' --b '<준비된 작업트리 B>'
```

이 명령은 같은 commit/source의 깨끗한 두 작업트리에서 서버와 브라우저를 동시에 실행하고, 독립 포트·파일 DB·profile·temp·원문을 확인한 후 정리해요. 작업트리 생성이나 사용자 파일 삭제는 이 스크립트가 수행하지 않아요.

## 코드의 경계

- `web/`: 얇은 반응형 읽기 UI, 탭별 URL/초안, SSE 재구독, 늦은 HTTP 응답 폐기.
- `core/`: 창작 제어·콘텐츠 타입, 역할별 context/읽기 도구, 실제 fetch/SSE fixture adapter, 번역 보호구문·anchor·표현 검증. 개발용 지침과 앱 자료는 별개예요.
- `server/`: schema v2, SQLite WAL, revision/idempotency, 분기, Run/job/chunk/attempt 수명, 인증·SSE·백업. DB 트랜잭션은 모델이나 브라우저를 기다리지 않아요.
- `tests/`: 실제 파일 DB/HTTP/프로세스 재시작과 Playwright 브라우저 검사. `scripts/`는 기존 reporter와 작은 수명주기 코드를 연결해요.

원문·Run 완료·적격 보조 예약은 한 트랜잭션에 저장하고 worker는 커밋 뒤에 실행해요. job 결과·완료도 한 트랜잭션이며 source/hash와 worker generation/owner를 검사해요. 재시작은 완료 원문을 다시 생성하지 않아요. 실행 중이던 메인 요청은 `interrupted`로 남고, 로컬 결정적 모의 job만 재개해요. 표시 상태는 다음 원고의 사실로 주입하지 않아요.

현재 코드/검증 증거와 남은 범위는 [CURRENT](project-plan/CURRENT.md), [M1 결과](project-plan/M1-RESULTS.md), 제품 계약은 [계획 시작점](project-plan/README.md)에 있어요. 실제 모델 호출·배포는 승인된 연결과 예산 범위가 정해진 뒤 진행해요.
