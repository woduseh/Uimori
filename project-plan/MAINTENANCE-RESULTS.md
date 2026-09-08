# 코드·문서·하네스 유지보수 결과

2026-09-08. 최근 서재·프롬프트·탐색 변경이 반영된 공유 작업공간을 점검하고 현행 구현과 어긋난 안내, 미사용 스타일, 중복·폐기된 검증 코드를 정리했어요. 시작 시 남아 있던 변경은 별도 세션에서 커밋됐으며 이 작업은 index를 변경하지 않았어요. 병행 배포 세션의 Compose·배포 설정은 이번 변경·검증 범위와 구분해요.

## 발견한 문제와 정리

| 영역 | 문제 | 반영 |
| --- | --- | --- |
| 실행 안내 | v10/v11 저장 형식, 모델 미선택 시 합성 실행, 제거된 기타 자료·간단 편집 등 예전 설명이 남아 있었어요. | v12, 일반 실행의 역할별 모델 필수, 서재/프롬프트 분리·페르소나 후보·현재 편집·JSON bundle 한도를 코드와 맞췄어요. |
| 현재 상태 | `CURRENT.md`에 여러 시점의 ‘현재’ 버전과 긴 중복 연혁이 누적됐어요. | 현행 계약·최신 검사·남은 인수 범위와 상세 결과 지도로 줄였어요. 각 결과 문서의 실패·지문·검증 범위는 보존해요. |
| 화면 코드 | 이전 자료 선택·간단 편집·분기 탐색 등에서 쓰던 CSS가 남아 있었어요. | 7개 CSS의 미사용 class 27개 / selector 69개 / rule 62개를 제거했어요. 동적 JSX class와 공통 wrapper, 본문 표시 경로를 함께 확인했고 공용 selector는 유지했어요. 패키지 내보내기의 폐기된 히든 자료 안내도 고쳤어요. |
| 브라우저 하네스 | 유사한 실행 코드가 복제돼 소유권 기록이 `cleanup`의 계약과 달랐고, 짧은 실행기에는 종료 시 지문·증거·cleanup 검사가 빠져 있었어요. | 8개 진입점을 `scripts/browser-verification.mjs`로 통합했어요. 기존 검사 선택·필수 ID·timeout을 유지하고 소유권, reporter, 종료 지문, canary, DB 증거·정리 실패를 공통 처리해요. self-host는 독자 HTTPS 흐름을 유지하며 ownership 생성만 수정했어요. |
| 취소 | 독립 리뷰에서 최종 JSON 저장 중 취소가 PASS 판정과 경합할 수 있었어요. | 증거·정리 완료 후 취소 처리 종료 경계를 두고 terminal 결과를 저장해요. 완료 직전 취소와 저장 경계 회귀를 추가했어요. |
| 폐기된 캡처 도구 | `scripts/ui-evidence.mjs`는 봇 없이 채팅을 만드는 예전 API와 사라진 UI 선택자를 사용했어요. 현행 호출도 없었어요. | 629줄 초기 화면 전후 캡처 도구를 삭제했어요. 당시 스크린샷·manifest는 유지하고 현재 UI 검증은 `verify:redesign`, 로딩 측정은 `measure-loading.mjs`를 사용해요. |
| 문서 참조 | 제거된 코드 링크 2개, 바뀐 제목으로 연결되지 않는 anchor 2개와 현재 폴더에 없는 과거 `output/` 링크 20건을 확인했어요. | 코드 경로는 역사 기록으로 구분하고 후속 계약을 연결했어요. anchor를 현재 제목에 맞췄으며 과거 증거의 부재를 표시하고 원래 결과를 새 PASS로 바꾸지 않아요. |

일반 `Content`와 attachments는 현재 API·fixture에서 사용 중이므로 유지했어요. 중단된 live journey 진입점은 부작용 없는 차단 동작과 회귀가 있어 보존했어요. 사용자 제공 `ui-redesign/` 시안과 과거 실행 증거, 사용자 DB·인증 파일은 삭제하지 않았어요.

## 검증

| 검사 | 결과 | 근거 |
| --- | --- | --- |
| `npm run quality:full` | 서식·lint·타입·빌드 PASS, 단위·통합 **1,263 PASS · 1 opt-in skip** | [최종 실행 로그](../output/maintenance-2026-09-08/quality-full-final.log) |
| 새 하네스 회귀 | **15/15 PASS**, 위 전체 검사에 포함 | [회귀 코드](../tests/harness.test.ts) |
| `npm run verify:redesign` | 실제 Chrome **120/120 PASS**, 실패·skip 0 | [최종 summary](../output/playwright/redesign-2026-09-08T00-19-51-471Z-3289df14/summary.json) |
| `npm run verify:selftest` | 기존 실패 탐지 **11/11 PASS** | [실행 로그](../output/maintenance-2026-09-08/verifier-selftest.log) |
| 종료 지문·정리 | 소스/빌드 일치, cleanup PASS, live PID 0, runtime 제거 | 위 브라우저 summary와 [종합 기록](../output/maintenance-2026-09-08/FINAL-VERIFICATION.json) |
| 문서 정적 검사 | Markdown 78개, 상대 파일 링크·Markdown 제목 anchor·현행 npm 명령 오류 0 | [정적 검사](../output/maintenance-2026-09-08/documentation-check.json); 현재 없는 과거 output 20건은 별도 표시 |
| 직접 화면 확인 | 데스크톱 탐색·서재, 390px 페르소나·프롬프트 화면에서 이번 CSS 제거로 생긴 배치 손실·가로 잘림을 발견하지 못함 | [4개 화면과 비교 범위](../output/maintenance-2026-09-08/visual-review.json) |

최종 source/build는 `13105066d37b250b44c58329b093b3926033d36e7a20ccda87ec1195e5606628`, dist는 `6f4dad035e9f3b1c497a35c2aa35ad6a0ba8aeebef7a25178d72bcf05f026990`예요. 브라우저 종료 뒤 `assertBuild()`도 통과했어요. 마지막에는 문서와 결과 기록만 갱신했어요. opt-in skip은 `NR_CODEX_PREFLIGHT=1`을 요구하는 설치된 Codex CLI 사전 검사예요. 기존 selftest는 환경변수 후속 수정 전에 실행했으며 해당 selftest와 공유 lib는 그 뒤 변경하지 않았어요.

이 정리 시점에는 Vite의 500kB 초과 chunk 경고를 유지했어요. 이후 요청으로 진행한 개선은 [화면 지연 로딩·CI 결과](BUNDLE-CI-RESULTS.md)에 별도로 기록해요. 이 문서의 검증을 번들 분할·성능 개선 증거로 해석하지 않아요. 문서 정적 검사는 상대 Markdown 파일 링크·제목 anchor·현행 npm script 이름을 확인하며 외부 URL을 재조회하거나 문서의 모든 의미를 자동 판정하는 검사는 아니에요.

하네스의 합성 오류 주입 회귀 15개는 실제 reporter 읽기·파일 증거·수동 cleanup을 사용하고, 프로세스/브라우저 시작 및 빌드 경계는 mock으로 제어해요. 누락·0건·skip·재시도·전역 오류·명령 실패·timeout·지문 변경·필수 ID 충돌·정리 오류·브라우저 없음·취소를 검사해요. 환경변수 격리는 실제 자식 Node와 제품 networkPolicy/listenAddress로 확인해요. 이는 실제 Chrome 실행을 대신하지 않으며 별도 전체 브라우저 검사와 구분해요.

첫 전체 브라우저 실행은 새 하네스가 `NR_PUBLIC_ORIGIN`을 빈 문자열로 전달해 서버 시작에 실패했어요. 브라우저 검사 0개인 [원본 FAIL](../output/playwright/redesign-2026-09-08T00-16-10-481Z-5b7df89a/summary.json)과 cleanup PASS를 보존해요. 서버는 `undefined`만 로컬 모드로 취급하므로 하네스가 부모 환경값을 제거하도록 수정하고 실제 자식 환경 회귀를 추가했어요. 제품의 origin 검사 계약은 바꾸지 않았어요. 앞선 1,262 PASS 결과는 이 추가 회귀 전이며 최종 결과와 구분해요.

처음 하네스 단독 Vitest 실행은 설정 로딩 중 `spawn EPERM`으로 막혔고 승인된 로컬 실행에서 통과했어요. 문서 정적 검사 중 Node의 git 자식 실행도 같은 환경 제한을 만나 파일 목록을 별도로 전달했어요. 제품 실패나 통과 증거로 계산하지 않아요.

검증은 새 임시 SQLite·무작위 loopback 포트와 합성 자료를 사용해요. 실제 공급자 호출·비용·모델 품질·개인 작품·물리 휴대폰/IME·Linux/Docker 배포는 이번 결과에 포함하지 않아요. 의존성 버전이나 외부 모델 지원 목록의 최신 릴리스를 조사·갱신하는 작업도 아니에요.

## 추가 점검 · 2026-09-08

화면 지연 로딩·CI 수정 이후 추가 정리를 요청받아 남은 진입점과 현행 안내를 점검했어요. 다른 작업이 수정 중인 보조 오류 복구 관련 제품·테스트 파일은 그대로 두고, 아래 범위만 변경했어요.

| 발견 | 수정 |
| --- | --- |
| activity·turn-activity·loading·evaluation·prompts·provider-management 검증기가 실행·증거·정리 코드를 중복 유지 | 6개를 공통 실행기의 설정으로 통합해 중복 1,314행을 줄였어요. 기존 file/grep/필수 ID/180초 제한과 필수 화면을 유지해요. |
| `verify-prompts`가 더 이상 생성하지 않는 `prompt-simple-mobile.png`를 요구 | 현행 `prompt-structure-mobile.png`로 바꿨어요. |
| 공통 실행기가 등록 fixture 오류를 기록만 하고 최종 실패로 반영하지 않음 | 오류가 있으면 browser assertion의 PASS와 별개로 전체 FAIL로 판정해요. 실제 loopback fixture에 잘못된 요청을 보내는 회귀를 추가했어요. |
| 개별 실행기의 필수 PNG 검사를 통합할 필요 | 실제 파일의 존재·PNG signature·최소 길이를 검사해요. 파일 누락/잘못된 signature/짧은 파일/정상 보존 회귀를 추가했어요. 이미지 전체 decode나 시각 품질 검사는 아니에요. |
| `measure-loading`이 이미 열린 transaction 안에서 `updateProfile`을 호출 | profile 갱신을 transaction 밖으로 옮겼어요. 기존 packageAttachments의 소유 봇과 일반 조회 자료 구조를 유지해요. history의 contentHash, 최신 빌드 확인, loopback 환경 격리, DB 종료와 cleanup 실패 기록·ownership을 보강했어요. 측정용 DB는 기존 계약대로 증거에 남겨요. |
| 참조 없는 제품 선언 4개 | `packagePersonaName`, `packageRequestTables`, `VERTEX_GEMINI_DEFAULT_THINKING_LEVEL`, `ModelTarget`의 15줄을 제거했어요. 문서에 공개된 제작 API와 현재 기본값 계산은 유지해요. |
| 현행 문서의 과거 모델 버전 선택, 항상 selftest 실행, schema v11 안내 | 최신 모델 ID/설정과 과거 snapshot을 구분하고, 선택 case별 실제 검사 범위와 v12를 명시했어요. |
| 로컬 첨부파일 폴더가 소스 목록에 함께 표시 | `.codex-remote-attachments/`만 Git 제외 경로에 추가했어요. 파일은 그대로 보존해요. |

로딩 측정 도구는 수정 전에 실제 실행해 **`cannot start a transaction within a transaction`**으로 실패했어요. [원본 FAIL](../output/playwright/loading-followup-before-2026-09-08T00-47-34-148Z-94e6610f/summary.json)을 보존해요.

동시 작업의 build 경합을 피하려고 코드·설정·문서 520개를 별도 사본으로 고정했고 복사 전후·사본의 코드 지문이 일치했어요. 사용자 DB·인증·사진·기존 dist는 복사하지 않았어요. 오프라인 `npm ci`는 캐시되지 않은 tiktoken으로 실패해 로그를 남겼고, 기존 설치 의존성을 별도로 복사한 뒤 manifest 일치와 `npm ls --all`을 확인했어요. 새 clean install 통과로 해석하지 않아요. [사본 지문](../output/maintenance-followup-2026-09-08/snapshot.json) · [설치 실패](../output/maintenance-followup-2026-09-08/install.log) · [의존성 준비](../output/maintenance-followup-2026-09-08/dependencies.json)

| 최종 검사 | 결과 | 근거 |
| --- | --- | --- |
| `npm run quality:full` | 서식·lint·타입·의존성·빌드 PASS, 단위·통합 **1,274 PASS · 1 opt-in skip** | [실행 로그](../output/maintenance-followup-2026-09-08/quality-full.log) |
| 공통 하네스 회귀 | **20/20 PASS**, 위 전체 검사에 포함 | [회귀 코드](../tests/harness.test.ts) |
| `npm run verify:redesign` | 실제 Chrome **124/124 PASS**, fixture 오류 0, cleanup PASS | [summary](../output/maintenance-followup-2026-09-08/workspace/output/playwright/redesign-2026-09-08T00-56-07-972Z-037c0710/summary.json) |
| `node scripts/verify-prompts.mjs` | **6/6 PASS**, 필수 PNG 3개 확인, cleanup PASS | [summary](../output/maintenance-followup-2026-09-08/workspace/output/playwright/prompt-editor-2026-09-08T00-56-22-428Z-ccbc1044/summary.json) |
| `node scripts/measure-loading.mjs --label followup-fixed` | 초기 진입·설정 SSE·reload·scroll 측정 PASS, cleanup PASS | [summary](../output/maintenance-followup-2026-09-08/workspace/output/playwright/loading-followup-fixed-2026-09-08T00-55-00-836Z-ce4acfe2/summary.json) |
| 측정 DB 무결성 | source 1,000개·asset 1,000개·profile 10개, profile별 올바른 봇 1개와 일반 로어 4개, 외래 키 오류 0 | [읽기 전용 검증](../output/maintenance-followup-2026-09-08/measurement-validation.json) |

최종 source/build는 `664d189428dc335f6636b53f8c0008f881df700e0383a1d268da68486b402ab7`, dist는 `88baacf093a08333a649b52db6c9b4e90be446013b080b39ad45ea4f2f34e6e8`예요. 브라우저 종료 후 `assertBuild()`를 통과했고 원래 작업공간의 코드 지문도 사본과 일치했어요. 모든 실행의 live PID는 0이며 브라우저 runtime은 제거하고 측정 DB는 증거로 유지했어요. [종합 기록](../output/maintenance-followup-2026-09-08/FINAL-VERIFICATION.json)

측정 DB의 첫 보조 확인은 일반 attachments에서 봇을 찾는 잘못된 조건을 사용했어요. 실제 소유 관계인 `chat_organization`과 `packageAttachments`를 기준으로 수정해 통과했으며, [첫 판정](../output/maintenance-followup-2026-09-08/measurement-validation-first.json)도 보존해요. 봇 누락이라는 제품 결함으로 계산하지 않아요.

전체 검사에는 사본 생성 시점의 병행 보조 복구 변경도 포함돼 있어요. opt-in skip은 설치된 Codex CLI 사전 검사이며, 실행한 Chrome·DB는 합성 자료를 사용해요. 로딩 도구의 실행 복구를 검증한 결과로 제품 성능 향상 수치를 주장하지 않아요. 실제 공급자·개인 작품·배포·물리 기기 검증과 원격 CI 재실행은 포함하지 않아요.
