# Uimori 실제 UI 시각 검토 · 2026-09-06

> 이 문서는 아래 build에 대한 과거 시각 검토 기록이에요. 이후 봇 중심 개편·공급자 관리·패키지 동작·self-host 접속 화면의 현행 상태는 [CURRENT](project-plan/CURRENT.md)와 각 결과 문서에서 확인해요. 이 문서의 스크린샷과 PASS를 최신 전체 UI 검증으로 사용하지 않아요.

final result: passed (2026-09-06 UI 개편 당시 아래 명시된 build 기준)

2026-09-07 M1 사용 여정의 세 가지 후속 수정과 최신 검증·시각 비교는 [UI-RESULTS 후속 절](project-plan/UI-RESULTS.md#2026-09-07-m1-사용-여정-후속)에 별도로 기록했어요. 아래의 과거 PASS를 이후 공급자/여정 구현 전체로 확대하지 않아요.

최종 캡처를 직접 열어 비교한 범위에서 남은 P0/P1/P2 시각 결함을 발견하지 못했어요. UI-1–UI-3는 실제 M1-local API에 연결되어 있어요. 이 결과는 정적 화면·명시된 브라우저 상호작용의 검토이며 실제 휴대폰이나 live 모델의 통과 판정이 아니에요.

## 비교 대상과 조건

- Source visual truth: `ui-redesign/desktop-chat.png`, `mobile-chat.png`, `desktop-library.png`, `uimori-ui-prototype.html`, `UI_REDESIGN.md`.
- 실제 화면: `output/ui-redesign/2026-09-06T14-15-36.974Z/after-*.png`.
- 구현/build: `537ec723951758cb056ea32defddbe06794f28d63c43a74752bf1612a31a5ecc`. [캡처 identity](output/ui-redesign/2026-09-06T14-15-36.974Z/final-capture-build.json)와 [실행 manifest](output/ui-redesign/2026-09-06T14-15-36.974Z/manifest.json)를 함께 확인했어요.
- Desktop source/implementation은 각각 1440×1000 pixels, CSS viewport 1440×1000이에요. Mobile source/implementation은 각각 390×844 pixels, CSS viewport 390×844예요. deviceScaleFactor 1, 브라우저 chrome·폰 테두리 없음, 밀도 보정/이미지 합성 없음.
- 상태: 원고가 있는 기본 채팅/한국어 번역/원문, 서재, 이야기 설정, 연결 설정, 공급자 거절·부분 출력·미확인 비용, dark/light.
- 시안과 제품의 정보 구조는 맞췄지만 원고·봇·자료 수는 달라요. 실제 화면은 10,901 UTF-16 code units 원문 3개와 번역, 소유 테스트 DB의 fixture를 사용해요. 최종 서재는 성능 측정용 봇이 추가되어 107개를 보여요. 이름·문단·카드 수 차이를 픽셀 오차나 결함으로 계산하지 않았어요.

## 직접 비교한 증거

참조와 실제 캡처를 같은 이미지 비교 입력에 함께 열어 판단했어요. 파일 목록만 읽고 시각 통과를 선언하지 않았어요.

| 비교 | source | 실제 캡처 | 관찰 |
| --- | --- | --- | --- |
| Desktop dark 원고 | `desktop-chat.png` | [after-1440-dark](output/ui-redesign/2026-09-06T14-15-36.974Z/after-1440-dark.png) | sidebar·header·reader·composer의 비율과 순서가 맞고 관리 폼이 원고 앞에 없어요. |
| Mobile dark 원고 | `mobile-chat.png` | [after-390-dark](output/ui-redesign/2026-09-06T14-15-36.974Z/after-390-dark.png) | 메뉴가 본문 위에 쌓이지 않으며 요청·번역·입력창이 첫 화면에 있어요. |
| Desktop 서재 | `desktop-library.png` | [after-1440-library](output/ui-redesign/2026-09-06T14-15-36.974Z/after-1440-library.png) | 검색·분류·카드·시작 동작 위계가 유지돼요. 자료 수 차이는 실제 fixture 상태예요. |
| Mobile 서재/설정 | 모바일 반응형 명세 | [library](output/ui-redesign/2026-09-06T14-15-36.974Z/after-390-library.png), [settings](output/ui-redesign/2026-09-06T14-15-36.974Z/after-390-settings.png) | 단일 열 카드, 스크롤되는 분류, 전체 높이 설정 패널에서 클리핑·겹침이 보이지 않아요. |
| Light 원고 | 같은 셸의 theme 명세 | [desktop](output/ui-redesign/2026-09-06T14-15-36.974Z/after-1440-light.png), [mobile](output/ui-redesign/2026-09-06T14-15-36.974Z/after-390-light.png) | 배경·본문·선택·경계가 구분돼요. dark 참조와의 색상 일치를 주장하지 않아요. |
| 실패/진단 | 오류 공개 명세, 별도 PNG 시안 없음 | [failure](output/ui-redesign/2026-09-06T14-15-36.974Z/after-390-failure.png), [partial-details](output/ui-redesign/2026-09-06T14-15-36.974Z/after-390-partial-details.png) | 요청 바로 아래 거절/부분 결과, 명시적인 상세 버튼, 보존된 부분 출력과 비용 미확인이 보여요. |
| 실제 변경 전후 | [before-390-default](output/ui-redesign/2026-09-06T14-15-36.974Z/before-390-default.png) | [after-390-light](output/ui-redesign/2026-09-06T14-15-36.974Z/after-390-light.png) | 이전에는 관리 영역만 보이던 첫 화면에 원고와 입력창이 함께 보여요. |

원본 크기로 연 모바일 화면에서는 작은 label·아이콘·입력·문단까지 읽을 수 있었고, desktop에서도 각 영역의 텍스트가 판독되어 별도 crop 확대는 필요하지 않았어요. 설정과 실패 화면은 독립 캡처로 추가 확인했어요. 읽기 설정을 닫은 후 일부 캡처에 남은 초점 테두리는 실제 focus-visible 상태예요.

## 필수 다섯 영역

| 영역 | 확인 결과 |
| --- | --- |
| 글꼴·타이포그래피 | system-ui/Segoe UI/Malgun Gothic fallback, 본문 기본 18px와 약 1.9 line-height, 작은 상태·요청·제목 위계가 분명해요. 긴 한글·영문이 reader 폭 안에서 줄바꿈돼요. 참조에 없는 웹폰트를 임의로 추가하지 않았어요. 글꼴/크기 선택은 읽기 설정에서 실제 적용돼요. |
| 간격·배치 | desktop sidebar 250px와 제한된 reader 폭, 60px header/mobile 56px, composer와 reader의 별도 영역을 확인했어요. 과도한 중첩 카드 없이 prose를 읽으며, dialog의 제목/닫기/본문이 겹치지 않아요. |
| 색상·토큰 | charcoal/회녹색 배경과 sage 선택 색상을 유지했어요. light는 같은 토큰 관계로 전환하고 오류는 별도 붉은 배경/텍스트를 사용해요. 테두리·선택·초점이 구분돼요. 전 항목 WCAG 대비 수치 측정이나 스크린리더 인증을 수행한 것은 아니에요. |
| 이미지·아이콘 | 실제 등록된 합성 이야기 에셋을 유지하고 inline 이미지는 검증된 크기로 표시해요. 서재 썸네일이 없는 경우는 사용자 지시대로 중립적인 이름 첫 글자를 사용해요. 장식 사진을 만들거나 시안의 임시 봇 이미지를 실제 콘텐츠로 복제하지 않았어요. lucide 아이콘의 stroke/크기/정렬이 일관돼요. |
| 문구·콘텐츠 | 요청, 장면, 원문/번역, 서재, 이야기 설정, 작업 현황이 동작을 설명해요. fixture 연결은 로컬 검사용으로 표시하며 unknown cost는 미확인이에요. source ID/hash/JSON은 상세에서만 보이고 미구현 live/reasoning 기능을 암시하지 않아요. 스크린샷의 합성/P01/UI14 문구는 검증 DB의 자료 이름이에요. |

## 발견·수정·재검토 이력

1. Baseline: 기본 화면에서 자료 관리·백업·설정이 원고보다 먼저 나와 모바일 첫 화면에 원고와 입력창이 보이지 않았어요. 새 셸에서 별도 목적지/dialog로 옮긴 후 baseline과 같은 390×844 캡처를 함께 열어 첫 화면의 원고·composer 노출을 확인했어요.
2. 브라우저 검사에서 dialog 전환 중 이전 close 이벤트가 다음 dialog를 닫는 문제와 Tab이 BODY로 빠지는 문제를 확인했어요. 열린 상태 guard와 dialog 경계 Tab/Shift+Tab 처리를 추가했어요. 최종 UI08에서 Tab 순환·Escape·초점 복귀가 통과했고 최종 설정 캡처를 다시 확인했어요. 이는 시각 파일 존재만으로 검증한 동작이 아니에요.
3. P2: 첫 원고가 없는 거절/부분 결과 화면에서 “첫 장면을 들려주세요”가 실패 요청 위의 약 330px를 차지했어요. 14:48 UTC에 검토한 수정 전 오류 캡처에서 확인하고, 실행도 없는 경우에만 empty state를 표시하도록 조건을 수정했어요. 같은 390×844/1440×1000의 최종 오류 화면을 재캡처·직접 열어 재검토했어요. 작업 중 오류 캡처 경로는 최종 이미지로 갱신되어 별도 수정 전 오류 PNG는 보존되지 않았어요.
4. 최종 오류 [DOM 증거](output/ui-redesign/2026-09-06T14-15-36.974Z/failure-dom.json): empty state 0, source 0, 가로 overflow 없음. 모바일 첫 오류 top 312.77/bottom 359.56, composer top 681.61; 거절과 부분 결과 label이 composer 위에 있어요. source/job에 실패 출력을 커밋하지 않는 API 결과도 확인했어요.
5. 최종 원고·dark/light·서재·설정·실패 캡처를 직접 다시 열어 비교했으며 추가 P0/P1/P2를 발견하지 못했어요. 다른 검토 agent도 기본/서재/설정을 독립적으로 열어 확인했어요.

## 상호작용·한계와 구현 체크

- 최종 `verify:ui`: 렌더링 7개 / 브라우저 6개 PASS, required skip 0. M0 13+3, M1-local 38+4도 같은 source/build로 PASS예요.
- 5개 viewport에서 원고·서재·이야기 설정·연결 패널 가로 overflow를 검사했어요. 긴 원고의 처음/중간/끝, 새 이야기 profile 실패 재시도, 번역 전환 호출 0, 늦은 후속 도착, 응답 유실의 동일 command 재확인, URL/분기/초안/커서, dialog/합성 composition을 검사했어요.
- 실제 휴대폰의 키보드·IME·백그라운드, live 모델·외부 접속, 모든 보조 기술과 확대 설정은 별도 검증이에요.
- P3/향후 측정 대상: 대규모 자료에서 숨겨진 폼의 DOM 비용이 증가해요. 현재 100개 봇 fixture 측정은 기록했으나 가상화 성능을 확보한 것으로 판정하지 않아요.
- 구현 체크: 셸/reader/composer 적용, 자료/설정/작업 재배치, 실제 API 흐름, 수정 후 재캡처, 최종 회귀 완료. 남은 P0/P1/P2 없음.
