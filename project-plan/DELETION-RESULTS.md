# 삭제 기능 구현·검증

2026-09-08, 공유 작업 폴더의 기존 변경과 병행 UI 작업을 보존하면서 구현했어요. 사용자 DB를 초기화하거나 실제 자료를 삭제하지 않았어요.

## 구현

- 서재의 봇·페르소나·모듈·독립 로어·작가 설정·스킬·명칭집, 프롬프트, 창작 프리셋·전역 조합, 연결·모델, native 봇·히든 모듈에 실제 삭제 API와 UI를 추가했어요.
- 채팅·분기·업로드 이미지·미사용 작가 선언·미실행 장면 예약도 삭제할 수 있어요. 폴더 및 패키지·프롬프트 내부 항목은 기존 삭제 경로를 확인했어요.
- 모든 삭제에 확인창을 사용해요. revision 충돌·진행 작업·저장된 참조를 검사하고, 연결 데이터는 트랜잭션으로 정리해요. 분기·채팅 삭제는 독립 포크와 남은 분기의 원문·상태를 보존해요.
- 삭제된 채팅·분기의 선택과 URL, 다른 탭의 Reader를 정리해요. 중첩 확인창이 바깥 설정창까지 닫던 이벤트 전파도 수정했어요.
- 상세 위치와 내부 실행 영수증·기본 항목·과거 참조의 삭제 경계는 [삭제 안내](../docs/DELETION.md)에 정리했어요.

## 검증

다른 작업이 같은 파일을 계속 편집하므로 `output/deletion-validation-20260908-012244/source`에 고정한 소스 복사본으로 최종 회귀를 확인했어요. node_modules는 기존 설치를 공유하고, 서버·DB·포트·브라우저 출력은 별도였어요.

| 검사 | 결과 |
| --- | --- |
| 전체 단위·통합, `--maxWorkers=2` | **1,219 PASS · 1 opt-in skip · 0 FAIL** |
| 삭제·등록 취소 관련 재검사 | **26/26 PASS** |
| 삭제·폴더·프롬프트 브라우저 | **9/9 PASS** |
| 브라우저 최종 source/build | `acdaec75a33bd555d7bcbafa68d2a2dd222b53dbe937d9535297ff4ad30c1bfa` 일치 |
| 브라우저 cleanup | **PASS**, 소유 서버 종료·임시 runtime 제거·증거 DB 보존 |
| 390px 확인창 화면 | 대상 이름 줄바꿈·가로 넘침 없음·삭제 버튼 대비 직접 확인 |
| 공유 작업 폴더 최종 타입·빌드 | **PASS**, build `4000c8a0e606baf354114c6d1c002610d03fc119b156611efe96d562d25e7294` |

- [전체 단위 reporter](../output/deletion-validation-20260908-012244/source/output/deletion-unit-final.json)
- [관련 재검사 reporter](../output/deletion-targeted-results.json)
- [최종 브라우저·정리·소스 지문](../output/deletion-validation-20260908-012244/source/output/playwright/deletion-2026-09-07T16-25-05-632Z-90e5811a/summary.json)
- [모바일 화면](../output/deletion-validation-20260908-012244/source/output/playwright/deletion-2026-09-07T16-25-05-632Z-90e5811a/browser/deletion-browser-DEL01-lib-601eb-al-deletion-at-mobile-width/delete-confirm-mobile.png)

검증한 삭제 관련 24개 파일 중 공유 작업 폴더와 달라진 파일은 `web/useStory.ts`, `web/WorkspacePanels.tsx` 두 개였어요. 차이는 병행 경과시간 표시 작업이며 삭제 변경은 유지되는 것을 diff로 확인했어요. 공유 폴더 빌드 PASS를 고정 복사본과 같은 전체 브라우저 검증이라고 보지는 않아요. 실제 공급자·개인 데이터·휴대폰 하드웨어·배포는 검증하지 않았어요.

## 수정 과정의 실패 기록

1. 첫 전체 단위 검사: **1,216 PASS · 1 timeout · 1 skip**. 등록 요청 HTTP 취소 테스트가 15초를 넘겼어요. 해당 검사와 삭제 검사를 제한된 병렬도로 실행해 26/26을 확인했고, 고정 복사본 전체 검사도 통과했어요. [첫 reporter](../output/deletion-unit-results.json)를 보존해요.
2. [첫 브라우저](../output/playwright/deletion-2026-09-07T16-15-30-133Z-5d1f6c1c/summary.json): 삭제 409가 공통 충돌 문구로 바뀌었어요. DELETE의 참조·충돌 설명을 표시하도록 수정했어요.
3. [두 번째 브라우저](../output/playwright/deletion-2026-09-07T16-18-36-199Z-36073e68/summary.json): 삭제 확인창 종료가 부모 설정창까지 닫았어요. Dialog의 cancel/close/Tab 전파를 격리했고, Esc 취소와 삭제 후 설정창 유지 테스트를 추가했어요.
4. 마지막 화면 검사에서 영구 삭제 버튼의 붉은 글자와 기존 녹색 배경 대비를 발견해, 붉은 배경·흰 글자로 수정한 뒤 위 최종 브라우저 검증을 통과했어요.
5. sandbox `spawn EPERM`은 허용된 로컬 프로세스 재실행으로 검증했어요. 병행 `server/reader.ts` 편집 중 발생한 일시적 구문 오류는 그 작업 완료 후 타입·빌드가 통과한 것을 확인했어요.
