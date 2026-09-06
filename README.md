# 여백 · Narrative Runtime M0

모바일에서 원문을 읽는 작은 로컬 창작 하네스예요. React/Vite UI → Fastify HTTP/SSE → 파일 SQLite → 서버 소유 Run → 불변 원문 → 독립 보조 job을 연결했어요. 생성·번역·표시 상태는 모두 명시된 **scripted mock**이에요. 실제 모델·API 키·외부 공개는 연결하지 않았어요.

## Windows에서 실행

Node 24.14 이상 24.x, npm, Chrome 또는 Edge가 필요해요. SQLite는 Node의 `node:sqlite`를 사용하며 별도 SQLite CLI·WSL·Docker는 필요하지 않아요.

```powershell
Set-Location C:\Users\wodus\ai-workspace\ui-ai
npm ci
npm run doctor
npm run dev
```

[로컬 앱 열기](http://127.0.0.1:4310) → 이야기 만들기 → 설정에서 바로 쓰기/로컬 자료 조사 선택 → 원문 생성 순서예요. 두 창이나 탭에서 다른 이야기를 열 수 있어요. 같은 이야기에 대한 동시 명령은 revision 충돌을 표시해요. 원문 아래에는 모의 한국어 고정 문장과 표시용 annotation이 별도로 붙어요. 실행 기록을 펼치면 실제 mock 입력과 tool call/result를 볼 수 있어요.

`dev`는 빌드 후 실행해요. 이미 빌드했다면 `npm start`로 시작해요. Ctrl+C로 자신이 실행한 서버를 종료해요. 기본 DB는 `.local/narrative.sqlite`이고 검증 DB와 달라요. 같은 DB의 두 번째 서버는 복구를 시작하기 전에 거절해요. 포트가 사용 중이면 기존 프로세스를 종료하지 않고 실패해요.

별도 합성 DB와 빈 포트가 필요하면 아래처럼 실행해요. 실제 선택된 URL은 `ready` JSON에 나와요.

```powershell
$env:NR_DB = Join-Path $PWD '.local/demo/story.sqlite'
$env:NR_PORT = '0'
npm start
# 종료 후 이 shell의 override 해제
Remove-Item Env:NR_DB, Env:NR_PORT -ErrorAction SilentlyContinue
```

앱은 `127.0.0.1`에만 바인딩해요. 실제 폰 접속·인증·배포는 M0 범위가 아니에요. 기본 데이터와 입력에는 합성 자료만 사용해 주세요.

## 변경과 검증

```powershell
npm run check
npm run verify -- --milestone M0
npm run verify -- --case F04
npm run verify:selftest
npm run cleanup
npm run cleanup -- --run <summary에 나온 run-id>
```

`verify`는 doctor → typecheck/build → 새 서버 ready/build/DB identity 확인 → Vitest → Playwright → 실패 감지 selftest → 소유 프로세스 종료/임시 DB 정리를 실행해요. reporter JSON, 커밋 경계 DB 백업, 실제 입력·이벤트, 화면과 `summary.json`은 `output/playwright/<run-id>/`에 남아요. 핵심 검사는 retry 0이고, 필수 skip/0개/누락/실패를 성공으로 바꾸지 않아요. source와 build의 SHA-256은 실행 전후 확인해요. 같은 source의 오래된 다른 서버를 재사용하지 않아요.

브라우저가 없거나 권한이 막히면 해당 관찰은 BLOCKED예요. 가능한 서버·자료 조회 검사는 계속 실행해요. 이번 Codex Windows sandbox에서는 일부 자식 프로세스가 `spawn EPERM`으로 막혀, 승인된 로컬 실행으로 동일 명령을 검증했어요. 실패 증거는 성공 기록으로 덮어쓰지 않아요.

F01의 두 작업트리 격리는 Git 기준 commit이 준비된 뒤 별도로 확인해요. 각 작업트리에 의존성을 따로 설치하고 빌드한 다음 실행해요.

```powershell
node scripts/verify-worktrees.mjs --a '<준비된 작업트리 A>' --b '<준비된 작업트리 B>'
```

이 명령은 같은 commit/source의 깨끗한 두 작업트리에서 서버와 브라우저를 동시에 실행하고, 독립 포트·파일 DB·profile·temp·원문을 확인한 후 정리해요. 작업트리 생성이나 사용자 파일 삭제는 이 스크립트가 수행하지 않아요.

## 코드의 경계

- `web/`: 얇은 반응형 읽기 UI, 탭별 URL/초안, SSE 재구독, 늦은 HTTP 응답 폐기.
- `core/`: 작은 타입 계약, 합성 자료와 scripted provider, scoped search/read/skill-load. 개발용 지침과 앱 자료는 별개예요.
- `server/`: schema v1, SQLite WAL, revision/idempotency, Run/job 수명, SSE. 내용 DB의 트랜잭션은 모델이나 브라우저를 기다리지 않아요.
- `tests/`: 실제 파일 DB/HTTP/프로세스 재시작과 Playwright 브라우저 검사. `scripts/`는 기존 reporter와 작은 수명주기 코드를 연결해요.

원문·Run 완료·적격 보조 예약은 한 트랜잭션에 저장하고 worker는 커밋 뒤에 실행해요. job 결과·완료도 한 트랜잭션이며 source/hash와 worker generation/owner를 검사해요. 재시작은 완료 원문을 다시 생성하지 않아요. 실행 중이던 메인 요청은 `interrupted`로 남고, 로컬 결정적 모의 job만 재개해요. 표시 상태는 다음 원고의 사실로 주입하지 않아요.

현재 코드/검증 증거와 남은 범위는 [CURRENT](project-plan/CURRENT.md), 제품 계약은 [계획 시작점](project-plan/README.md)에 있어요. M1이나 유료 호출은 자동 시작하지 않아요.
