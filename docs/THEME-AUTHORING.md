# 테마 제작 가이드

Uimori 테마는 **화면 표현만 바꾸는 독립 자료**예요. 이야기 원문·번역·모델 프롬프트·카드 변수와 별개예요. HTML/CSS 파일을 직접 실행하는 플러그인이 아니며, Risu의 `guiHTML`/CBS/JavaScript를 자동 호환하지 않아요.

## 사용과 제작 흐름

설정 → **테마·색상**에서 기본 테마를 적용하거나 **복제·꾸미기**로 시작해요. 색상 선택은 밝은 색/어두운 색을 각각 편집하고, 화면 모드는 기기 설정/밝게/어둡게 중 골라요. 고급 편집에는 앱 CSS·본문 CSS·레이아웃 HTML·레이아웃 CSS가 있어요.

**미리 적용**은 이 탭의 임시 화면이며 서버 선택을 바꾸지 않아요. 다른 설정으로 이동하거나 설정을 닫으면 끝나요. **테마 저장**은 자료만 저장해요. 저장 후 테마 카드를 누르면 선택한 범위에 적용해요. 기본 테마는 읽기 전용이고 사용자 테마는 이름 변경·복제·삭제·내보내기를 지원해요. 편집 초안은 이 편집기가 열려 있는 동안만 보관하며, 미저장 상태로 닫을 때 저장/버리기를 고르게 해요. 새로고침 후 초안 복원은 제공하지 않아요.

**테마 가져오기**는 파일을 먼저 편집기에 열어요. 내용을 확인하고 저장하면 항상 새 ID로 추가하며 기존 자료를 덮어쓰지 않아요. 설정의 화면 모드·글꼴·읽기 크기는 기존처럼 기기 설정이고, 테마 자료와 선택은 서버 SQLite에 저장돼요. 다른 탭은 변경 알림, 다른 기기는 창으로 돌아올 때 최신 선택을 읽어요. 실시간 기기 간 푸시 동기화는 아니에요.

적용 우선순위는 **현재 채팅 → 현재 봇 → 작업실 기본 → 기본 숲 테마**예요. 선택한 채팅을 열어 설정에서 봇/채팅 범위를 고를 수 있어요. ‘상위 설정 따르기’는 해당 범위의 별도 선택을 해제해요. 선택 중인 사용자 테마를 삭제하면 그 테마를 가리키는 선택만 제거하고 상위 테마로 돌아가요.

## 파일 형식

`.uimori-theme.json`은 UTF-8 JSON이에요. 최소 예시는 다음과 같아요.

```json
{
  "format": "uimori-theme",
  "version": 1,
  "theme": {
    "title": "내 서재",
    "description": "종이색 배경과 따뜻한 강조색",
    "colors": {
      "light": { "bg": "#f6f1e7", "accent": "#785137" },
      "dark": { "bg": "#211d19", "accent": "#dcb98b" }
    },
    "appCss": "[data-uimori-part='scene'] { border-radius: 16px; }",
    "messageCss": "p { letter-spacing: 0.01em; }",
    "templateHtml": "",
    "templateCss": ""
  }
}
```

`title`은 필수이며 최대 100자, 설명은 2,000자예요. CSS 세 필드는 각각 1,000,000자, HTML은 100,000자까지예요. 가져오는 JSON 파일은 4MiB 이하예요. 버전은 형식 식별용이며 다른 앱이나 과거 형식 자동 변환을 약속하지 않아요. ID·개정 번호·적용 대상은 내보내기에 넣지 않아요.

색상 이름에는 `--`를 붙이지 않아요. 지원 목록은 `core/themes.ts`의 `THEME_COLOR_KEYS`가 기준이에요.

```text
bg, nav, panel, surface, surface-raised, hover, line, input-border,
text, muted, faint, accent, accent-ink, accent-soft, user,
error, error-ink, error-bg, shade
```

색상은 HEX(`#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`)예요. 생략한 값은 Uimori 기본 CSS를 상속해요. `--border`는 `--line`을 사용하는 기존 별칭이에요. 복잡한 그라디언트·여백·테두리·서체는 CSS 필드를 사용해요. 사용자 글꼴·크기·행간 등 읽기 설정을 `!important`로 덮어쓰지 마세요.

## 세 가지 스타일 영역

| 영역 | 입력 | 적용 대상 |
| --- | --- | --- |
| 앱 | `colors`, `appCss` | 사이드바·입력창·패널·장면 바깥쪽. 색상 변수는 본문에도 상속돼요. |
| Risu 본문 | `messageCss` | 각 `RisuMessageSurface`의 Shadow DOM. 작성된 봇 HTML의 구조는 바꾸지 않아요. |
| 장면 레이아웃 | `templateHtml`, `templateCss` | 요청·제목·본문·작업 버튼이 놓일 자리와 그 바깥 장식. 별도 Shadow DOM이에요. |

앱의 일반 CSS 선택자는 Shadow DOM 안으로 관통하지 않아요. 본문을 꾸미려면 `messageCss`를 사용해요. 본문 CSS는 `uimori-message-theme` 레이어에 들어가므로 일반 작성자 CSS와 명시적 읽기 설정이 우선해요. 동일한 테마 시트를 메시지들이 공유하며 CSS 변경만으로 메시지 HTML을 다시 만들지 않아요. `@import`는 본문 스타일시트에서 지원하지 않아요. 필요한 CSS는 파일 안에 넣고, 웹폰트는 앱 CSS에 선언하세요.

안정적인 앱 표식은 다음과 같아요.

```css
[data-uimori-part="scene"]          /* 하나의 저장 장면 */
[data-uimori-part="scene-frame"]    /* 레이아웃 Shadow DOM 호스트 */
[data-uimori-part="request"]        /* 사용자 요청 */
[data-uimori-part="heading"]        /* 제목·상태·원문/번역 전환 */
[data-uimori-part="body"]           /* 본문·편집·삽화·후속 상태 */
[data-uimori-part="actions"]        /* 복사·수정·장면 작업 */
[data-uimori-part="composer-input"] /* 요청 입력창 */
```

`html[data-theme="light"|"dark"]`는 명암 모드이고, `html[data-uimori-theme]`는 실제 테마 ID예요. 저장 ID에 디자인을 하드코딩하지 마세요. 내부 클래스도 앱 CSS에서 사용할 수 있지만 공식 표식보다 변경에 민감해요. Risu 본문 안에서는 `.risu-message-content`, `.risu-chat-text`, `[data-uimori-prose]`를 참고할 수 있어요. `body`/`html` 선택자를 메시지 문서로 재해석하지 않아요.

## HTML 레이아웃과 슬롯

아래 네 개의 슬롯은 **정확히 한 번씩** 필요해요. 빈 HTML은 앱 기본 배치를 사용해요.

```html
<slot name="request"></slot>
<section class="paper">
  <header><slot name="heading"></slot></header>
  <main><slot name="body"></slot></main>
  <footer><slot name="actions"></slot></footer>
</section>
```

```css
.paper {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: clamp(14px, 3vw, 30px);
}
header { border-bottom: 1px solid var(--line); margin-bottom: 20px; }
footer { margin-top: 16px; }
@media (max-width: 600px) { .paper { padding: 14px; } }
```

본문·버튼·편집기는 React가 관리하는 기존 노드이며 브라우저의 네이티브 슬롯에 투영돼요. 템플릿을 바꾸어도 이 노드를 복사하거나 다른 컨테이너에 다시 렌더링하지 않아요. 슬롯 없는 추가 안내를 위한 기본 `<slot></slot>`은 생략하면 자동으로 맨 끝에 넣어요. 슬롯을 중복시키거나 누락하면 미리보기/가져오기에서 알려주며, 서버를 통해 잘못 저장한 테마도 Reader에서는 기본 레이아웃으로 대체해요.

템플릿에 앱 버튼을 새로 만들어 동작을 재구현하지 마세요. 슬롯은 브라우저의 실제 `<slot>`이며 이전 논의의 `data-uimori-slot` 예시는 구현 문법이 아니에요. 스크립트·이벤트 속성·iframe·폼 입력 등을 실행하지 않아요. HTML에 넣는 `<style>` 대신 `templateCss`를 사용하세요. 테마는 임의 JavaScript 실행 기능이 아니에요.

## 이미지와 자유도

CSS `url(...)`, 템플릿의 일반 이미지 등으로 배경·장식을 사용할 수 있어요. 이번 형식은 별도 이미지 묶음 저장소가 아니에요. 외부 URL은 그대로 남아 네트워크·브라우저 정책을 따르고, 다른 서버의 `/api/...` 주소를 내보냈다고 이미지가 같이 옮겨지지는 않아요. 작은 직접 작성 이미지의 data URL은 JSON 안에 포함돼요. 폰트 파일을 별도 배포하지 말고 시스템 글꼴 또는 사용 허가를 확인한 웹폰트를 사용하세요.

장식은 실제 본문과 조작 버튼을 가리지 않아야 해요. 고정 높이·전체 화면 `position: fixed`·무거운 배경 필터·끊임없는 애니메이션은 피하고, 긴 한국어 본문과 작은 화면을 먼저 고려하세요. 애니메이션이 있다면 `prefers-reduced-motion`을 존중하세요.

## 에이전트 작업 순서

1. 사용자 요청의 분위기·봇의 설정·이미지 사용 가능 범위를 확인하고, 기존 테마 또는 `fixtures/themes/` 예제를 읽어요. 관련 없는 대화 기록이나 키를 테마 파일에 넣지 않아요.
2. 색상과 CSS만으로 가능한 부분부터 만들고, 배치 변경이 필요할 때만 HTML을 추가해요. 테마 때문에 봇 스크립트·원문·메모를 수정하지 않아요.
3. 테마 파일을 가져와 예문과 실제 합성 채팅에서 밝게/어둡게, 412px/1440px 화면을 확인해요. 긴 본문·번역 전환·메뉴·읽기 설정·작성자 입력 상태를 확인해요.
4. 미리 적용한 화면을 실제로 보고 수정한 뒤 저장 가능한 JSON을 제공해요. 실행하지 않은 브라우저 검증·실제 모델 품질을 확인했다고 쓰지 않아요.

내장 도우미는 `theme.guide`, `theme.list`를 먼저 읽고 `resource.read/save/undo/delete`의 `kind: "theme"`를 사용해요. 기존 테마 수정은 최신 `expectedRevision`을 사용하며 기본 테마는 새 ID로 복제해요. 저장과 사용자 선택은 별개이고, 이번 도우미 도구에는 테마 선택 기능을 추가하지 않았어요. 앱 밖의 에이전트는 파일 제작만으로 충분하며 인증 키를 내보내기에 넣지 않아요.

## 복구·검증·범위

**Ctrl/Cmd + .**는 이 탭의 테마를 임시로 끄거나 다시 켜요. 화면을 조작할 수 없으면 주소에 `?theme-safe=1`을 붙여 여세요. 다른 쿼리가 있으면 `&theme-safe=1`이에요. 이 복구는 저장된 테마를 삭제하지 않아요. 임의 CSS는 설정 화면까지 가릴 수 있으므로 이것을 실험용 탈출구로 유지해요.

```sh
npm run check
npm test -- tests/themes.test.ts
npm run build
npm run verify:themes
```

`verify:themes`는 테마 화면과 기존 Risu 메시지 표면 회귀 검사를 격리된 합성 서버에서 수행해요. 결과와 화면은 `output/playwright/themes-*/`에 남아요. 테스트에서 캡처한 이미지를 실제로 열어 확인하세요. 캡처 성공만으로 미적 품질이나 물리 기기 동작이 보장되지는 않아요.

전체 SQLite 백업에는 테마와 선택도 들어가요. 개별 테마 JSON은 독립 교환용이고, 기존 봇/채팅 백업·독립 채팅 사본에는 별도 테마 자료와 선택을 자동 묶지 않아요. 다른 작업실로 옮길 때 테마도 따로 내보내고 적용해 주세요. 테마 삭제/편집은 원문이나 모델 입력을 변경하지 않아요. 표정 패널·BGM·TTS·입력 번역은 이번 기능의 범위가 아니에요.

## Template support and updates

Templates support ordinary presentation HTML, native slots, inline `style` elements and non-submitting input/select/textarea controls. They do not run JavaScript or CBS, submit forms, or embed iframe/object documents. Unsupported executable or document-level markup is reported visibly and the default layout is used; it is not silently saved as an apparently working layout. Put app-wide styles in `appCss`, message styles in `messageCss`, and scoped layout styles in `templateCss`.

An unchanged theme revision retains its applied DOM/CSS. The catalog supports conditional HTTP revalidation; helper activity only invalidates themes after an actual theme write.
