# 개발과 검증

[시작하기](../README.md) · [검증 계약](../project-plan/VERIFICATION.md)

## 변경과 검증

```powershell
npm run check
npm run build
npm run verify:ui
npm run verify:sol
npm run verify -- --milestone M0
npm run verify -- --milestone M1-local
npm run verify -- --milestone M2-local
npm run verify -- --milestone M1-local --case P07,P08
npm run verify -- --case F04
npm run verify:selftest
npm run cleanup
npm run cleanup -- --run <summary에 나온 run-id>
```

`check`는 TypeScript 타입 검사이고, `build`는 실행 파일과 빌드 식별 정보를 만들어요. `verify:ui`는 **현재 소스와 일치하는 최신 빌드가 이미 있어야 실행**되며 스스로 빌드하지 않아요. 별도 파일 DB·포트에서 안전한 원고 렌더링 단위 검사와 UI 브라우저 검사를 실행하고 소스·빌드 동일성, 새 reporter의 필수 검사·skip·실패, 소유 프로세스와 임시 파일 정리를 확인해요. 보고서와 화면은 `output/playwright/ui-<run-id>/`에 남아요. 이 명령은 M0/M1-local 회귀, 별도의 시각적 검토·성능 측정·실제 기기 검증을 대체하지 않아요.

`verify`는 doctor → typecheck/build → 새 서버 ready/build/DB identity 확인 → Vitest → Playwright → 실패 감지 selftest → 소유 프로세스 종료/임시 DB 정리를 실행해요. reporter JSON, 커밋 경계 DB 백업, 실제 입력·이벤트, 화면과 `summary.json`은 `output/playwright/<run-id>/`에 남아요. 핵심 검사는 retry 0이고, 필수 skip/0개/누락/실패를 성공으로 바꾸지 않아요. source와 build의 SHA-256은 실행 전후 확인해요. 같은 source의 오래된 다른 서버를 재사용하지 않아요.

`M0`는 F01–F06 회귀와 검증기 selftest를 실행하고, `M1-local`은 P01–P13의 로컬 계약을 검사해요. `--milestone M1`은 같은 로컬 검사 후 미충족 live/device/quality 전제를 포함해 **BLOCKED와 nonzero exit**를 반환해요. M1-local PASS를 M1 전체 완료로 취급하지 않아요.

브라우저가 없거나 권한이 막히면 해당 관찰은 BLOCKED예요. 가능한 서버·자료 조회 검사는 계속 실행해요. Windows sandbox의 `spawn EPERM`은 환경 차단으로 기록하고 필요한 권한에서 동일 명령을 확인해요. 실패 증거는 성공 기록으로 덮어쓰지 않아요.

F01의 두 작업트리 격리는 Git 기준 commit이 준비된 뒤 별도로 확인해요. 각 작업트리에 의존성을 따로 설치하고 빌드한 다음 실행해요.

```powershell
node scripts/verify-worktrees.mjs --a '<준비된 작업트리 A>' --b '<준비된 작업트리 B>'
```

이 명령은 같은 commit/source의 깨끗한 두 작업트리에서 서버와 브라우저를 동시에 실행하고, 독립 포트·파일 DB·profile·temp·원문을 확인한 후 정리해요. 작업트리 생성이나 사용자 파일 삭제는 이 스크립트가 수행하지 않아요.

`verify:sol`도 최신 빌드를 먼저 준비해야 해요. `M2-local`은 S01–S07 합성 검사를 실행하며, `--milestone M2`는 Q04·지정 봇 포팅 전제가 남으면 BLOCKED로 종료해요.

검증 산출물인 `output/`, 사용자 데이터 `.local/`, 빌드 `dist/`는 Git에 포함하지 않아요. 결과 문서의 `output/` 링크는 해당 실행을 보관한 로컬 환경에서만 열려요.

## 코드의 경계

- `web/`: 이야기 셸·서재·설정·작업 패널, 안전한 원고 표시, 탭별 URL/초안/독서 위치, SSE 재구독과 갱신 묶음 처리, 늦은 HTTP 응답 폐기.
- `core/`: 창작 제어·콘텐츠 타입, 역할별 context/읽기 도구, fixture·Vertex·Responses·Messages·Chat adapter와 상태·기억·원문 회수, 번역 보호구문·anchor·표현 검증. 개발용 지침과 앱 자료는 별개예요.
- `server/`: schema v4, SQLite WAL, revision/idempotency, 분기, Run/job/chunk/attempt 수명, 인증·SSE·백업. DB 트랜잭션은 모델이나 브라우저를 기다리지 않아요.
- `tests/`: 실제 파일 DB/HTTP/프로세스 재시작과 Playwright 브라우저 검사. `scripts/`는 기존 reporter와 작은 수명주기 코드를 연결해요.

원문·Run 완료·적격 보조 예약은 한 트랜잭션에 저장하고 worker는 커밋 뒤에 실행해요. job 결과·완료도 한 트랜잭션이며 source/hash와 worker generation/owner를 검사해요. 재시작은 완료 원문을 다시 생성하지 않아요. 실행 중이던 메인 요청은 `interrupted`로 남고, 로컬 결정적 모의 job만 재개해요. 표시 상태는 다음 원고의 사실로 주입하지 않아요.

현재 코드/검증 증거와 남은 범위는 [CURRENT](../project-plan/CURRENT.md), [M1 결과](../project-plan/M1-RESULTS.md), 제품 계약은 [계획 시작점](../project-plan/README.md)에 있어요. 실제 모델 호출·배포는 승인된 연결과 예산 범위가 정해진 뒤 진행해요.
