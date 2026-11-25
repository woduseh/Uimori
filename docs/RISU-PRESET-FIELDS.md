# Risu 프롬프트 프리셋 필드

`.risup` 프롬프트 프리셋을 가져오면 Uimori가 무엇을 보관하고 어떻게 쓰는지 정리했어요. RisuAI 프리셋 필드 문서를 바탕으로 Uimori가 실제로 보관하는 필드만 남기고 고쳤어요. 가져오는 방법은 [Risu 자료 가져오기](RISU-IMPORT.md#프롬프트-프리셋), 실행 방식은 [프롬프트 실행](PROMPT-RUNTIME.md)에 있어요. 도우미는 저장된 프리셋을 `resource.read`의 `/program/nativeRisuPreset/preset` 아래 경로로 읽고 고쳐요.

## 보관하는 필드

| 필드 | 형식 | 쓰임 |
| --- | --- | --- |
| `name` | 문자열 | 프리셋 원래 이름. Uimori의 표시 제목과는 따로 있어요. |
| `promptTemplate` | 블록 배열 | 요청을 만드는 메시지 블록. 아래 [블록 종류](#블록-종류)를 봐요. |
| `customPromptTemplateToggle` | 문자열 | 토글 선언. 아래 [토글 선언](#토글-선언)을 봐요. |
| `templateDefaultVariables` | 문자열 | 변수 기본값. 한 줄에 `키=값` 하나이고, 같은 키는 처음 것이 쓰여요. 키나 값이 비면 건너뛰어요. |
| `regex` (또는 예전 이름 `presetRegex`) | 정규식 배열 | 카드 정규식과 같은 형식(`comment`, `in`, `out`, `type`, `flag`, `ableFlag`)이에요. 실행 때 봇과 모듈의 정규식보다 앞에 놓여요. |
| `promptSettings` | 객체 | `utilOverride`, `customChainOfThought`만 보관하고, 둘 다 적용하지 않아요. |

모델, API 주소와 키, 생성 파라미터(`temperature`, `maxContext`, `maxResponse` 등), 모델별 설정(Ooba, NovelAI, AIN 등), `formatingOrder`, `bias`, JSON 스키마, 그룹 채팅, 축별 모델과 파라미터, 대체 모델, 추론 설정, 네트워크 설정, `moduleIntergration`, `modelTools`, `dynamicOutput`, `messagePresetInfo` 같은 나머지 필드는 가져오지 않아요. 모델과 생성 설정은 Uimori의 모델 설정이 맡아요. `mainPrompt`, `jailbreak`, `globalNote`, `useInstructPrompt`, `instructChatTemplate`, `JinjaTemplate`, `jailbreakToggle`, `chainOfThought`와 `promptSettings`의 `sendName`, `sendChatAsSystem`, `postEndInnerFormat`, `assistantPrefill`은 폐기 필드라서 가져올 때 지워요.

## 블록 종류

블록의 `text`, `innerFormat`, `defaultText`는 요청을 만들 때 CBS로 평가해요. `{{jbtoggled}}`는 항상 `"0"`이에요.

| `type` | 필드 | 동작 |
| --- | --- | --- |
| `plain` | `text`, `role`, `type2` | `text`를 `role`(`system`, `user`, `assistant`; `bot`은 `assistant`) 메시지로 넣어요. `type2: "globalNote"`인 블록은 카드의 `post_history_instructions`가 있으면 그 글로 바꾸고, 그 안의 `{{original}}`을 블록 원래 글로 채워요. |
| `chatML` | `text` | `<|im_start|>역할` 구간마다 메시지 하나를 만들어요. 역할은 `system`, `user`, `assistant`만 돼요. |
| `chat` | `rangeStart`, `rangeEnd` | 예시 대화와 대화 기록의 일부를 넣어요. 음수는 끝에서부터 세고, `rangeEnd`가 `"end"`이거나 없으면 끝까지예요. `rangeStart: -1000`은 전체예요. 같은 메시지를 두 블록에 넣으면 실패해요. |
| `cache` | `depth`, `role` | 앞서 만든 메시지 중 마지막 `depth`개(1~4)에 캐시 지점을 둬요. `role`이 `system`·`user`·`assistant`면 그 역할의 메시지만 세요. |
| `persona`, `description`, `authornote` | `innerFormat`, `role2`, `defaultText` | 페르소나, 캐릭터 설명, 작가 노트를 넣어요. `innerFormat`의 `{{slot}}`을 내용으로 바꾸고 `role2` 역할로 보내요. 작가 노트가 비어 있으면 `authornote`의 `defaultText`를 써요. |
| `lorebook`, `postEverything` | — | 로어와 마지막 지시를 system 메시지로 넣어요. |
| `memory` | — | 건너뛰어요. Uimori는 지난 내용 요약을 자체 방식으로 보내요. |

`jailbreak`, `cot` 블록은 폐기 블록이라 가져올 때 지워요. 그 밖의 `type`이 남아 있으면 요청을 만들 때 `RISU_NATIVE_PRESET_BLOCK` 오류로 실패해요. 도우미의 `code.diagnose`가 이런 블록을 찾아 줘요.

## 토글 선언

`customPromptTemplateToggle`은 한 줄에 토글 하나를 `=`로 나눠 적어요.

| 줄 형식 | 뜻 |
| --- | --- |
| `키=이름` | 켬/끔 스위치. 기본값 `"0"`, 켜면 `"1"`. |
| `키=이름=select=가,나,다` | 선택지. 값은 순서대로 `"0"`, `"1"`, `"2"`이고 기본값은 `"0"`. |
| `키=이름=text`, `키=이름=textarea` | 글 입력. 기본값은 빈 글. |
| `=이름=group` … `=이름=groupEnd` | 그 사이의 토글을 한 묶음으로 보여 줘요. |
| `=이름=caption`, `=이름=divider` | 설명 글과 구분선. |

키는 120자 이하이고 제어 문자를 쓸 수 없으며 한 선언 안에서 겹치면 안 돼요. CBS와 Lua는 토글 값을 `toggle_<키>` 전역 값으로 읽어요. 선택지 순서를 바꾸면 저장된 값의 뜻이 달라질 수 있으니 `preset.validate`로 확인해요.

## 알아 둘 점

- `PresensePenalty`, `formatingOrder`, `moduleIntergration`, `seperateParameters`처럼 철자가 이상한 Risu 키 이름은 원래 철자 그대로예요. Uimori는 이 필드들을 가져오지 않아요.
- 알 수 없는 블록 필드는 그대로 보관하지만 실행에는 쓰지 않아요.
- 가져오지 않은 모델 설정이 필요하면 원본 `.risup` 파일을 따로 보관해요.
