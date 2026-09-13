# 커스텀 패널

봇·페르소나·모듈의 `ContentPackage.panels`로 현재 채팅의 상태창과 선택 화면을 만들어요. 기존 상태·행동을 HTML/CSS 화면에 연결하는 첫 구현이에요. 임의 JavaScript·Lua 실행이나 Risu HTML의 자동 이식 완료를 뜻하지 않아요.

## 사용과 제작

서재의 자료 편집 → **표현 → 커스텀 패널**에서 패널 JSON을 입력하고 **패널 검증 후 적용 → 자료 저장**해요. 미리보기는 옵션 기본값과 상태 초깃값만 읽고 행동은 실행하지 않아요. 미적용 JSON은 편집 초안으로 유지해요.

장착한 자료의 패널은 채팅의 **패키지 상태와 행동** 안에 나타나요. 패널 아래 **기본 상태와 행동**을 열면 기존 상태값·입력 폼·복구 기능을 사용할 수 있어요. 패널 표시나 버튼 처리가 실패해도 원문과 채팅 입력은 유지돼요.

`panels`는 최대 8개이며 각 항목은 다음 필드를 가져요.

| 필드 | 내용 |
| --- | --- |
| `id`, `title` | 패키지 안의 고유 ID와 화면 제목 |
| `template` | 기존 `PromptTemplate` AST. text 노드는 제작자의 HTML이고 계산한 value는 HTML 텍스트/인용된 속성 값으로 이스케이프해요. |
| `css` | 선택적 패널 전용 CSS. 주 앱 화면에 적용되지 않아요. |
| `actions` | 이 패널이 요청할 수 있는 같은 패키지의 `user` 행동 ID 목록. 생략하면 읽기 전용이에요. |

템플릿은 `state`(자기 패키지 상태), `options`와 `control`(자기 옵션), `bot.name`·`user.name`만 읽어요. `if/each/let`으로 선택 단계나 중첩 목록을 표현할 수 있어요. 다른 자료·전체 대화·모델·인증 정보와 slot은 읽지 못해요. 계산한 문자열을 다시 코드나 HTML로 해석하지 않아요. 동적 값은 텍스트 또는 따옴표로 감싼 속성 값에 넣고 HTML 태그/속성 이름이나 CSS 소스로 사용하지 않아요.

다음은 **상태와 행동 → 중립 시작 예제**의 `count` 상태와 `set_count` 행동에 연결하는 패널 JSON이에요.

```json
[
  {
    "id": "counter",
    "title": "진행 기록",
    "actions": ["set_count"],
    "css": "form { display: grid; gap: 12px; } strong { font-size: 1.3em; }",
    "template": [
      { "kind": "text", "text": "<p>기록한 횟수: <strong>" },
      { "kind": "value", "expression": { "context": ["state", "count"] } },
      { "kind": "text", "text": "</strong></p><form data-uimori-action=\"set_count\"><label>새 횟수<input name=\"value\" type=\"number\" min=\"0\" max=\"100\" required></label><button type=\"submit\">횟수 기록</button></form>" }
    ]
  }
]
```

목록형 상태, 선택에 따른 화면 변화와 후속 모델 지침 연결의 전체 합성 예제는 [panel-package.ts](../tests/fixtures/panel-package.ts)에 있어요. 특정 개인 자료의 코드·본문은 포함하지 않아요.

## 버튼과 폼

- `button[data-uimori-action]`은 클릭 때 같은 패키지의 해당 행동을 요청해요. `data-uimori-input`은 고정 JSON 입력이고 생략하면 `{}`예요.
- `form[data-uimori-action]`은 사용자가 제출한 이름 있는 필드들을 하나의 object로 보내요. checkbox는 boolean, number는 유한한 number, 그 외 일반 입력·select·textarea는 string이에요. 빈 number와 중복 이름은 오류예요. 목록/중첩 입력은 고정 버튼 JSON이나 기본 상태·행동 폼을 사용해요.
- HTML을 표시하거나 펼치는 것만으로 행동을 실행하지 않아요. 실제 사용자 입력 이벤트만 호스트 브리지로 전달해요. 성공 여부는 서버의 기존 입력 schema·조건·장착/개정·상태 revision·source hash 검사가 결정해요.
- 버튼은 본문 모델을 자동 호출하지 않아요. `nextRequest` 행동을 연결하면 기존 다음 요청 예약을 만들고, 사용자가 작성란에 넣어 본문 생성을 실행해요.

현재 선택한 분기의 상태만 읽고 바꿔요. 생성 중·행동 처리 중·stale 상태에서는 변경 버튼을 잠그며, 실패한 행동은 오류를 표시해요. 이미 표시한 상태가 있는 패널은 백그라운드 재조회만으로 클릭을 버리지 않고 서버의 상태 버전 검사로 충돌을 판단해요. 늦은 조회 결과는 새 행동 결과를 덮어쓰지 않아요. 동일한 명령 재전송은 원래 실행 문맥과 영수증으로 대조해 상태를 중복 적용하지 않아요. 다른 입력을 같은 키로 재전송하면 충돌이에요.

같은 패널에서 상태 갱신으로 화면이 바뀌어도 제출하지 않은 입력은 행동 ID·필드 이름·입력 종류로 연결해 유지해요. 성공한 폼의 제출값만 정리하고 실패하거나 다른 폼을 사용한 경우에는 지우지 않아요. 초안은 브라우저 메모리에 최대 100필드·전체 메시지 32,000자 한도로 보관하며 서버·공유 진단에는 넣지 않아요. 새로고침으로 페이지를 다시 불러오거나 채팅/패키지 개정이 바뀌는 경우의 영구 초안 복원은 제공하지 않아요.

## 표시와 격리

서버는 조회 시 패널 HTML을 계산하고 브라우저는 DOMPurify의 제한된 HTML 목록으로 정화해요. 화면은 `sandbox="allow-scripts allow-forms"` iframe에 표시하며 `allow-same-origin`을 제공하지 않아요. 실행하는 스크립트는 호스트가 고정한 nonce 브리지뿐이에요. `allow-forms`는 제출 이벤트를 브리지로 받을 수 있게 하고, 실제 제출/탐색은 이벤트 취소와 CSP `form-action 'none'`으로 차단해요.

주 앱 DOM·저장소·직접 통신·외부 이동·원본 스크립트·인라인 이벤트를 허용하지 않아요. 링크·미디어·SVG·중첩 iframe·인라인 style 속성은 이번 범위에서 제외해요. CSS는 별도 `css` 필드로 제공하며 외부 폰트·이미지·import 등의 네트워크 요청은 CSP로 차단해요. 원고의 일반 HTML·정규식 결과를 자동으로 패널 HTML로 승격하지 않아요.

메시지는 정확한 iframe 창과 임시 채널 토큰에 묶고 부모에서 형태·크기·행동 목록을 재검사해요. 채팅/분기/인스턴스 ID를 게스트 메시지에서 받아 권한으로 사용하지 않아요. 서버도 현재 패키지 개정과 패널의 행동 목록을 다시 검사해요. 이 범위는 현재의 고정 브리지와 데이터 템플릿을 위한 경계이며 임의 외부 코드의 실행 격리를 보증하는 것은 아니에요.

정의 AST/계산 결과 HTML은 각각 100,000자, CSS는 32,000자, 메시지는 32,000자 이내예요. 화면 높이는 80–900px 범위에서 늘어나고 더 긴 내용은 안에서 스크롤해요. 계산은 기존 식 실행기의 단계·출력·시간 한도를 사용하며, 실패한 패널은 해당 화면만 오류로 바뀌어요.

## 보존과 현재 범위

정의는 기존 패키지 JSON·revision·Run snapshot·자료 이동·백업 계약에 포함되고 상태는 기존 behavior 저장소를 사용해요. DB 표나 별도 상태 저장소를 추가하지 않았어요. 현재 채팅 패널은 최신 장착 정의와 현재 분기 상태를 보여 줘요. 과거 원고마다 당시의 패널을 붙이는 Reader 표현은 이번 범위가 아니며, 과거 Run의 정의·상태를 현재 값으로 덮어쓰지 않아요.

상세 계약 위치는 `core/package-panels.ts`, `server/package-behavior-host.ts`, `web/PackagePanelFrame.tsx`·`web/package-panel-frame.ts`예요. 관련 검사는 `tests/package-panels.test.ts`·`tests/package-panels-browser.spec.ts`이며 실제 TVoN·다른 표본 전체 기능과 의미 품질은 별도 인수 범위예요.
