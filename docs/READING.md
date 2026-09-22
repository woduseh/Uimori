# 본문·도우미 읽기 스타일

읽기 설정은 브라우저 공통으로 사용해요. 작품별 설정과 문맥 의미에 따른 줄바꿈 판정은 제공하지 않아요.

## 적용 범위

채팅·분기·원문·화면 종류는 `web/reader-navigation.ts`의 하나의 이동 상태로 관리해요. 사용자 이동은 주소가 다시 같아지는 A→B→A나 같은 원문 재선택도 새 의도로 취급하므로, 이전 조회나 재시도 완료가 새 화면을 덮어쓰거나 다른 분기로 옮기지 않아요. 주소가 같아도 새 이동에 맞춰 조회를 시작하므로, 첫 조회 도중 같은 채팅을 다시 선택해도 읽기를 이어가요. 이미 표시 중인 같은 페이지는 새 조회가 끝날 때까지 유지해요. 기본 분기 주소의 고정과 native 원문 교체에 따른 주소 보정은 새 사용자 이동으로 취급하지 않아요. 전송한 요청의 복구 키와 초안 저장 주소는 그대로 유지해요. 관련 검사는 `tests/reader-navigation.test.ts`, `tests/reader-navigation-browser.spec.ts`와 기존 Reader 복구 검사에 있어요.

Reader는 SSE의 목표 cursor까지 조회를 이어가며, 일시적인 조회 실패는 새 이벤트 없이도 최대 5초 간격의 백오프로 재시도해요. 전체 재동기화는 응답이 실제 적용된 뒤에만 완료로 처리하고 채팅을 떠나면 재시도를 취소해요. 손상된 읽기 위치·커서 캐시는 무시하지만 원문과 입력 초안은 유지해요. 생성 요청 복구 키는 실제 분기 ID를 사용하고 최초 main 분기는 기존 저장 주소를 유지하므로 명시적 내부 main URL에도 같은 요청을 복구해요. 요청 기록 저장에 실패하면 생성 요청을 보내지 않아요.

서버에 실행 중인 요청이 보이더라도 수락 여부가 불확실한 로컬 기록이 있으면 전송 버튼은 ‘이전 요청 확인’을 유지해요. 저장된 동일 요청 키로 수락을 확인한 뒤 실행 취소 버튼을 보여주므로, 확인 도중 상태 갱신이 클릭을 취소 동작으로 바꾸지 않아요.

설정 → 일반 → 원고 읽기 또는 채팅 메뉴 → 읽기 설정에서 바꿔요. 읽기 스타일·간격·부호별 역할은 `uimori:readability` localStorage에 저장하며 같은 origin의 다른 탭에도 반영해요. 도우미 답변·독립 가정 장면·생성 중 공개 텍스트와 설정 예문은 앱의 인용 스타일을 사용해요. 원문·저장된 번역과 설정 미리보기의 Risu 메시지는 열린 Shadow DOM으로 표시해요. Markdown에서 생성한 일반 문단·제목·목록에는 글꼴·크기·줄간격·문단 간격과 인용 강조·줄바꿈을 적용해요. 작성자 HTML과 컨트롤의 구조는 유지하며, 임의 HTML이나 inline HTML이 포함된 문단을 일반 서술문으로 추측해 재작성하지 않아요. 입력한 요청, 편집 초안, 설정 지침, 도구 JSON, 상태·진단 카드는 적용 대상이 아니에요.

기본값은 강조·대사 줄바꿈·생각 줄바꿈 모두 꺼짐이며, 간격은 기존 화면 값을 유지해요. 기존 글꼴·본문 크기·폭 선택은 유지해요. 본문 크기는 9~28px을 1px 단위로 고르며 기본은 18px이에요. 채팅과 전역 읽기 설정이 같은 선택을 사용하고 새로고침 후에도 저장한 크기를 복원해요. 도우미의 기존 Markdown 문자와 줄바꿈도 기본값에서는 그대로 표시해요.

| 선택 | 동작 |
| --- | --- |
| 기본 | 강조·줄바꿈을 끄고 기존 간격으로 돌아가요. |
| 여유롭게 | 행간 2.2와 문단 간격 1.5em을 적용해요. |
| 대사 중심 | 은은한 강조와 대사 줄바꿈을 켜요. 생각 줄바꿈은 꺼둬요. |
| 사용자 설정 | 강조·줄바꿈·간격을 개별 변경한 상태예요. |

스타일 프리셋을 바꾸어도 직접 지정한 부호별 역할은 유지해요. ‘읽기 스타일 초기화’는 부호별 역할까지 새 읽기 스타일 설정을 초기화하며 기존 글꼴·크기·폭·기본 보기 선택은 유지해요.

## 부호와 줄바꿈

`"…"`·`“…”`·`「…」`는 대사, `'…'`·`‘…’`는 생각, `『…』`는 일반 인용이 기본이에요. 각 부호를 대사·생각·일반 인용·처리 안 함으로 바꿀 수 있어요. 실제 문맥의 의미를 추론하거나 새 모델 호출을 하지 않아요.

완결된 최상위 인용의 앞뒤를 화면에서만 나눠요. 기존 줄바꿈과 문단 경계는 보존하고 줄바꿈이 없는 방향에만 표시용 경계를 추가해요. 중첩 인용의 내부에서는 다시 줄을 나누지 않고, 짝이 닫히지 않은 인용은 그대로 표시해요. 기본적인 영문 apostrophe와 코드·URL·태그 속성·ruby·보호 토큰은 인용 분석에서 제외해요. 본문 Markdown의 굵게·기울임에 걸친 인용도 스타일을 유지해요. 도우미와 생성 중 텍스트는 기존처럼 Markdown 자체를 문자로 표시하면서 인용 스타일을 적용해요.

`“괜찮아”라고 그녀는 말했다.`도 대사 줄바꿈이 켜져 있으면 닫는 부호 뒤에서 분리돼요. 조사·서술 결합·작품명 등 문맥별 예외는 사용자 실사용 후 후속 검토 대상으로 남겨요. 긴 문단이나 원문 블록을 넘어 부호를 억지로 이어 맞추지 않아요. 생성 중에는 닫는 부호가 도착한 완결 범위부터 강조·분리가 나타날 수 있어요.

## 원문 보존과 구현

`web/reading-preferences.ts`가 기본값과 브라우저 저장값 검증을, `web/useReadingPreferences.ts`가 저장·탭 반영·표시 간격·읽던 블록/메시지 위치 복원을 맡아요. 설정은 `web/ReadabilitySettings.tsx`, Risu 본문·미리보기는 `web/RisuMessageSurface.tsx`, 도우미·안전한 일반 Markdown은 `web/Prose.tsx`예요. 부호 짝맞춤은 `web/reading-quotes.ts`, DOM 장식은 `web/reading-dom.ts`, 공통 인용 스타일은 `web/reading-prose.css`를 사용해요. `server/risu-reading-markdown.ts`는 표시용 Markdown 토큰에만 읽기 대상 마커를 붙이고, `web/reader-dom.ts`는 Shadow DOM의 선택 범위와 읽기 위치를 연결해요.

표시용 React/DOM 요소와 CSS만 바꿔요. 저장된 원문·번역문·hash·offset·block anchor와 이미지 귀속은 바꾸지 않아요. 기존 패키지 표시 변환 뒤의 화면 텍스트에 적용하고, 모델 입력·사용량·백업·내보내기에는 읽기 설정을 넣지 않아요. 본문·가정 장면 복사 버튼은 기존 저장 텍스트를 복사해요. 드래그 선택 복사는 브라우저의 시각적 개행 처리를 따를 수 있어요.

검사는 `tests/prose.test.ts`, `tests/reading-quotes.test.ts`, `tests/reading-preferences.test.ts`와 `tests/reading-browser.spec.ts`에 있어요. 관련 화면 검사는 `npm run verify:ui`에 연결해요. Shadow DOM 회귀 검사는 `tests/risu-message-surface-browser.spec.ts`와 `tests/risu-native-frame-browser.spec.ts`의 `RSURFACE` 검사에서 읽기 설정, 입력 상태, 선택, 액션 실패·리비전 잠금을 확인해요. 마커 출처는 `tests/risu-reading-markdown.test.ts`로 확인해요. 합성 브라우저 증거와 실제 휴대폰·개인 작품에서의 읽기 효과는 구분해요.

## Native Risu 첫 메시지

봇에 작성된 인사는 **첫 메시지**로 표시하고, 첫 생성 결과부터 **장면 1**로 번호를 매겨요. 내부 source ID·순서·분기 기준은 바꾸지 않아요. 장면 목록에서도 첫 메시지를 별도로 표시해요.

새 채팅에서는 첫 메시지를 선택하고 **미리보기**를 펼칠 때 작성된 화면을 불러와요. 요약이나 본문은 기본으로 표시하지 않으며, 선택을 바꾸면 미리보기도 다시 접혀요. 첫 메시지 없이 시작할 수도 있고, 작성된 첫 메시지를 선택해 채팅을 만들어도 본문 모델을 호출하지 않아요. 선택 버튼과 시작 트리거는 실제 채팅에서 기존대로 작동해요.

새 채팅 폼이 길어져도 **채팅 만들기** 버튼은 스크롤 영역 아래에 계속 보여요.

장면 목록은 첫 메시지를 번호 대신 아이콘과 하나의 제목으로 표시하고, 생성된 장면은 번호·요청 요약·현재 위치로 구분해요. 검색과 페이지 이동은 기존 장면 ID를 사용해요.

모바일에서는 본문 아래의 이전·현재 장면·다음 줄로 이동해요. 현재 장면을 누르면 장면 목록을 열고, 집중 읽기에서는 이 탐색 줄도 숨겨요. 데스크톱의 왼쪽 장면 눈금과 같은 장면 ID와 이동 동작을 사용해요.

장면이나 본문 끝으로 이동하면 Risu 화면이 뒤늦게 펼쳐져도 선택한 위치를 유지해요. 직접 스크롤하거나 읽기 키·터치·포인터로 조작하면 위치 보정을 멈추며, 다른 채팅이나 분기로 이동한 뒤 이전 화면의 높이 변경을 적용하지 않아요.

원문이나 번역을 수정하는 동안은 편집창을 보여주고 같은 본문의 읽기 영역은 숨겨요. 취소하거나 저장하면 읽기 위치와 보기 선택을 복원하며, Risu 화면을 숨길 때 기존 메시지 DOM과 입력 상태를 유지해요. 저장 오류·다른 탭에서 바뀐 내용 안내와 초안 복구는 계속 표시해요.

Risu 메시지의 기본 글자색·글자 크기·글꼴·줄간격은 상속되는 CSS 변수로 적용해요. 읽기 설정과 액션 리비전 갱신만으로 메시지 HTML을 다시 넣지 않으므로 입력값과 접힌 상태를 유지해요. 실제 HTML/CSS 결과가 바뀌면 새 내용을 표시해요. 선택한 본문을 도우미에게 보낼 때는 해당 메시지의 Shadow Root까지 포함해 선택 범위를 확인해요. 선택 범위는 `Selection.getComposedRanges({ shadowRoots })`로만 읽어요. 이 API를 지원하는 현재 브라우저를 실행 조건으로 두며 구형 선택 API로 되돌리는 경로는 제공하지 않아요.

번역 결과를 새로 불러오는 동안 같은 채팅·분기·원문 버전의 원문 메시지 DOM을 유지해 읽던 위치가 줄어든 임시 화면으로 이동하지 않게 해요. 이전 번역은 새 번역처럼 표시하지 않고, 갱신 중에는 봇의 실행 버튼을 잠시 비활성화해요.

봇 자체의 고정 폭·고정 위치 UI를 모바일용으로 자동 재배치하지는 않아요. 따라서 앱의 탐색·입력창이 정상이어도 원본 카드 내부의 버튼이나 문구가 좁은 화면에서 겹칠 수 있어요.

## Helper sessions

Each independent chat can have multiple helper sessions. A session owns its conversation, draft and context; closing the panel or selecting another session does not cancel its work. Tools can explicitly target another chat when requested. Copying a chat produces an independent chat, not a shared branch with a mutable default.

Opening the reader or helper takes a current view and event cursor, then follows newer changes; historical notifications are not replayed just to rebuild the screen. Message content updates preserve the reading position, and both native HTML and ordinary prose use the same outer block anchors.

Direct source edits retain the immutable authored original, the newest two edited versions and versions still captured by unfinished work. Translation history retains current/previous successful text and any active image target; billing summaries do not require an archive of every full translation.
