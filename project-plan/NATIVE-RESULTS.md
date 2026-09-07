# Native 통합 구현·검증 결과 · 2026-09-07

지정 자료의 native 구현과 승인된 후속 변경 통합, 로컬 회귀 검사·화면 QA를 완료했어요. 전체 단위 718개와 브라우저 47개가 통과했어요. 실제 자료의 가져오기와 요청 조립은 합성 브라우저 검사와 별도 DB에서 확인했어요. 원본 파일·사용자 DB를 수정하지 않았고 외부 모델 호출·커밋·push·배포는 하지 않았어요.

검증 당시 `main` HEAD는 `51e51967503dd9de9f765c0702210a360adde674`이며 결과는 그 위의 당시 미커밋 작업트리예요. 아래 수치·자료·미리보기는 해당 시점의 고정 기록이에요. 이후 전용 변환기는 제거했으며 [정리 결과](RISU-PORTING-RESULTS.md)와 [CURRENT](CURRENT.md)에서 현재 상태를 확인해요. 최초 계약과 원본→native→변경/미지원→검사 대응은 [NATIVE-PORTING.md](NATIVE-PORTING.md), 공급자별 전송 경계는 [NATIVE-WIRE.md](NATIVE-WIRE.md)에 있어요.

## 구현된 동작

- 프롬프트를 모델/추론 설정과 분리해 system/user/assistant role, 순서, 이력 범위, 조건, 제어값과 채팅별 조합을 저장해요. 미리보기와 실제 main 요청이 공통 조립 함수를 사용하고 Run에 고정해요. Phēmē 일반·tool-call variant의 차이와 완료 도구 경계를 보존해요.
- 사용자가 선택한 비성적 Hinano 각색을 패키지·장면·명시적 버튼/상태 명령·로어 조회·합성 에셋으로 연결했어요. 다음 장면 예약은 해당 분기와 source/hash에 묶어 한 번 소비해요.
- 히든 스토리는 본문 사이의 별도 시점 창작으로 조립하고, 정확한 원문 범위에 접기/표현을 붙여요. 독자의 열람과 인물 지식·세계 사실을 구분하며 번역·기억 제외·원문 수정·포크·보관 복원에 같은 출처를 유지해요.
- 별도 작업의 로딩, 번역 자료 조회, 기억 offline 평가, 공급자 관리/검토 후 등록 변경을 통합했어요. 개별 채택 commit과 파일 대응은 [SOURCES.md](SOURCES.md)에 있어요.

## 검증과 빌드 동일성

[기계 검증 통합 증거](../output/native-porting/FINAL-VERIFICATION.json)는 실제 reporter와 cleanup, fingerprint 재구성을 검증한 뒤 작성했어요.

| 범위 | 결과 | 실행 ID 또는 증거 |
| --- | --- | --- |
| 전체 단위 | 718/718, 실패·skip 0 | `final-2026-09-07T05-38-56.407Z/unit.json` |
| M0 | 단위 13 + browser 3 PASS | `2026-09-07T05-39-37-001Z-5eb36e58` |
| M1-local | 단위 55 + browser 6 PASS | `2026-09-07T05-40-12-959Z-43c991ee` |
| M2-local | 단위 78 + browser 4 PASS | `m2-2026-09-07T05-40-46-623Z-3675a8f1` |
| 기존 UI | 단위 9 + browser 19 PASS | `ui-2026-09-07T05-41-16-427Z-e27504bc` |
| Native UI | browser 3 PASS | `native-ui-2026-09-07T05-48-17-173Z-4cb13f0d` |
| 공급자 관리·등록 보조 | browser 6 PASS | `provider-management-2026-09-07T05-41-57-802Z-a568b3b0` |
| Reader·library 로딩 | browser 4 PASS | `loading-ui-2026-09-07T05-42-08-242Z-88ca7552` |
| Sol UI | browser 2 PASS | `sol-ui-2026-09-07T05-42-16-393Z-e97a4a4c` |
| 검증기 selftest | 의도한 실패 탐지 11 PASS | 전체 실행의 `selftest.log` |
| 기억 offline | 합성 probe 10, 로컬 도구 24회, 모델·네트워크 0회 | 전체 실행의 `memory-offline.log` |

브라우저 합계는 47개이고 선택 단위 검사는 전체 718개에 포함돼요. 브라우저 실행별 증거는 `output/playwright/<실행 ID>/summary.json`에 있어요.

- 전체 실행 source/build: `a04c806ede5fc71609a2b849e631406193cb63889dbb65c374077c49903bf03b`.
- 최종 source/build: `42ef97d9bc4dc9cd8b0865fef2300bac0c3101fa73942b7e61f01f57e0bdda80`.
- 두 빌드의 동일 dist SHA-256: `d1fa5d3b269e4da8143afb3f646fbe5f593592404b900bed336112419fe32e35`.

전체 실행 후 변경한 fingerprint 대상은 `tests/native-browser.spec.ts` 하나예요. 이 파일만 전체 실행 당시 내용으로 대체해 해시를 계산하면 이전 source hash가 정확히 재현돼요. 제품 산출물은 바이트 단위로 같아요. 최종 범위 검사에서는 타입·빌드·Native UI·실제 자료 조립을 다시 확인했고, 이미 통과한 나머지 제품 검사를 반복하지 않았어요. 전체 실행의 native FAIL과 후속 기대값 정정 중 FAIL은 원래 보고서 그대로 남겼어요.

## 검사에서 고친 결함과 기대값

초기 reader 요청이 오래 걸리면 SSE의 새 원문 갱신도 같이 기다리던 경합을 고쳤어요. SSE 조회끼리만 직렬화하고 최초/수동 조회와 분리했으며 기존 view key/request version guard를 유지했어요. 지연된 이전 GET을 풀기 전에 신규 source가 보이고, 이후에도 최신 상태가 유지되는 재현 검사를 통과했어요.

비활성 연결을 가리키는 모델이 새 이야기의 기억된 선택값으로 복원되던 문제를 고쳤어요. 연결 revision 조회 중인 선택과 비활성이 확인된 선택을 구분하고, 아직 제출하지 않은 선택만 정리해요. 이미 제출한 불확실 요청의 payload/idempotency는 보존해요.

히든 구조의 모의 번역 접두사가 `@hsTitle:`을 행 시작에서 밀어내던 문제를 고쳤어요. 해당 로컬 모의 번역만 원문 구조를 그대로 반환하고 결과는 `mock:true`로 남겨요. 실제 공급자의 구조 검증을 완화하지 않았어요. 브라우저 검사는 번역 보기 선택 상태·완료 job의 source/hash·전체 anchors·번역 전용 렌더 영역·히든 구간 2개를 확인해요. 명시적 번역 실행의 revision +1과 로컬 mock attempt 1개를 예상하고, 이후 펼침/화면 확인에는 추가 저장이 없음을 검증해요. 원문 text/hash/editRevision와 Run/profile은 유지돼요.

기존 모델 선택 UI의 명시적 새 연결/새 모델 흐름과 reader API 경로에 맞게 오래된 브라우저 하네스도 정정했어요. 실패가 있던 reporter는 성공으로 덮어쓰지 않았어요.

## 실제 자료와 화면

[실제 로컬 조립 report](../output/native-porting/actual-preview-6ckp2o/report.json)와 [실행 안내](../output/native-porting/actual-preview-6ckp2o/OPEN-PREVIEW.md)를 남겼어요. 이 DB와 개인 변환본은 ignored `output/native-porting/`에만 있어요.

| 항목 | 확인 결과와 경계 |
| --- | --- |
| Phēmē 일반 / tool-call | 각각 45개 제어, 45 / 46개 블록, 실제 조립 37 / 38개 메시지, 캐시 기준 4개, 히든 메시지 2개 |
| 제한된 기준 해석기 비교 | 두 variant 각 50개, 총 100개 조립 비교 일치. 이번 최종 import에서는 기존 비교 증거를 재사용했으며 새로 실행한 것으로 세지 않아요. slot당 단일 텍스트 문맥 기준이고 provider/model 품질 검사가 아니에요. |
| Hinano | 승인된 비성적 각색: 로어 56개(그룹 11·본문 45), 장면 10개·행동 16개·상태 3축·합성 SVG 114개. 원본 본문·이미지 복사 0개 |
| Hidden Story | 원본 35개 제어를 가진 변환본과 비성적 설정을 연결. 변환 상태는 partial이며 제외/미지원은 대응표에 명시 |
| DB·호출 | 새 채팅 2개, 조립 후 취소한 Run 2개, source/job/provider attempt/모델 연결 0개 |
| 원본 보존 | 지정 원본 4개의 실행 전후 SHA-256 동일 |

CUA 브라우저에서 실제 로컬 패키지의 일반 프리셋 45개 블록·45개 제어, `0..-2`와 `-2..end` 이력 필드, 37개 메시지/캐시 4개 미리보기, 비성적 봇 설정을 확인했어요. 기본 desktop과 390×844에서 버튼/입력/닫기가 화면 폭 안에 표시됐어요. 모델을 연결하거나 생성 버튼을 실행하지 않았어요. 이 수동 QA는 먼저 가져온 별도 `actual-preview-8J4APR` DB와 동일 제품 dist를 사용했고, 최종 runtime 가져오기는 `actual-preview-6ckp2o` DB에서 별도로 통과했어요.

합성 화면의 role·순서·history·봇 설정/장면·히든 원문/번역·공급자 관리/충돌·긴 reader는 직접 캡처를 열어 확인했고 [독립 QA 기록](../output/native-porting/INDEPENDENT-QA.md)에서도 남은 레이아웃 차단 문제를 찾지 못했어요. 아래 캡처는 개인 원문이 없는 합성 자료예요.

- [프롬프트 블록 desktop](../output/playwright/native-ui-2026-09-07T05-48-17-173Z-4cb13f0d/browser/native-browser-NUI01-nativ-c86af-tory-and-saved-combinations/native-composer-block-desktop.png), [390px](../output/playwright/native-ui-2026-09-07T05-48-17-173Z-4cb13f0d/browser/native-browser-NUI01-nativ-c86af-tory-and-saved-combinations/native-composer-block-mobile.png), [이력 범위](../output/playwright/native-ui-2026-09-07T05-48-17-173Z-4cb13f0d/browser/native-browser-NUI01-nativ-c86af-tory-and-saved-combinations/native-composer-history-mobile.png)
- [봇 상태 제어](../output/playwright/native-ui-2026-09-07T05-48-17-173Z-4cb13f0d/browser/native-browser-NUI02-nativ-41c3b--a-scene-without-generation/native-bot-controls-mobile.png), [장면 선택](../output/playwright/native-ui-2026-09-07T05-48-17-173Z-4cb13f0d/browser/native-browser-NUI02-nativ-41c3b--a-scene-without-generation/native-bot-mobile.png)
- [히든 번역 desktop](../output/playwright/native-ui-2026-09-07T05-48-17-173Z-4cb13f0d/browser/native-browser-NUI03-hidde-97f2a-e-current-translated-source/hidden-translation-desktop.png), [390px](../output/playwright/native-ui-2026-09-07T05-48-17-173Z-4cb13f0d/browser/native-browser-NUI03-hidde-97f2a-e-current-translated-source/hidden-translation-mobile.png)

모든 검사 서버 cleanup이 PASS이고 활성 PID는 없어요. 실제 패키지 수동 QA의 임시 서버 2개와 CUA 탭도 종료하고 viewport 설정을 복원했어요. 이전 세션의 고정 미리보기 서버는 이 작업의 소유가 아니므로 변경하지 않았어요. 증거 DB·reporter·화면은 보존했어요.

## 남은 범위

M2 전체 인수는 **Q04 실제 장기 의미·비용 평가가 남아 BLOCKED**예요. 기억 도구의 합성 조회 성공은 인물별 의미적 지식 격리나 모델의 장기기억 품질을 입증하지 않아요. 실제 폰/IME, 공급자별 실제 API 인수, 유료 문학·번역 품질 평가는 수행하지 않았어요. 개인 자료의 유료 외부 평가는 중단 상태를 유지해요.

Hinano는 원본 전체 포팅이 아닌 승인된 비성적 각색이고, Hidden Story의 범용 Lua/CBS/regex/CSS 호환을 제공하지 않아요. 특정 모델의 전송 형식 지원과 실제 응답 품질·캐시 적중·청구액은 별도 검증 대상이에요.
