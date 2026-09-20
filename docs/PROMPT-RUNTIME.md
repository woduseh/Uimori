# Risu 네이티브 프롬프트 실행

프롬프트는 필수 `nativeRisuPreset` 안에 Risu의 `promptTemplate`, CBS 본문, 토글 선언, 기본 변수, 프리셋 정규식을 보관해요. 별도의 Uimori 블록 AST·표현식·템플릿·정규식 변환 문법은 없어요. 저장·가져오기·복원은 같은 네이티브 계약을 검사하며 이전 독자 형식으로 우회하지 않아요.

## 저장과 편집

RISUP 가져오기는 프롬프트 관련 필드만 선택해요. API 키·연결 주소·모델 선택·샘플링 설정은 활성 프롬프트에 넣지 않으며 Uimori 모델 설정이 관리해요. `web/NativeRisuPresetEditor.tsx`에서 원본 블록, 역할, 순서, CBS, 토글, 기본 변수, 정규식을 편집해요. 검증하지 않은 JSON 초안은 저장을 막고 편집기에 유지해요.

레거시 옵션 `jailbreakToggle`, `chainOfThought`, `promptSettings`의 `sendName`, `sendChatAsSystem`, `postEndInnerFormat`, `assistantPrefill`은 UI와 실행에서 제거했어요. 가져오기·새 저장·내보내기에서는 별도 안내 없이 제외하고, `jailbreak`·`cot` 블록도 일반 텍스트로 바꾸지 않고 제외해요. 대화 블록의 종속 옵션 `chatAsOriginalOnSystem`과 `type2: jailbreak` 분류도 제거해요. 해당 기능의 과거 실행 결과를 재현하는 호환 분기는 두지 않아요.

`promptControls()`는 `customPromptTemplateToggle`에서 입력 UI를 계산해요. 선택 토글 값은 Risu의 문자열 인덱스, 텍스트 값은 문자열, 미설정은 null이에요. UI 옵션 정의는 별도 작성 원본이 아니에요. 현재 선택값과 저장 조합은 workspace revision CAS로 저장하며, 정의가 다른 조합은 적용하지 않아요.

채팅 옵션은 프리셋에 더해 연결 모듈의 `customModuleToggle`과 카드의 `extensions.risuai.toggles`를 합쳐 계산해요. 이 합산은 원본 프리셋을 수정하지 않아요. 같은 키의 호환되는 정의는 한 값을 공유하고, 타입이나 선택값 구성이 다르면 충돌을 알려요. 한글·점 등 원래 키를 CBS의 `toggle_<원래 키>`로 전달하며 객체 예약키는 충돌 없는 호스트 ID로 표시해요. 카드·모듈 값도 채팅 고정·다음 요청·위임의 정의 해시와 예약 트랜잭션으로 보호해요. 모델·연결·샘플링 선택은 토글 원본으로 덮어쓰지 않아요.

기본 제공 Phēmē·Hermēneía도 동일한 원본 형식이에요. [기본 제공 프롬프트](BUILTIN-PROMPTS.md)를 참고해요.

## 실행과 보존

1. 서버가 해당 Run의 대화·요청·변수·시각을 고정해요.
2. 네이티브 CBS worker가 활성 블록에서 사용하는 필드를 순서대로 평가하고 `nativeRisuPresetProgram`에 원본·평가 입력 해시, 평가문, 변수, 진단을 기록해요. 제거된 jailbreak·cot와 후문·응답 시작 문구, 호스트가 실행하지 않는 memory 블록, 비어 있는 슬롯의 사용하지 않는 형식은 변수 부작용도 실행하지 않아요. `{{jbtoggled}}`는 항상 `0`이에요.
3. `compileRisuPrompt()`은 이 평가문이 적용된 Risu 블록에 호스트의 인물·로어·대화 슬롯을 넣어 모델 메시지를 구성해요. `{{slot}}`은 이 단계의 원문 삽입 표시예요.
4. 공급자 인코더가 논리 메시지의 역할·캐시·prefill을 해당 프로토콜에 맞춰 직렬화해요.

새 컴파일러 표시는 `risu-native-prompt-2`예요. 이전 `risu-native-prompt-1` 컴파일 경로에서도 제거된 옵션을 실행하지 않으며 해당 옵션에 의존한 과거 영수증의 복사·복원 호환성은 보장하지 않아요. 과거 독자 컴파일러 버전은 실행하지 않아요. 히스토리 식별자와 원문 해시를 유지하고 같은 히스토리를 중복 삽입하는 구성은 거절해요. Risu의 `memory` 블록은 별도 기억을 주입하지 않으며 Uimori가 준비한 기억·문맥을 사용해요. 모델 요청 전 준비가 필요한 네이티브 프롬프트는 CBS 평가가 끝나기 전 전송하지 않아요.

카드의 `post_history_instructions`는 `type2: globalNote` 블록의 원문을 교체하고 `{{original}}`을 그 블록 본문으로 치환한 뒤 CBS를 평가해요. 별도의 전역 지침으로 중복 삽입하지 않아요. `mes_example`은 원문의 화자와 `<START>` 경계를 먼저 읽고 각 메시지 본문을 CBS로 평가하며, `chat` 범위의 앞부분에 역할을 유지해 배치해요. 실제 분기 기록에는 예시를 저장하지 않아요. `chatML`과 대화 기록은 원래 역할과 본문을 유지해요. `innerFormat`과 `role2`는 persona·description·authornote에만 적용해요. 공급자 공통 prefill 직렬화 계약은 남지만 Risu의 제거된 `assistantPrefill` 설정으로 메시지를 만들지 않아요. 제거된 항목은 가져오기 경고를 만들지 않으며 다른 미지원 블록·호스트 설정의 검토는 유지해요.

재컴파일은 고정 CBS 결과를 투영하며 평가를 반복하지 않아요. 해시나 필드 목록이 원본과 다르면 영수증을 거절해요. 번역은 원문 생성 시점에 고정된 번역 프롬프트를 별도로 평가하되 카드 상태나 저장된 프리셋을 바꾸지 않아요. 호스트는 번역할 원문과 그 시점의 참고 자료·사용자 메모를 현재 user 메시지에 담고, 네이티브 `chat` 블록이 이를 배치해요. 원문은 CBS로 평가하지 않으며 프리셋이 현재 메시지를 제외한 경우에만 모델 입력의 고정 자료로 별도 전달해요.

선택적 `collaboration`은 호스트의 읽기 전용 보조 에이전트를 구성하고, `execution.storySubmission`은 본문 제출 계약을 지정해요. 둘 다 콘텐츠 문법을 추가하지 않아요. [협업](AGENT-COLLABORATION.md)의 호출 한도·취소·고정 입력 계약을 따라요.

## 카드 변수와 기억

카드·모듈·프리셋은 Risu CBS와 Lua로 변수를 읽고 써요. 사용자 변수 편집기는 현재 분기의 문자열 override를 revision과 원문 해시로 보호해요. 기본 변수는 원본 Risu 선언에서 읽고 빈 문자열과 미설정을 구분해요. 이야기에서 일어난 일의 요약·장기 기억은 Uimori 문맥 기능이 맡으며 카드의 변수 규칙을 별도 AI 상태 체계로 복제하지 않아요.

## 검증

`tests/risu-native-prompt-composition.test.ts`, `tests/risu-native-preset.test.ts`, `tests/risu-native-semantics.test.ts`는 실제 vendor CBS, 평가 순서, 글로벌노트 교체, 예시 역할, 토글, 슬롯, 대화 범위, 캐시, 폐기 옵션의 실행·부작용 차단과 영수증 일치를 확인해요. `tests/risu-retired-execution.test.ts`는 과거 원본에서 시작하는 새 작업의 재투영을 확인해요. `tests/chat-options.test.ts`는 합산 토글의 채팅 선택·예약·백업 경계를 확인해요. `tests/risu-preset-import.test.ts`는 프롬프트만 가져오는 경계와 저장을 확인해요. 이 검사는 실제 공급자의 창작·번역 품질을 판정하지 않아요.

실제 로컬 자료를 명시적으로 검증할 때는 `UIMORI_RISU_LOCAL_CARDS`에 CHARX 경로 JSON 배열, `UIMORI_RISU_SAMPLE_PRESET`에 프리셋 경로를 지정하고 `tests/risu-native-local-compatibility.test.ts`를 실행해요. 이 검사는 원문을 로그에 남기지 않고 첫 메시지·대체 메시지 렌더, 알려진 원본 버튼, 현재 요청·출력 처리와 원본 파일 해시 불변을 확인해요. 브라우저는 기존 `UIMORI_RISU_SAMPLE_ROOT`와 선택적 프리셋 경로를 사용해 `scripts/verify-risu-native-samples.mjs`로 실행하며 `--grep`은 검증 범위를 명시적으로 좁혀요. 데스크톱·모바일에서 선택, 재열기, 분기 격리와 다음 턴을 로컬 모의 공급자로 확인해요. `--visual`일 때만 개인 자료가 렌더된 스크린샷을 git 제외 검증 폴더에 저장하며, HTTP 본문이 담기는 trace는 저장하지 않아요.
