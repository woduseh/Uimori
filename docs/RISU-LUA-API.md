# Risu Lua 트리거 API

Uimori가 Risu 카드와 모듈의 Lua 트리거(`triggerlua` 효과)에 제공하는 함수 목록이에요. RisuAI의 Lua API 문서를 바탕으로, Uimori의 Lua 실행기가 실제로 제공하는 함수만 지원한다고 적었어요. 이 목록에 없는 Risu 함수는 Uimori에서 쓸 수 없어요. 도우미의 `code.diagnose`는 아래 [지원하지 않는 함수](#지원하지-않는-함수)를 부르는 코드를 찾아 알려 줘요.

## 읽기 전에

- 대부분의 함수는 첫 인자로 접근 키 `id`를 받아요. 콜백이 받은 `id`를 그대로 넘기면 돼요. 채팅 ID가 아니에요.
- Lua 5.4 문법을 써요. 기본 함수 중 `assert`, `error`, `ipairs`, `next`, `pairs`, `pcall`, `xpcall`, `select`, `tonumber`, `tostring`, `type`, `rawequal`, `rawget`, `rawset`, `rawlen`, `getmetatable`, `setmetatable`과 `table`, `string`, `math`, `utf8` 라이브러리를 쓸 수 있어요. `print`, `os`, `io`, `coroutine`, `debug`는 없어요. `string.dump`도 없어요.
- `load`는 텍스트 청크만 읽고, 읽은 함수는 원래 스크립트의 권한을 그대로 가져요.
- 같은 채팅과 같은 자료 판본에서는 하나의 Lua 실행 환경이 이어져서 전역 값이 다음 콜백까지 남아요. 서버 재시작, 시간 초과, 실행 실패, 자료 수정 때는 사라지므로 오래 남길 값은 채팅 변수나 `setState`에 저장해요. 첫 메시지 미리보기와 읽기 화면의 표시 변환은 저장된 상태를 복사한 일회성 환경에서 실행돼요.
- 한 번의 호출에는 시간·메모리·호스트 호출 횟수 한도가 있어요. 넘으면 그 실행이 실패해요.
- 모든 Lua 스크립트의 최상위 코드는 실행 환경을 처음 만들 때 한 번 실행돼요. 콜백은 그 뒤 사건마다 불려요.

## 콜백

스크립트가 정의하고 Uimori가 부르는 함수예요.

| 함수 | 언제 불리는지 |
| --- | --- |
| `onInput(id)` | 사용자가 보낸 메시지가 대화에 들어가기 전. `false`를 돌려주거나 `stopChat`을 부르면 전송을 멈춰요. |
| `onStart(id)` | 사용자 메시지를 넣은 뒤, 요청을 만들기 전. `false`나 `stopChat`으로 전송을 멈춰요. |
| `onOutput(id)` | 모델 응답을 정리해 대화에 넣은 뒤. |
| `onButtonClick(id, data)` | `risu-btn="data"` 요소를 눌렀을 때. |
| `onFormSubmit(id, name, json)` | `<form risu-form="name">`을 제출했을 때. `json`은 `{data: {...}}` 형태의 문자열이에요. |
| 이름이 있는 전역 함수 | `risu-trigger="이름"` 요소를 누르거나 `{{button::글자::이름}}` 버튼을 눌렀을 때 `이름(id)`가 불려요. |
| `listenEdit(type, callback)` | 편집 콜백을 등록해요. `type`은 `editInput`, `editOutput`, `editRequest`, `editDisplay`이고 `callback(id, value, meta)`의 반환값이 다음 콜백과 결과로 넘어가요. `editDisplay`에서는 문자열 반환값만 넘어가고, 다른 값은 직전 문자열을 유지해요. `editRequest`의 `value`는 `{role, content}` 메시지 배열이에요. |

`async(callback)`은 콜백을 감싼 함수를 그대로 돌려줘요. Uimori의 호스트 호출은 모두 결과를 바로 돌려주므로 따로 코루틴을 만들 필요가 없어요.

## 대화 메시지

메시지는 `{role, data}` 표예요. `role`은 `"user"` 또는 `"char"`예요. 위치 `index`는 0부터 세고, 음수는 끝에서부터 세요.

| 함수 | 설명 |
| --- | --- |
| `getChat(id, index)` | 그 위치의 메시지 사본, 없으면 `nil`. |
| `getChatData(id, index)` | 메시지 글만. 없으면 `""`. |
| `getChatRole(id, index)` | 역할만. 없으면 `""`. |
| `getChatLength(id)` | 메시지 수. |
| `getFullChat(id)` | 전체 대화 사본. |
| `getRecentChats(id, count)` | 마지막 `count`개 메시지 사본. |
| `getChatMain(id, index)`, `getFullChatMain(id)`, `getRecentChatsMain(id, count)` | 위 함수들의 결과를 JSON 문자열로 돌려줘요. |
| `getUserLastMessage(id)` | 마지막 사용자 메시지 글, 없으면 `""`. |
| `getCharacterLastMessage(id)` | 마지막 캐릭터 메시지 글, 없으면 첫 메시지. |
| `setChat(id, index, value)` | 그 위치의 글을 바꿔요. |
| `setChatRole(id, index, role)` | 역할을 바꿔요. `"user"`가 아니면 `"char"`가 돼요. |
| `addChat(id, role, value)` | 끝에 메시지를 더해요. |
| `insertChat(id, index, role, value)` | 그 위치에 메시지를 끼워 넣어요. |
| `removeChat(id, index)` | 그 위치의 메시지를 지워요. |
| `cutChat(id, start, end)` | `start`부터 `end` 앞까지만 남겨요. |
| `setFullChat(id, value)` | 대화 전체를 `{role, data}` 배열로 바꿔요. 형식이 틀리면 실패해요. |
| `setFullChatMain(id, json)` | JSON 문자열로 `setFullChat`을 해요. |

표시 콜백(`editDisplay`)에서는 대화를 바꾸는 함수가 실패해요.

## 변수와 상태

| 함수 | 설명 |
| --- | --- |
| `getChatVar(id, key)` | 채팅 변수. 없으면 문자열 `"null"`. |
| `setChatVar(id, key, value)` | 채팅 변수에 문자열·숫자·불리언을 문자열로 저장해요. |
| `setChatVarChanged(id, key, value)` | 값이 달라질 때만 저장하고 `true`, 같으면 `nil`. |
| `getGlobalVar(id, key)` | 토글(`toggle_<키>`) 등 전역 값. 없으면 `"null"`. 읽기만 돼요. |
| `getState(id, name)` | `__<name>` 채팅 변수를 JSON으로 읽어 표로 돌려줘요. |
| `setState(id, name, value)` | 값을 JSON으로 바꿔 `__<name>`에 저장해요. |
| `setStateChanged(id, name, value)` | 바뀔 때만 저장하고 `true`, 같으면 `nil`. |

CBS의 `{{getvar::이름}}`과 같은 채팅 변수를 써요. 채팅 실행에서 저장한 값은 실행이 끝나면 채팅에 남고, 표시 콜백과 미리보기에서 바꾼 값은 그 표시에만 쓰여요.

## 캐릭터, 페르소나, 메모

| 함수 | 설명 |
| --- | --- |
| `getName(id)` | 캐릭터 이름. |
| `getDescription(id)` | 카드 설명 원문. |
| `getCharacterFirstMessage(id)` | 카드의 첫 메시지 원문. |
| `getBackgroundEmbedding(id)` | 카드의 배경 HTML. 모듈 배경은 포함하지 않아요. |
| `getPersonaName(id)` | 사용자 페르소나 이름. |
| `getPersonaDescription(id)` | 페르소나 설명을 CBS로 평가한 결과. |
| `getAuthorsNote(id)` | 채팅의 작가 노트 원문. 프리셋 기본값은 섞지 않아요. |
| `getLoreBooks(id, search)` | `comment`가 `search`와 정확히 같은 로어 항목들. 본문은 CBS로 평가해요. |

## 알림과 입력 창

| 함수 | 설명 |
| --- | --- |
| `alertNormal(id, message)`, `alertError(id, message)` | 알림을 띄워요. |
| `alertInput(id, value)` | 글 입력 창. `:await()`가 입력한 문자열을 돌려줘요. |
| `alertSelect(id, value)` | 선택 창. `value`는 문자열 배열이고 `:await()`가 고른 값을 돌려줘요. |
| `alertConfirm(id, value)` | 예/아니요 창. `:await()`가 불리언을 돌려줘요. |

표시 콜백에서는 모두 실패해요. 미리보기처럼 사용자가 답할 수 없는 실행에서는 입력 창 함수가 실패해요.

## 모델 호출

카드나 모듈의 `lowLevelAccess`가 켜져 있어야 해요. 꺼져 있거나 표시 콜백에서 부르면 실패해요.

| 함수 | 설명 |
| --- | --- |
| `LLM(id, prompt, useMultimodal?, options?)` | 작문 모델을 불러요. `prompt`는 `{role, content}` 배열이고 결과는 `{success, result}`예요. |
| `axLLM(id, prompt, useMultimodal?, options?)` | 보조 모델을 불러요. `options.mode`는 `otherAx`(기본), `memory`, `translate`예요. |
| `simpleLLM(id, prompt)` | 문자열 하나로 작문 모델을 불러요. |

결과에 `:await()`를 붙여도 같은 값을 돌려줘요. 역할 `sys`는 `system`, `bot`·`char`는 `assistant`로 보내요. `options.streaming=false`, `emotion`·`submodel` 모드는 실패해요. `useMultimodal=true`일 때 사용자 메시지의 `{{inlay::이름}}`은 이 실행에 붙은 카드 이미지로만 찾아요.

## 그 밖의 함수

| 함수 | 설명 |
| --- | --- |
| `cbs(value)` | 글의 CBS를 평가한 결과. `id`를 받지 않아요. |
| `hash(id, value)` | `:await()`가 SHA-256 16진 문자열을 돌려줘요. |
| `getTokens(id, value)` | `:await()`가 작문 모델 토크나이저 기준 토큰 수를 돌려줘요. 표시 콜백에서는 `nil`이에요. |
| `math.random(first?, last?)` | Lua의 `math.random`과 같은 방식으로 수를 골라요. |
| `json.encode(value)`, `json.decode(text)` | JSON 변환. `require('json')`도 같은 표를 돌려줘요. 다른 모듈의 `require`는 실패해요. |
| `stopChat(id)` | 이번 전송을 멈추라고 표시해요. `onInput`과 `onStart`에서 효과가 있어요. |
| `reloadDisplay(id)`, `reloadChat(id, index)` | 화면을 다시 그리게 해요. |

## 지원하지 않는 함수

아래 Risu 함수는 Uimori에 이름만 있고, 부르면 `RISU_NATIVE_API_UNSUPPORTED` 오류로 실패해요.

| 함수 | 이유 |
| --- | --- |
| `sleep` | 실행을 멈춰 기다리지 않아요. |
| `request` | 외부 HTTP 요청을 하지 않아요. |
| `generateImage` | Lua에서 이미지를 만들지 않아요. 삽화는 Uimori 삽화 기능을 써요. |
| `similarity` | 임베딩 계산을 하지 않아요. |
| `getCharacterImage`, `getPersonaImage` | Risu 인레이 저장소가 없어요. |
| `setName`, `setDescription`, `setCharacterFirstMessage`, `setBackgroundEmbedding` | 스크립트가 카드 원문을 바꾸지 않아요. |
| `loadLoreBooks`, `upsertLocalLoreBook` | 활성 로어 조합과 로어 수정은 Uimori의 로어 처리 방식이 맡아요. |
| `log`, `logMain` | 실행 기록용 로그를 받지 않아요. |
| `math.randomseed` | 난수 시드를 정할 수 없어요. |

`print`, `loadLoreBooksMain`처럼 위 목록과 지원 목록 어디에도 없는 Risu 이름은 Uimori에 없어서, 부르면 nil 호출 오류가 나요.
