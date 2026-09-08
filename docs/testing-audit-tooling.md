# 검증 도구 검사 전수 판단

2026-09-08, `codex/simplify-runtime`. 파일 이름만 분류하지 않고 아래 모든 본문·실패 주입·assertion을 읽었어요. 행은 같은 목적의 매개변수 case를 묶어요. KEEP은 서로 다른 실패 경계가 있어 유지한다는 뜻이에요. 실행 결과는 상위 [검사 운영 정리](TESTING-AUDIT.md)에 기록해요.

## Node 실행기: 5개 파일

| 파일 | 전체 case / 계약 묶음 | 판단과 이유 |
| --- | --- | --- |
| `tests/build-runner.node.test.mjs` | complete outputs + matching manifest/logs | KEEP. 실제 파일 승격과 산출물 지문을 함께 검사해요. |
| 같은 파일 | compiler / spawn / missing-output / source-change에서 이전 빌드 보존 | KEEP. 컴파일 실패·환경 차단·불완전 출력·실행 중 변경은 다른 복구 경로예요. |
| 같은 파일 | concurrent owner lock/dist; failed promotion + failed rollback + foreign dist | KEEP. 동시 작업 소유권과 이중 실패 복구는 성공 경로로 대신할 수 없어요. |
| 같은 파일 | test edits vs product edits identity | ADD. 테스트 변경은 재빌드 없이 검증 지문에 반영하고 제품 변경은 빌드 지문도 바뀌는 새 계약이에요. |
| `tests/doctor-caller.node.test.mjs` | browser-only BLOCKED permits API work | KEEP. 진단 도구 자체와 호출자의 계속/중단 결정은 별도 경계예요. |
| 같은 파일 | runtime / child / writable / SQLite / HTTP 각각 blocked / failed / missing | KEEP. 빠진 필수 검사 하나도 성공으로 오인하지 않아요. 조합 생성은 이미 반복 코드 없이 구현돼 있어요. |
| 같은 파일 | diagnostic failure or cleanup failure; unexecuted browser | KEEP. FAIL 우선순위와 미실행을 확정 차단으로 오인하는 문제를 각각 막아요. |
| `tests/worktree-harness.node.test.mjs` | owning bot then chat HTTP setup; rejected admission | KEEP. 실제 HTTP 요청 순서·body와 거절 후 진행 금지를 검사해요. |
| 같은 파일 | retained SQLite expected / wrong-source / wrong-chat / missing | KEEP. 보고서만 믿지 않고 보존 DB의 source/chat 귀속을 확인해요. |
| `scripts/doctor.test.mjs` | supported versions; aggregate status | KEEP. 버전 경계 및 FAIL/BLOCKED/NOT_RUN 우선순위. |
| 같은 파일 | child ready marker / exit / timeout | KEEP. 프로세스 생성만 성공으로 오인하지 않아요. |
| 같은 파일 | blocked child + independent real SQLite/HTTP/cleanup; unsupported runtime + malformed child | KEEP. 개별 probe 결과와 전체 상태가 독립적으로 기록되는 실제 조합이에요. |
| `scripts/memory-evaluation.test.mjs` | deterministic distributed hash-bound corpus at two endpoints | KEEP. 두 끝점은 평가 corpus 크기 경계이고 실제 공급자 평가가 아니에요. |
| 같은 파일 | omissions / contamination / ordering / forged evidence; distinct gold citations vs duplicate citation | KEEP. 종합 점수가 누락시키기 쉬운 서로 다른 오판을 검출해요. |
| 같은 파일 | offline preflight authorization / token scope / budgets | KEEP. 준비 상태를 유료 실행 승인이나 실제 token/cost로 오인하지 않아요. |

Node suite는 기존 30개에서 새 지문 회귀 1개를 더한 31개예요. 검사 수를 줄이기 위해 안전 경계를 지우지 않아요.

## Vitest의 검증 도구 검사: 2개 파일

| 파일 | 전체 case / 계약 묶음 | 판단과 이유 |
| --- | --- | --- |
| `tests/harness.test.ts` | selected command / identity / retained DB / cleanup-compatible ownership | KEEP. 실행기와 cleanup 명령의 실제 연결을 확인해요. |
| 같은 파일 | inherited self-host/Codex env isolation, registration fixture false/true | KEEP. 실제 자식 환경에서 두 origin 경로를 확인해요. |
| 같은 파일 | missing / zero / skipped / retried / global reporter faults | KEEP. 보고서 오판 방지. 서로 다른 reporter 상태예요. |
| 같은 파일 | command / timeout / source failures despite passing assertions | KEEP. assertion 성공만으로 전체 성공을 판정하지 않아요. |
| 같은 파일 | tests changed during verification; functional mode separate identity + no required design PNG | ADD. 재빌드 분리 후에도 실행 중 테스트 변경은 실패하고 기능 모드에서 시각 산출물은 필수가 아니에요. |
| 같은 파일 | missing exact ID vs prefix collision | KEEP. 다른 case가 필수 증거를 대신하는 오류예요. |
| 같은 파일 | primary + cleanup errors persisted; missing browser BLOCKED before launch | KEEP. 원인 보존과 환경 진단 경계예요. |
| 같은 파일 | missing / invalid-signature / truncated / valid PNG | KEEP, 시각 모드에서 실행. 이미지가 있는 척하는 증거 판정을 막으며 실제 시각 품질을 주장하지 않아요. |
| 같은 파일 | actual loopback fixture errors despite passing browser | KEEP. reporter와 fixture 전체 실패 수집은 다른 경계예요. |
| 같은 파일 | cancellation during final scan; listeners released before terminal save | KEEP. 종료 시점의 서로 다른 경합이에요. |
| `tests/quality-architecture.test.ts` | core/server/web forbidden imports and allowed controls | KEEP. 제품 lint와 달리 lint 설정이 잘못되어 규칙이 사라지는 상황을 검사해요. |
| 같은 파일 | nested directories for all three layers | KEEP. 루트만 맞고 하위 override가 빠지는 오판을 잡아요. |
| 같은 파일 | Node builtins/server SDKs/types/dynamic imports vs allowed web controls | KEEP. 브라우저에 서버 모듈이 들어가는 여러 구문을 실제 Biome 설정으로 검사해요. |
| 같은 파일 | tests/scripts allowed to import product and Node helpers | KEEP. 규칙이 검증 코드까지 잘못 막는 문제를 잡아요. |

아키텍처 9개는 약 1초 미만인 작은 검사이고 일반 lint와 목적이 달라요. 실행 명령·설정을 더 늘려 밖으로 옮기는 이익이 작아 전체 Vitest에 유지해요.

## 별도 실행기·설정 검토

- `scripts/selftest.mjs`의 11개 fault: assertion, zero, skip, missing, stale-report, stale-server, timeout, cleanup, browser-missing, unknown-case, unknown-milestone는 KEEP이에요. 실제 CLI/프로세스/신선한 reporter를 사용하는 검증이며 기본 `quality:full`에 추가하지 않아요. mock 기반 `harness.test.ts`의 중복처럼 보여도 실제 runner 시작 실패를 구분하는 계층이 달라요.
- `scripts/test-tooling.mjs`: 자동 발견·파일별 실제 검사·0/skip/todo/취소 거절·실행 전후 지문·최종 기록을 유지해요. `tests/tooling-runner.test.ts`에서 실행기 자체 실패를 검사해요(해당 파일 전수표는 unit n-z에 있어요).
- `vitest.config.ts`: 전체 단위·통합 검사는 유지해요. 파일 이름으로 변경 영향 범위를 추론하는 자동 선택기나 전역 skip을 도입하지 않아요. 개발 중 `npm test -- tests/관련.test.ts`로 범위를 직접 정해요.
- `playwright.config.ts`: 실제 실패의 screenshot/trace는 기본으로 유지해요. 성공 화면의 반복 캡처·추가 폭·정밀 배치만 `NR_VISUAL_REVIEW=1`로 분리해요.
- `scripts/browser-verification.mjs`: 필수 case, reporter 오류, fixture 오류, 취소, cleanup, DB, 비밀 canary 검사는 그대로예요. 성공 PNG 필수 검사는 시각 모드만 적용해요.
- `scripts/lib.mjs`, `build-runner.mjs`, `verify.mjs`, `verify-story.mjs`, `verify-ui.mjs`: 빌드 입력 지문과 전체 검증 입력 지문을 분리해요. 앱·빌드 설정·빌드 실행기는 재빌드를 요구하고 테스트/다른 검증 실행기 수정은 요구하지 않아요. 실행 도중 어느 쪽이 바뀌어도 해당 증거는 실패해요.
- `quality:full`/CI는 완료·통합 검사로 유지해요. 기본 전체 브라우저 실행을 CI에 추가하지 않아요. 작은 `verify:browser-smoke`, 기존 도메인별 `verify:*`, 전체 `verify:redesign`, 별도 `verify:visual`, `benchmark:story`의 용도를 구분해요.
- `scripts/verify-live-retry.mjs`: 이미 무조건 종료하던 가드 뒤의 구간 DB 복사/재시도 구현을 제거했어요. 빈 인자·preflight·execute 모두 source 읽기/복사/인증/요청 없이 같은 퇴역 상태를 반환하는 실제 CLI 검사는 `live-journey.test.ts`에 통합했어요.
- `scripts/verify-live.mjs`: 폐기된 `profile.prompts`, `result.segments`, `job.chunks`를 사용하는 이전 유료 시나리오를 제거했어요. 빌드/설정 파일 존재의 메타데이터 검사와 결과 기록은 유지해요. 환경 준비와 평가 계획 준비를 구분하고 양 모드 모두 새 계약 계획 미완료로 BLOCKED예요. 새 거절 판정 모델을 자동 선택하거나 유료 실행을 시도하지 않아요.
