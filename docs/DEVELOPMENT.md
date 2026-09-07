# 개발과 검증

정식 배포 전에는 하위 호환성을 요구하지 않아요. 현재 DB·보관 형식은 **v11**이며 구버전 자료·채팅·백업을 자동 이관하거나 보존용 백업을 만들지 않아요. 개발 DB를 다시 시작하려면 실행 중인 서버를 종료한 뒤 `npm run reset:dev`를 실행해요. 이 명령은 저장소의 `.local/narrative.sqlite`와 해당 SQLite 부속 파일·알려진 구형 자동 백업만 삭제해요. 서버가 DB를 사용 중이거나 경로가 저장소 밖으로 연결되면 중단해요. 다른 검증 산출물과 credential 파일은 대상으로 삼지 않아요.

[시작하기](../README.md) · [검증 계약](../project-plan/VERIFICATION.md)

## 변경과 검증

```powershell
npm run check
npm test
npm run build
npm run verify:ui
npm run verify:evaluation
npm run verify:packages
npm run verify:providers
npm run verify:loading
npm run verify:redesign
npm run verify:selfhost
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

`verify:redesign`은 최신 일치 빌드에서 봇별 채팅·폴더, 패키지 편집·표시, 프롬프트 옵션 조합과 기존 브라우저 회귀를 통합 검사해요. 새 DB·포트와 합성 공급자 등록 fixture를 사용하고 `output/playwright/redesign-<run-id>/`에 reporter·화면·summary를 남겨요. 코드·테스트가 바뀌면 다시 빌드해야 하며, 실제 사용자 자료·유료 호출·기기 검증을 수행하는 명령은 아니에요.

`verify:selfhost`는 새 DB·포트·공개 합성 TLS 인증서로 HTTPS 프록시를 만들고 데스크톱/390px Chromium의 로그인·쿠키·원문 공유·SSE·탭 재진입·세션 해제 후 재로그인을 검사해요. 인증서 오류 무시는 이 검증에만 적용하며 실제 도메인·Linux·Docker·Nginx 실행이나 휴대폰 검증을 대신하지 않아요. `output/playwright/self-host-<run-id>/`에 summary·reporter·화면과 격리 DB 근거를 남겨요. Chromium이 없다면 Playwright의 브라우저를 설치하거나 `NR_BROWSER_PATH`로 지정해요. 서버 배포에는 브라우저 설치가 필요하지 않아요.

`verify`는 doctor → typecheck/build → 새 서버 ready/build/DB identity 확인 → Vitest → Playwright → 실패 감지 selftest → 소유 프로세스 종료/임시 DB 정리를 실행해요. reporter JSON, 커밋 경계 DB 백업, 실제 입력·이벤트, 화면과 `summary.json`은 `output/playwright/<run-id>/`에 남아요. 핵심 검사는 retry 0이고, 필수 skip/0개/누락/실패를 성공으로 바꾸지 않아요. source와 build의 SHA-256은 실행 전후 확인해요. 같은 source의 오래된 다른 서버를 재사용하지 않아요.

`M0`는 F01–F06 회귀와 검증기 selftest를 실행하고, `M1-local`은 P01–P13의 로컬 계약을 검사해요. `--milestone M1`은 같은 로컬 검사 후 미충족 live/device/quality 전제를 포함해 **BLOCKED와 nonzero exit**를 반환해요. M1-local PASS를 M1 전체 완료로 취급하지 않아요.

브라우저가 없거나 권한이 막히면 해당 관찰은 BLOCKED예요. 가능한 서버·자료 조회 검사는 계속 실행해요. Windows sandbox의 `spawn EPERM`은 환경 차단으로 기록하고 필요한 권한에서 동일 명령을 확인해요. 실패 증거는 성공 기록으로 덮어쓰지 않아요.

F01의 두 작업트리 격리는 Git 기준 commit이 준비된 뒤 별도로 확인해요. 각 작업트리에 의존성을 따로 설치하고 빌드한 다음 실행해요.

```powershell
node scripts/verify-worktrees.mjs --a '<준비된 작업트리 A>' --b '<준비된 작업트리 B>'
```

이 명령은 같은 commit/source의 깨끗한 두 작업트리에서 서버와 브라우저를 동시에 실행하고, 독립 포트·파일 DB·profile·temp·원문을 확인한 후 정리해요. 작업트리 생성이나 사용자 파일 삭제는 이 스크립트가 수행하지 않아요.

`verify:evaluation`도 최신 빌드를 먼저 준비해야 해요. `M2-local`은 S01–S07 합성 검사를 실행하며, `--milestone M2`는 로컬 검사가 통과해도 실제 Q04 평가를 수행하지 않으므로 BLOCKED로 종료해요. 지정 자료 이식은 `nativePort: SEPARATE_EVIDENCE`로 구분하며 이 하네스가 이식 완료 여부를 판정하지 않아요.

그 밖의 전용 검증도 최신 소스와 일치하는 빌드를 먼저 준비해요. 변경과 관련된 검사를 선택하고, 위 명령을 매번 전부 실행할 필요는 없어요.

| 명령 | 범위 |
| --- | --- |
| `npm test` | Vitest 단위·통합 검사. 브라우저·실제 공급자 검사를 대신하지 않아요. |
| `npm run verify:packages` | 공통 프롬프트 조립·패키지 요청 예약·원문 구간 편집과 Reader·번역 표시. |
| `npm run verify:providers` | 합성 공급자 등록·모델 선택·관리 화면 |
| `npm run verify:loading` | 합성 자료의 로딩·페이지/SSE 갱신 화면 |

검증 산출물인 `output/`, 사용자 데이터 `.local/`, 빌드 `dist/`는 Git에 포함하지 않아요. 결과 문서의 `output/` 링크는 해당 실행을 보관한 로컬 환경에서만 열려요.

## 코드의 경계

- `web/`: 봇별 탐색·채팅·패키지·프롬프트 편집, 안전한 원고 표시, 탭별 URL/초안/독서 위치, 페이지 읽기·SSE 갱신과 늦은 HTTP 응답 폐기.
- `core/`: 공통 ContentPackage와 역할별 문맥, PromptProgram 데이터 AST·선택형 문법·TypeScript 제작 API, 콘텐츠 가져오기 변환, 공급자 adapter와 상태·기억·원문 회수, 번역·표현 검증. 개발용 지침과 앱 자료는 별개예요.
- `server/`: schema/archive v11, SQLite WAL, revision/idempotency, 봇 소속·폴더, 분기, Run/job/chunk/attempt 수명, 판정 기회·임시 행동 상태, 인증·SSE·현재 형식 백업. DB 트랜잭션은 모델이나 브라우저를 기다리지 않아요.
- `tests/`: 실제 파일 DB/HTTP/프로세스 재시작과 Playwright 브라우저 검사. `scripts/`는 기존 reporter와 작은 수명주기 코드를 연결해요.

원문·Run 완료·적격 보조 예약은 한 트랜잭션에 저장하고 worker는 커밋 뒤에 실행해요. job 결과·완료도 한 트랜잭션이며 source/hash와 worker generation/owner를 검사해요. 재시작은 완료 원문을 다시 생성하지 않아요. 실행 중이던 메인 요청은 `interrupted`로 남고, 로컬 결정적 모의 job만 재개해요. 표시 상태는 다음 원고의 사실로 주입하지 않아요.

조직 테이블은 `chats`와 별도로 보관해요. 채팅 소속 봇은 고정하고 폴더 이동은 CAS로 보호하며 포크는 원래 소속·폴더를 상속해요. 프롬프트의 전역 옵션 조합은 정확한 prompt revision에 연결하고, 생성 당시 Run 입력을 변경하지 않아요. 패키지 행동은 공통 순수 함수로 계산하며 자동·모델 호출의 효과를 원문 완료 때 게시해요. 패키지 상태창·표시 정규식도 저장 원문과 분리해요.

native JSON 가져오기 한도와 검토·저장 절차는 [JSON 가져오기](RISU-IMPORT.md), 에이전트의 원본 조사·native 작성·등록·검증은 [Risu 이식 가이드](RISU-PORTING.md), 프롬프트 작성 방식의 현재 후보와 실행 경계는 [제작 방식 비교](PROMPT-AUTHORING.md)에 있어요. Uimori 앱에는 Risu 원본 업로드·변환 API가 없어요. 외부 에이전트가 작성한 native 결과만 기존 편집기에서 검증·저장해요.

현재 코드/검증 증거와 남은 범위는 [CURRENT](../project-plan/CURRENT.md), [M1 결과](../project-plan/M1-RESULTS.md), 제품 계약은 [계획 시작점](../project-plan/README.md)에 있어요. 서버의 누적 호출 수·금액 제한과 단가 추정은 없으며 작업별 호출·시간·출력 한도와 전송 전 attempt 기록은 유지해요. 실제 모델 호출·배포는 명시적으로 승인된 범위에서 진행해요.
