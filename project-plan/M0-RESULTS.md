# M0 실행 결과 · 2026-09-06

M0의 작은 실제 앱과 검증 루프를 구현·실행했어요. 시작 폴더 `claude-code`는 소스 스냅샷이고 요청된 문서는 `ui-ai/project-plan`에 있었어요. `ui-ai`의 기존 내용은 계획 문서뿐이어서 새 앱을 이곳에 만들었어요. 기존 `claude-code` 작업 트리는 전후 모두 clean이고 변경하지 않았어요. 과거 대화나 첨부 원문을 가정하지 않았어요.

## 코드와 환경

- 제품 코드 commit: `d0b47cf18346567b36798fa7cc0e760d58e2f696` (`codex/m0-runtime`). 이후 인수인계 변경은 문서와 ACCEPTANCE의 실행 결과 필드뿐이에요. 기존 로컬 Git 신원을 사용했고 전역 설정/remote/push를 변경하지 않았어요.
- source/build ID: `bb367129c575cd92c505b72d277ac29660460a301a63e3d5ac3ba247a2eb0640`.
- compiled dist SHA-256: `1ce148c51e813abe76841a6a2b2439e2c3b403541cc7629c60a1994dae08ec85`.
- Windows 11 `10.0.26200`, PowerShell, Node `24.14.0`, npm `11.14.1`, SQLite `3.51.2`, Chrome `152.0.7977.82`; browser viewport `390×844`. Node 내장 SQLite는 experimental 경고를 출력해요.
- TypeScript/React/Vite/Node/Fastify, 파일 SQLite WAL schema v1. 의존성 버전은 `package-lock.json`에 고정됐어요. 별도 SQLite CLI, WSL, Docker, bash를 사용하지 않았어요.
- 적용 지침을 확인했고 프로젝트에 기존 AGENTS/override/skill은 없었어요. Playwright 스킬을 브라우저 검증에 사용했어요. 앱의 창작 skill fixture는 개발용 지침과 분리돼요.

## F01–F06 관찰과 증거

최종 본 작업 트리와 깨끗한 checkout 양쪽에서 **Vitest 13개, Playwright 3개 PASS; skip 0, retry 0**이에요. 실패 감지 selftest는 별도의 11개 의도적 실패를 모두 감지했어요. 이를 제품 테스트 11개 PASS로 합산하지 않아요.

| ID | 실제 관찰 |
|---|---|
| F01 | 파일 SQLite transaction rollback/재열기, localhost와 Chrome 접근 PASS. 같은 commit의 한글·공백 경로 작업트리 A/B에서 별도 의존성을 설치했어요. 동시 포트 55089/55091, DB/profile/temp와 원문 ID가 분리됐고 종료 후 각각 source 1개가 남았어요. 전후 Git clean, 소유 서버·임시 runtime·작업트리 정리 PASS. |
| F02 | 두 독립 browser context와 동일 context의 두 탭에서 다른 chat/preset 실행. 중복 key는 같은 Run, 다른 명령/오래된 head/settings는 409. 실행 중 설정 변경에도 기존 입력은 calm snapshot을 유지했어요. |
| F03 | 탭 종료 뒤 서버 완료, 재접속 시 같은 Run/source 확인. durable SSE ID 재전송 확인. 중단된 메인은 interrupted이며 자동 재생성하지 않았어요. 오류는 원문이 아니고 원문 없는 실패로 남아요. 역순 실제 HTTP 응답이 최신 원고를 덮지 않는 회귀 검사도 PASS. |
| F04 | direct는 메인 1회, research는 실제 DB 자료 search/read/skill-load 결과를 다음 mock 입력에 전달했어요. 계약/목록/본문은 분리됐고 prefetch는 비어 있어도 조회 가능해요. 다른 chat의 목록/건수/본문, skill 권한 확대, 예산 초과와 취소를 검사했어요. |
| F05 | 원문/Run 완료/job 예약의 중간 실패는 함께 rollback. 커밋 직후 exit86 당시 source1/completed Run1/queued job2/result0/input1. 재시작 뒤 원문/hash/input1을 그대로 유지하고 job2만 완료했어요. 지연/역순/보조 실패/재시도/중복 완료/후속 source·다른 화면 이동에도 원래 source에만 붙어요. |
| F06 | assertion failure, zero, required skip, missing/stale report, stale server, timeout, cleanup failure, browser missing, unknown case/milestone을 실제 child로 감지했어요. 모두 inner exit1이며 outer selftest PASS. 원래 오류와 cleanup 오류를 함께 보존해요. 알려진 합성 secret canary scan, code/build identity, 소유 runtime 정리도 PASS. |

실행기에서 F01 doctor/단일 실행 결과와 두 checkout 격리는 별도 증거로 남겨요. 이번 M0 판단에는 아래 세 결과를 함께 사용했어요.

- [최종 통합 summary](../output/playwright/2026-09-06T11-40-31-609Z-0c7f1c0e/summary.json): `vitest.json`, `playwright.json`, `selftest/selftest.json`, 로그, `evidence-db/` 포함.
- [커밋 경계 관찰](../output/playwright/2026-09-06T11-40-31-609Z-0c7f1c0e/evidence/commit-boundary-restart.json) / 같은 디렉터리 `commit-boundary.sqlite` 일관된 백업.
- [깨끗한 checkout의 동일 verify](../output/playwright/clean-checkout-2026-09-06T11-43-17-360Z-38d62924/summary.json): 작업트리 삭제 전에 증거 전체를 이 경로로 복사했어요. JSON 내부 실행 cwd는 실제 과거 작업트리 경로를 유지해요.
- [두 작업트리 동시 격리](../output/playwright/worktrees-2026-09-06T11-43-42-817Z-7dcc0fa7/summary.json): 각 화면과 종료 후 DB 보존.
- [실제 dev 명령](../output/playwright/dev-command.json): `npm run dev` ready/HTML 200, Ctrl+C 이후 server PID 종료/port 닫힘/합성 demo DB 정리. Ctrl+C의 shell exit1은 의도적 종료예요.

## 실제 사용한 주요 명령

PowerShell에서 실행했어요. npm 설치는 프로젝트 내부이며 Git 신원·전역 설정은 발명하지 않았어요.

```powershell
git status --short
node --version
npm --version
npm ping --fetch-retries=0 --fetch-timeout=15000
npm install --save-exact fastify @fastify/static react react-dom
npm install --save-dev --save-exact typescript @types/node @types/react @types/react-dom vite @vitejs/plugin-react vitest @playwright/test
npm run check
npm run build
node scripts/doctor.mjs
node scripts/selftest.mjs
npm run verify -- --milestone M0
npm run cleanup -- --run 2026-09-06T11-40-31-609Z-0c7f1c0e
git worktree add --detach '.local/checkouts/검증 A' HEAD
git worktree add --detach '.local/checkouts/검증 B' HEAD
# 각각의 작업트리에서
npm ci --offline --no-audit --no-fund
# A에서 동일 verify, B에서 build
npm run verify -- --milestone M0
npm run build
# 본 프로젝트에서 두 작업트리 동시 검증
node scripts/verify-worktrees.mjs --a '.local/checkouts/검증 A' --b '.local/checkouts/검증 B'
# 증거 복사, clean/절대 경로 확인 후 자신이 만든 두 작업트리만 제거
git worktree remove '.local/checkouts/검증 A'
git worktree remove '.local/checkouts/검증 B'
$env:NR_DB = Join-Path $PWD '.local/demo-check/story.sqlite'
$env:NR_PORT = '4310'
npm run dev
# Ctrl+C, 소유 PID 종료/포트 닫힘 확인 뒤 해당 합성 demo 디렉터리만 정리
```

매일 실행은 root [README](../README.md)의 `npm ci` → `npm run doctor` → `npm run dev` 안내를 사용해요. 검증 증거는 Git에서 제외한 `output/playwright/`에 보존돼요. 모든 검증/데모 서버와 생성한 두 작업트리는 종료·정리됐어요.

## 실패와 한계

최초 sandbox에서는 npm registry 연결이 `127.0.0.1:9 ECONNREFUSED`, 브라우저/Vite 자식 프로세스는 `spawn EPERM`, Git staging은 `.git/index.lock Permission denied`였어요. 승인된 로컬 실행으로 같은 준비·검증·로컬 Git 작업을 수행해 해결했어요. doctor의 원래 BLOCKED 기록은 보존돼요. 제품 필수 검사에 남은 FAIL/BLOCKED는 없어요.

독립 검토에서 DB 중복 소유, 늦은 UI 응답, 실패한 모델 호출 수, loopback Host, assertion false oracle, timeout과 cleanup/junction 경계를 고쳤고 최종 코드에서 검증했어요. cleanup 오류를 유발하는 격리 child 결과와 실제 Windows junction 거절 probe도 남겼어요.

이 결과는 scripted mock 하네스의 소프트웨어/Windows 브라우저 검증이에요. 모의 번역은 **한국어 고정 합성 문장**이며 원문 의미 번역이 아니에요. 자발적 모델 검색·실제 API/protocol 호환·번역/상태 의미 품질·실제 폰·정전 내구성은 증명하지 않아요. 유료 호출, 공개 배포, 장기기억 전체, 실제 이미지 선택, 원본 봇 실행 호환과 M1은 실행하지 않았어요. M0에서 마무리해요.
