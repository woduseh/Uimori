# 공통 UI·아이콘 적용

2026-09-08 사용자 요청으로 [UI 원칙](../docs/UI-PRINCIPLES.md)과 [화면 설계](../docs/UI-SCREEN-DESIGN.md)의 구현을 시작했어요. 기존 문서 변경을 보존하고 기본 추천인 **본문 우선 목록**을 적용 기준으로 삼아요. 저장된 카드/목록 선호는 유지해요.

## 구현 계획

| 단계 | 구현과 유지할 계약 | 상태 |
| --- | --- | --- |
| 기준 화면 | 현재 소스로 빌드하고 합성 DB·포트에서 변경 전 화면 확인 | 완료 |
| 공통 제어·설정 | 의미별 아이콘, 44px 제어, 메뉴의 초점·중첩 대화상자 보호, 모바일 설정 목록→상세와 데스크톱 병치 | 구현 완료 |
| 서재 | 중복 제목 제거, 분류/폴더/검색/관리와 선택 모드, 빈 상태 구별, 읽기 쉬운 목록 | 구현 완료 |
| 연결·데이터 | 얇은 모델/연결 탭, 같은 줄 새로고침, 검색 정렬·항목 메뉴·진단, 백업 형식과 복원 조건 | 구현 완료 |
| 통합·검증 | 품질·전체 단위/통합·빌드, 기존 브라우저 회귀와 새 반응형/메뉴/초안 검사, 화면 직접 검토 | 완료 |

주 에이전트가 공통 제어·설정·헤더와 통합 검증을 맡고, 서재 및 연결·모델은 겹치지 않는 파일 범위로 분담해요. 기존 브라우저 검사의 진입 동선은 새 UI에 맞추되 저장·귀속·취소·삭제·명시적 호출 검사는 유지해요. 사용자 DB·개인 자료·실제 공급자 호출·배포·commit/push는 포함하지 않아요.

## 변경 전 확인

- 기존 빌드는 현재 소스와 지문이 달라 다시 빌드했어요. 최초 sandbox 빌드는 `spawn EPERM`으로 실패했고, 허용된 실행 환경의 동일 빌드는 통과했어요. 이 환경 실패를 제품 결함으로 판정하지 않아요.
- 새 빌드 source/build는 `244b36200b7753993f68dd8da855c8bb3b40bbfb2b377a0275ad2c172564b9a6`이에요.
- `UXUI01`, `LUSE01`, `PMUI07`의 변경 전 합성 브라우저 **3/3 PASS**와 cleanup PASS를 기록했어요. [summary.json](../output/playwright/ui-compact-baseline-2026-09-08T05-33-07-239Z-a9c85cb0/summary.json)
- 현재 소스의 모바일 설정은 이미 한 줄이고 서재 관리 도구도 일부 접혀 있어요. 사용자가 올린 과거 화면과의 차이를 확인했지만 운영 중인 S25U의 배포본·캐시를 이번 검증에서 직접 확인하지 않았어요.

## 완료 기준

공통 아이콘·설정·서재·연결 관리에서 제목과 주요 행동이 먼저 보이며, 360/390/430·중간 폭·데스크톱에서 의도하지 않은 줄 밀림이나 가로 넘침이 없어야 해요. 메뉴의 Escape·바깥 클릭·키보드 초점, 설정 섹션·폭 전환의 초안 보존, 검색 무결과 복구, 중첩 삭제 보호와 모델 테스트의 명시적 실행을 검사해요.

최종 명령은 `npm run quality:full`, `npm run verify:redesign`이에요. 실행 시 소스/빌드 일치, reporter·화면·합성 DB·cleanup 증거를 보존해요. 실패가 생기면 최초 결과와 수정 후 결과를 분리해 기록해요. S25U 실제 키보드·IME·브라우저 도구막대·글자 확대는 합성 viewport 검증과 구분해요.

## 최종 결과

요청 범위를 원본 `main` 작업공간에 구현하고 로컬 검증을 완료했어요. HEAD는 `dbac7e90ecad9be07628d23323c8d401d13f51db`로 유지하며 변경은 미커밋 상태예요. 사용자 DB·개인 자료·실제 공급자 호출·배포·commit/push는 수행하지 않았어요.

| 검사 | 실제 결과 | 근거 |
| --- | --- | --- |
| `npm run quality:full` | 서식·lint·타입·빌드 PASS, 단위/통합 **1,334 PASS · 1 opt-in skip**, 84.48초 | [전체 로그](../output/ui-compact-2026-09-08/quality-full.log) |
| 마지막 검사 선택자 수정 후 `quality`·`build` | PASS | [최종 품질·빌드](../output/ui-compact-2026-09-08/final-build.log) |
| `npm run verify:redesign` | **152/152 PASS**, 실패·skip 0 | [최종 summary](../output/playwright/redesign-2026-09-08T06-32-30-923Z-b6cd3337/summary.json) |
| 소스·빌드·정리 | 소스/빌드 일치, cleanup PASS, 남은 검증 프로세스 0 | [통합 검증 기록](../output/ui-compact-2026-09-08/FINAL-VERIFICATION.json) |

최종 source/build는 `f064957943728cd7b3f07f3b7d3647cdf5c1e914894aac9dbd9f92c85d352361`이에요. 전체 단위 검사 때의 source는 `050a82aad61cece7a4657bc5c840df535560d4d0f9259003658f4145b7dde066`이며, 이후 변경은 `LAZY05` 브라우저 검사의 본문 선택자와 서식뿐이에요. 실행 산출물 지문은 두 시점 모두 `90ce584bedccc307fb2fa1778dcd45a6eca37270f922897cfb0dfb17c2ca8da5`로 같아요.

새 회귀 15건은 설정 목록/상세·뒤로가기·초안 3건, 서재 3건, 연결/모델 3건, 백업/복원 4건, 로딩/API 실패의 탐색 2건이에요. 대표 배치를 360·390·430·768·1024·1440 CSS px에서 확인하고 최종 390/1440px 화면을 직접 검토했어요. 최종 원본 PNG의 복사본과 SHA-256은 통합 검증 기록에 남겼어요.

| 화면 | 직접 검토한 최종 캡처 |
| --- | --- |
| 설정 | [모바일 목록](../output/ui-compact-2026-09-08/settings-list-390.png) · [데스크톱 상세](../output/ui-compact-2026-09-08/settings-general-1440.png) · [미저장 확인](../output/ui-compact-2026-09-08/settings-unsaved-390.png) |
| 서재 | [모바일](../output/ui-compact-2026-09-08/library-compact-390.png) · [데스크톱](../output/ui-compact-2026-09-08/library-compact-1440.png) |
| 연결과 모델 | [모바일](../output/ui-compact-2026-09-08/provider-compact-mobile.png) · [데스크톱](../output/ui-compact-2026-09-08/provider-compact-desktop.png) |
| 데이터·실패 | [데이터 관리](../output/ui-compact-2026-09-08/archive-compact-390.png) · [자료 조회 실패 뒤 탐색](../output/ui-compact-2026-09-08/prompt-data-failure-390.png) |

검증은 Windows Node 24.14.0·Chrome·새 로컬 SQLite·loopback fixture를 사용했어요. 실제 S25U의 키보드/한글 IME·주소창 변화·글자 확대와 운영 배포는 미확인이에요. 합성 viewport·키보드 메뉴 검사가 실제 휴대폰·보조 기술·공급자 호환성의 인수를 대신하지 않아요.

## 구현 내용

- `ui-icons.ts`, `IconButton`, `ActionMenu`로 개념별 아이콘과 44px 조작부를 공유해요. 메뉴는 바깥 클릭과 Escape로 닫고, 안에서 열린 삭제 대화상자의 초점과 취소를 보호해요.
- 서재·프롬프트의 전역 제목을 본문 헤더와 합쳤어요. 서재는 기본 목록과 저장된 보기 선호를 유지하며, 분류 탭·모바일 폴더 선택·검색/관리·선택 모드와 빈 분류/빈 폴더/무결과를 구별해요.
- 설정은 모바일에서 항목 목록→상세, 데스크톱에서 항목과 상세의 병치를 사용해요. 방문한 섹션은 숨긴 채 유지해 연결·모델·등록 요청·파일 초안을 보존하고, 닫을 때 미저장 확인을 제공해요. `app-history.ts`에서 설정의 뒤로가기 처리를 채팅 이동보다 먼저 판단해요. 다른 채팅으로 건너뛰는 이력 이동은 초안 유지 여부와 URL/표시 채팅 일치를 확인해요.
- 모델과 연결은 얇은 탭·같은 줄 새로고침·목록 검색과 추가를 사용해요. 관리 행동은 항목 메뉴, 응답 테스트는 진단 상세에서 열어요. 연결 없는 첫 시작과 모델 없는 상태의 다음 행동을 구별해요.
- 데이터 관리는 JSON/SQLite의 용도를 선택 위치에서 보여주고 파일 해제·늦은 파일 읽기 차단·오류 보존을 제공해요. 인증된 `GET /api/import/status`는 자료를 반환하지 않고 복원 가능 여부만 조회해요. 실제 import도 같은 조건을 transaction 안에서 다시 검사해요. 성공 후 목록 갱신이 실패해도 선택 파일을 지워 같은 복원을 다시 보내지 않아요.

## 초기 실패와 보정

- 첫 `quality:full`은 데이터 안내문 한 곳의 들여쓰기에서 중단되어 서식만 수정했어요. [최초 로그](../output/ui-compact-2026-09-08/quality-full-initial-format-failure.log)
- 다음 실행은 품질·타입·빌드 통과 뒤 **1,333 PASS · 1 FAIL · 1 opt-in skip**였어요. 기존 `provider-registration-agent.test.ts`의 loopback HTTP timeout/cancel 검사 한 건이 15초 timeout으로 끝났고, 소스 변경 없는 단독 재실행은 **8/8 PASS**였어요. 관련 테스트·실행기·transport는 이번 변경에 포함되지 않아요. 최초 실패의 정확한 대기 지점은 확정하지 않았으며 이 결과를 PASS로 고치지 않아요. [전체 최초 로그](../output/ui-compact-2026-09-08/quality-full-initial-timeout.log) · [단독 재실행](../output/ui-compact-2026-09-08/registration-timeout-rerun.log)
- 첫 집중 브라우저는 **14 PASS · 2 FAIL**였어요. 두 실패에서 기존 `popstate` 구독자가 설정보다 먼저 채팅 이동/닫기를 실행하는 것을 확인했어요. 공통 이력 분배기로 처리 순서를 명시하고, 원래 실패했던 초안·여러 단계 뒤로가기 검사를 유지했어요. [최초 summary](../output/playwright/ui-compact-focused-2026-09-08T06-01-31-065Z-2de9219f/summary.json)
- 이력 수정 후 `quality:full`은 **1,334 PASS · 1 opt-in skip**였고, 첫 전체 브라우저는 **146 PASS · 4 FAIL**였어요. 설정 이력 3건을 포함한 새 UI 검사는 통과했어요. 남은 4건은 로딩 완료 전 가시성을 한 번만 검사한 서재 진입 2건과 접힌 연결 메뉴를 열지 않은 2건이었어요. 서재·프롬프트 로딩/실패에도 탐색 헤더를 제공하고 실패 시 탐색 회귀 `LAZY04`를 추가했어요. 기존 검사는 기다리는 공통 탐색 및 항목 메뉴로 진입하며 원래 저장·권한 assertions를 유지해요. [중간 품질 로그](../output/ui-compact-2026-09-08/quality-full-before-library-fallback.log) · [첫 전체 summary](../output/playwright/redesign-2026-09-08T06-08-16-764Z-053c5005/summary.json)
- 화면 직접 검토에서 파일 해제 버튼이 라벨을 포함한 높이에 정렬되어 입력보다 약 13px 위에 있었어요. 입력 하단에 맞추고 6개 폭에서 중심 차이 1px 이내 검사를 추가했어요. 첫 캡처와 달라진 최종 정렬은 최종 실행의 PNG로 확인해요.
- 보정 집중 검사는 처음 **4 PASS · 2 FAIL**였어요. 두 검사에서 자료가 없는 첫 화면의 `봇 만들기`를 기존 `새로 만들기`로 찾았어요. 실제 빈 화면과 자료가 있는 화면의 두 진입 이름을 허용한 뒤 **6/6 PASS**, 이어서 전체 **151/151 PASS**를 확인했어요. [집중 최초 실패](../output/playwright/ui-compact-recovery-2026-09-08T06-19-41-665Z-91400741/summary.json) · [집중 통과](../output/playwright/ui-compact-recovery-2026-09-08T06-22-56-168Z-077e0677/summary.json) · [중간 전체 통과](../output/playwright/redesign-2026-09-08T06-23-47-609Z-b1e5ed10/summary.json)
- 마지막 경로 확인에서 프롬프트 자료 API 실패에도 탐색 헤더가 필요함을 확인하고 `LAZY05`를 추가했어요. 최초 검사는 데스크톱의 사이드바/본문 두 `status`를 함께 찾는 선택자 오류로 실패했고, 검사 범위를 본문으로 좁힌 뒤 **1/1 PASS**였어요. 선택자 수정 중 서식 검사 한 건도 수정했어요. 이 단계는 브라우저 검사만 변경했으며 실행 산출물은 단위·통합 검사 통과 때와 동일해요. [최초 실패](../output/playwright/ui-compact-prompt-recovery-2026-09-08T06-31-06-331Z-bb8fde81/summary.json) · [집중 통과](../output/playwright/ui-compact-prompt-recovery-2026-09-08T06-32-14-927Z-0471e1e4/summary.json)
