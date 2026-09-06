# M1 로컬 구현 결과 · 2026-09-06

**M1a/b/c에서 외부 전제에 의존하지 않는 로컬 흐름을 구현했고 P01–P13 로컬 검증이 통과했어요. M1 전체 완료·실서비스 사용 준비 완료는 아니에요.** 사용자 provider/API/model 선택과 시험 예산이 없어 현재 adapter는 자체 loopback `fixture-sse-v1`이에요. 실제 provider, 문학·번역·이미지 선택 품질, 실제 휴대폰 접속은 BLOCKED로 남아요.

## 구현한 동작

- 콘텐츠: bot/persona/lore/author-canon/skill/glossary 편집과 immutable revision 장착. 보관된 revision도 화면에서 확인해요. Native 창작 제어와 CreativePreset 전체 그룹 교체, 비활성 15000 제외, OOC의 소설 작가 지시 범위를 분리했어요.
- 모델 경로: 연결·모델 프리셋·카탈로그·수동 ID와 역할별 main/translation/status/image 선택. HTTP/SSE의 UTF-8·JSON·tool 조각, call ID, opaque 왕복, refusal·usage·EOF·timeout·cancel을 처리해요. 호출 전 최신 연결 권한을 확인하고 진단에는 비밀키나 opaque 본문을 남기지 않아요.
- 읽기: 메인은 고정 계약·작가 사실·목록·도구 결과를 분리해요. 번역은 원문 시점의 bot/persona/canon/용어집을 사용하고 추가 scoped read를 할 수 있어요. 지침을 읽어도 권한이 늘지 않아요.
- 파생물: 번역 chunk의 anchor coverage·순서·중복·보호구문을 검사해요. 완료 구간을 보존하고 실패 구간 하나 또는 미완료 전체를 명시적으로 재시도해요. 재번역은 새 job revision이며 이전 결과를 보존해요. 표시 상태와 이미지 annotation은 원문/정사에 합류하지 않아요.
- 분기: 같은 요청의 후보는 원래 실행 snapshot과 parent를 재사용해요. 각 후보의 후손을 따로 이어가며 branch head는 expected revision을 검사해요. 보기·초안·독서 위치는 탭별로 유지해요.
- 에셋: 기존 소형 PNG/JPEG와 host의 합성 SVG를 profile/inline으로 표시해요. 이미지 역할의 결과는 source/hash/anchor/asset revision/용도/장면 metadata를 검사해요. 적합한 이미지가 없으면 빈 annotation도 정상이에요.
- 보존·접속: schema v1→v2 이전에 populated DB의 일관 백업을 만들어요. JSON export는 새 빈 DB에 복원하며 hash·참조·계보·파생물·보호구문을 검증해요. 원격 연결과 비밀키 참조는 복원 시 해제해요. SQLite 백업은 실제 bytes를 새 파일에 열어 검증했어요. 선택적 단일사용자 HttpOnly 세션은 API·SSE·이미지를 보호하고 로그아웃은 기존 이벤트 연결도 끝내요.
- 사용량: 원문·보조·후보·재시도를 호출별로 기록하고 unknown 비용을 0으로 계산하지 않아요. 중복 완료가 기록된 usage를 덮지 않아요. 불확실한 provider 요청은 자동 재호출하지 않아요.

## 최종 검증

같은 source/build identity에서 다음 두 명령이 통과했어요. Windows 11, Node 24.14.0, npm 11.14.1, Node SQLite 3.51.2, 실제 Chrome을 사용했어요. 검증 DB·포트·브라우저는 전용으로 분리했으며 사용자 `.local/narrative.sqlite`는 열거나 변경하지 않았어요.

| 명령 | 결과 | 증거 |
| --- | --- | --- |
| `npm run verify -- --milestone M0` | F01–F06 PASS; Vitest 13, Playwright 3, 검증기 selftest 11 | `output/playwright/2026-09-06T12-37-13-274Z-9922fc39/summary.json` |
| `npm run verify -- --milestone M1-local` | P01–P13 로컬 PASS; Vitest 38, Playwright 4 | `output/playwright/2026-09-06T12-39-38-385Z-71d8eb1d/summary.json` |

필수 skip/실패 0, source/build 종료 전후 일치, 소유 프로세스·임시 DB 정리 PASS예요. known synthetic secret canary 검사도 PASS이며 임의의 모든 비밀 탐지를 뜻하지 않아요. M0의 두 clean 작업트리 검증은 이전 M0 commit의 증거이고, 이번 M1 변경에서 두 작업트리를 다시 검증했다고 주장하지 않아요.

- source/build ID: `48e7f8e9fa3c13129c1775427996ff64f4c6d6bc22a6de7bea40e4b85d15185f`
- dist SHA-256: `46a6d46866c08c22280d62c7d86da6089fb11be426a0924a2f27f0d81eb8bda3`
- Inspector·wire·usage·source/chunk 기록: 각 실행의 `vitest.json`, `playwright.json`, `evidence-db/` 및 테스트 코드의 독립 assertions
- 모바일 너비 화면: M1 실행의 `browser/product-browser-P09-P10-P1-1766b--separate-image-annotations/m1-mobile-reader.png`

실제 앱 통합 시험은 원문 5700자→번역 세 구간→중간 구간 실패→partial 두 구간 보존→지정 구간만 재시도→세 구간 완료를 통과했어요. 기다리는 동안 용어집을 v2로 수정해도 원래 v1 맥락이 유지됐어요. 원문 1회와 번역 5회(도구 왕복·실패·재시도 포함)의 기록 및 unknown 비용을 확인했어요.

복원 시 입력 archive 변조, 원문 cycle, 다른 채팅의 parent/head/job, 바꿔치기한 snapshot/plan/보호구문, active image MIME을 실제 새 파일 DB에서 거절하고 전체 rollback했어요. 스키마 1의 기존 완료 번역 FK와 백업도 보존했어요. 초기 개발 단계에서 발견한 복원 입력 변조/cycle 실패는 수정 후 통과했으며 원래 실패를 합격 증거로 취급하지 않아요.

## 남은 전제와 한계

| 주장 | 상태와 필요한 정보 |
| --- | --- |
| L01 실제 provider/API | BLOCKED — 메인·번역 provider/API 방식/model ID, 서버 credential, 요청 수·총금액 예산 필요 |
| L02 실제 폰 접속 | BLOCKED — 승인된 비공개 접속 환경과 실제 휴대폰 필요; 현재 서버는 loopback만 바인딩 |
| Q01/Q02/Q03/Q05 | BLOCKED — 선택한 실제 모델과 승인된 표본으로 창작·거절·번역·표현 품질을 따로 평가해야 함 |

소형 이미지의 장면 적합성 검사는 metadata 어휘를 기반으로 해요. 의미 판정·vision을 증명하지 않아요. 원문/번역 anchor coverage도 번역 의미 정확성을 증명하지 않아요. 기본 scripted mock은 콘텐츠와 관계없이 합성 문장을 만들 수 있으므로 실제 창작 품질로 읽으면 안 돼요. 자동 장기기억·authoritative state·원문 retcon·CBS/Lua 호환·수천 에셋 성능은 이번 M1 로컬 범위가 아니에요.

다음 단계는 사용자가 선택한 메인·번역 연결의 실제 adapter를 추가하고 승인된 예산으로 L01을 수행하는 일이에요. 그 전에는 유료 호출이나 외부 배포를 시작하지 않아요.
