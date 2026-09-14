# 상태 계산 코드

현재 [베타 계획](../project-plan/BETA-PLAN.md)의 2~3단계 구현이에요. 봇·페르소나·모듈의 사용자 버튼, 생성 전 자동 준비, 모델이 호출하는 행동과 응답 후 처리에 JavaScript·Lua 계산을 연결할 수 있어요. `model.generate`와 `conversation.read`는 제작자가 요청하고 사용자가 채팅에서 정확한 자료 개정에 별도로 허용하는 capability예요. 추가 모델 호출에는 전역 `extensionModel` 선택도 필요해요. 자료별 알고리즘은 코드에 두고 상태 schema·소유권·충돌·저장은 Uimori가 담당해요. Risu 어댑터의 이벤트/API 범위는 [가져오기](RISU-IMPORT.md#lua-콜백-가져오기)를 따르며 일반 HTTP, 게스트가 모델·키·endpoint·옵션을 고르는 권한, 확장 설치 관리 전체는 아직 지원하지 않아요.

## 제작과 사용

`program.language`는 `javascript` 또는 `lua`예요. 생략하면 기존 JavaScript이며 과거 프로그램과 영수증 hash에 필드를 보충하지 않아요. Lua도 같은 `{state,input}`을 받아 `{state,result}`를 반환하고 같은 Host 권한·임시 효과·저장 경로를 사용해요.

```lua
local current = api.host.call("variables.read", {key="counter"})
local count = (tonumber(current.value) or 0) + 1
api.host.call("variables.set", {key="counter", value=tostring(count)})
return {state=api.state, result=api.json.null}
```

위 예제는 `variables.read`·`variables.write`를 선언하고 채팅에서 쓰기를 허용해야 해요. Lua의 Host 호출은 coroutine 대기·재개를 사용하며 JS Promise나 Node 객체를 전달하지 않아요. `api.json.encode/decode/null/array/object`는 JSON null·빈 배열·객체를 보존해요. 새 빈 배열은 `api.json.array({})`, 객체는 `api.json.object({})`로 명시할 수 있고 기본 빈 테이블은 객체예요. 표준 table/string/math/utf8와 같은 환경의 text-only `load`를 제공하지만 파일·OS·package·debug·JS 접근과 임의 난수/시각은 제공하지 않아요. Risu의 JSON null→nil·빈 테이블→배열 관행은 호환 어댑터 안에서만 처리해요.

서재의 자료 편집 → **상태와 행동**에서 비어 있는 자료에는 **코드 계산 예제 넣기**를 사용할 수 있어요. 기존 자료는 제작자용 동작 JSON의 action에 `program`을 추가하고 검증·적용한 뒤 저장해요. 기본 행동 폼과 [커스텀 패널](PACKAGE-PANELS.md)의 버튼은 같은 서버 경로를 사용해요. GET·일반 미리보기·자료 저장만으로 코드를 실행하지 않아요. 아래 상태 업데이트의 명시적 변환 미리보기는 별도 실행 경로예요.

추가 모델 호출을 사용하는 순서는 간단해요.

1. 설정 → 역할별 모델에서 전역 **확장 호출 모델**을 선택해요. 기본값은 없음이에요.
2. 자료의 행동에서 제작자가 `user`, `model`, `before-turn`, `after-turn` 호출 방법과 `model.generate` capability를 요청해요. 자동 실행에는 `automaticInput`도 지정해요.
3. 채팅에서 장착한 자료의 **추가 모델 호출 허용**을 켜요. 이 허용은 그 자료의 현재 revision에만 적용돼요.
4. 사용자 버튼·생성 전·응답 후 자동 처리 또는 본문(main) 모델이 요청한 행동에서 코드가 `model.generate`를 사용할 수 있어요.

사용자 버튼의 코드는 자기 상태 계산·자료 읽기와 허용된 추가 모델 호출을 지원해요. 모델 capability를 선언한 버튼은 같은 actions API에서 영구 작업으로 접수해요.

```json
{
  "id": "count_unique",
  "label": "중복 없는 항목 세기",
  "inputSchema": {
    "type": "record",
    "properties": {"text": {"type": "string", "maxLength": 2000}}
  },
  "effects": [],
  "program": {
    "api": "uimori-state-action-v1",
    "source": "const items = [...new Set(api.input.text.split('\\n').map(s => s.trim()).filter(Boolean))]; return {state: {count: Math.min(100, items.length)}, result: {items}};"
  }
}
```

이 예제의 부모 `behavior`는 `count`가 0~100 정수인 record schema와 `{count:0}` 초깃값을 선언해요. `source`는 `api` 하나를 인자로 받는 함수 본문이에요. `api.state`는 이 장착 인스턴스의 상태 사본, `api.input`은 schema 검사를 마친 행동 입력이에요. 반환값은 정확히 `{state,result}`예요. `state`는 전체 다음 상태이며 기존 state schema를 만족해야 해요. `result`는 호출자에게 돌려줄 JSON이에요. 모델이 다음 판단에 필요한 내용을 직접 `result`에 담아요.

`triggers`를 생략하면 사용자 버튼이고 `['model']`이면 모델 호출, `['before-turn']`이면 생성 전 자동 준비예요. 여러 호출 방법을 함께 허용할 수도 있어요. 편집기의 행동 호출 방법에서 선택하고 자동 준비에는 schema에 맞는 `automaticInput` JSON을 지정해요. 모델 호출의 입력 schema는 record여야 해요. `effects:[]`를 두고 `draws`·선언형 `result`와 함께 쓰지 않아요. 시작문의 `initialAction`은 transaction 안에서 끝나는 선언형 행동 전용이라 코드 연결을 계속 거절해요. `nextRequest`는 사용자 전용 행동에서만 다음 요청을 예약하며 모델을 자동 호출하지 않아요. 현재 코드 API에는 시각·기록된 난수 도구가 없으며 `Date`·`Math.random`을 제공하지 않아요.

## 자료 상태 변환 코드

`PackageBehavior.migration?: ExtensionProgram`은 이전 상태를 새 정의로 옮기는 순수 계산이에요. action 안이 아니라 `behavior`에 선언하며 `capabilities`는 생략하거나 빈 배열이어야 해요. 자료 읽기·모델 호출 등 Host API 권한은 허용하지 않아요. `api.state`는 이전 상태 사본, `api.input`은 `{from:{behaviorRevision,schemaVersion},to:{behaviorRevision,schemaVersion}}`이에요. 반환값은 `{state,result}`이며 전체 `state`를 새 `stateSchema`로 검증해요. 기존 Worker의 실행·출력 한도를 적용해요.

예를 들어 이전 `{count:3}`을 새 `{total:3}`으로 바꾸는 제작자 선언은 다음과 같아요. 새 schema는 `total`을 허용해야 하며 지원하지 않는 이전 개정은 코드에서 거절해요.

```json
{
  "migration": {
    "api": "uimori-state-action-v1",
    "source": "if (api.input.from.schemaVersion !== 1 || api.input.to.schemaVersion !== 2) throw new Error('Unsupported schema'); return {state: {total: api.state.count}, result: {renamed: 'count -> total'}};"
  }
}
```

사용자가 **변경 내용 확인**을 누른 preview POST에서만 계산하고 영구 상태는 쓰지 않아요. 적용은 서버가 보관한 동일 후보를 CAS로 채택하며 재실행하지 않아요. GET·일반 미리보기·가져오기·저장·모델 예약·포크·복원에서는 변환을 실행하지 않아요. 후보 만료와 이력 보존은 [자료 상태 업데이트](PACKAGE-BEHAVIOR.md#자료-상태-업데이트)를 따라요.

## Host API로 자기 자료 읽기

행동의 `program.capabilities: ["materials.read.self"]`를 선언하면 `await api.host.call(method, args)`로 자기 패키지의 본문·인물 설명·로어를 조회할 수 있어요. 편집기의 **자기 자료 읽기** 선택과 **자료 읽기 예제 넣기**가 이 선언을 사용해요. 생략하거나 빈 배열이면 읽기를 허용하지 않아요. 이 선언은 자기 자료에 한정된 기능 요청이며, 다른 자료나 외부 통신 권한을 자동 승인하는 설치 정책이 아니에요. `source`는 이제 비동기 함수 본문이며 기존 동기 계산도 그대로 반환할 수 있어요.

```js
const page = await api.host.call('materials.list', {limit: 5});
const first = page.items[0];
const material = first
  ? await api.host.call('materials.read', {id: first.id, limit: 120})
  : null;
return {state: api.state, result: {preview: material?.text ?? ''}};
```

| 메서드 | 인자 | 반환 |
| --- | --- | --- |
| `materials.list` | `offset` 기본 0, `limit` 기본 20·최대 50 | `items`와 `nextOffset`(끝이면 null) |
| `materials.read` | 목록에서 얻은 `id`, `offset` 기본 0, `limit` 기본 8000·최대 16000 | 항목 정보와 `text`, `offset`, `nextOffset` |

항목 정보는 `id/title/description/kind/revision/contentHash/totalChars`예요. 제목은 256자, 설명은 512자까지인 목록용 요약이며 본문은 조각 읽기로 보존해요. `revision`은 패키지 개정, `contentHash`는 실제 읽을 전체 텍스트의 SHA-256이에요. 목록 offset은 항목 수, 본문 offset·limit은 UTF-16 문자 단위예요. 다음 조각은 반환한 `nextOffset`을 사용해요. 필요하다면 코드에서 목록을 분류·검색하고 읽을 항목을 선택해요. 자료별 선택 알고리즘은 호스트에 추가하지 않아요.

호스트는 실행을 시작할 때 장착 인스턴스와 자료 버전을 고정해요. 생성 전/모델 행동은 예약된 Run profile을, 사용자 버튼은 클릭 시점의 유효 profile을 사용해요. 본문·로어의 이름/옵션/공유 변수 템플릿과 채팅별 로어 변경은 기존 자료 투영 경로를 재사용해요. 같은 계산에서 임시 저장한 공유 변수는 이후 자기 자료 읽기에도 반영해요. 템플릿이 제한을 넘으면 기존 경로와 같이 원래 글을 사용해요. 모델 입력에 이 읽기를 자동 삽입하지 않으며 필요한 결과를 코드가 반환해요.

코드가 chatId·다른 packageId·경로를 지정할 인자는 없어요. 다른 자료의 ID와 존재하지 않는 ID는 같은 오류로 거절해요. 연결된 모듈은 별도 패키지이므로 자기 자료 읽기 범위에 포함하지 않아요. 공유 자료/의존성의 추가 읽기 범위는 후속 권한 계약으로 확장해요. 요청마다 현재 작업 소유권을 재확인하고 취소·충돌 뒤에는 읽기와 결과 채택을 닫아요.

요청은 Worker 메시지의 제한된 JSON으로 전달하고 실제 작업은 게스트 밖의 호스트가 수행해요. 호출당 요청/응답 128 KiB, 한 계산에서 32회·동시 대기 8회·응답 합계 512 KiB를 제한해요. 호스트 대기는 게스트 CPU 예산에 합산하지 않지만 전체 실행 시간 제한 안에 있어요. 권한 거절 등 예상 가능한 오류는 알려진 `error.code`만 코드에 전달하고 서버 오류 원문·스택은 전달하지 않아요. 코드가 처리하지 않은 오류는 일반 프로그램 실패예요. 소유권 충돌·DB 오류는 게스트에서 잡아 성공으로 바꿀 수 없으며 원래 호스트 오류 처리 경로로 돌아가요. `model.generate`는 아래 모델 호출 경계에서 현재 연결하지만, 일반 HTTP와 그 밖의 통신 메서드는 연결하지 않았어요.

프로그램 지문에는 capability 선언도 포함돼요. 읽기는 고정 profile의 자기 자료만 투영하며 별도 읽기 로그/본문 사본을 DB에 추가하지 않아요. 기존 영수증과 Run snapshot을 보존하고 복원 때는 읽기나 코드를 재실행하지 않아요. 영수증 검증은 승인된 상태/결과의 보존 확인이며 코드의 계산을 재평가한 증거가 아니에요.

## Host API로 분기 공유 변수 읽기와 쓰기

`program.capabilities`의 `variables.read`는 `variables.list/read`, `variables.write`는 `variables.set/delete`를 요청해요. 읽기와 쓰기는 별도 선언이에요. 쓰려면 사용자가 채팅에 장착한 자료의 **공유 변수 변경 허용**을 켜야 하며, 정확한 자료 개정에 대한 예약 당시 grant와 최신 grant가 모두 유효해야 해요. 모델 호출 허용과 별개이며 일반 상태 변환 `migration`에는 이 Host 권한을 주지 않아요. Risu Lua의 변수 함수도 이 경로를 사용해요.

| 메서드 | 인자 | 반환 |
| --- | --- | --- |
| `variables.list` | `offset` 기본 0, `limit` 기본 20·최대 50 | 키순 `items[{key,totalChars,overridden}]`, `nextOffset`, `total` |
| `variables.read` | `key`, `offset` 기본 0, `limit` 기본 8000·최대 16000 | `{value,offset,nextOffset,totalChars,overridden}`; 없는 키의 `value`는 null. `overridden`은 자료 기본값과 별도로 저장된 값이 있는지 표시 |
| `variables.set` | `key`, 문자열 `value` | null; 이번 계산의 override 변경을 임시 보관 |
| `variables.delete` | `key` | null; 이번 계산에서 override를 제거 |

읽기의 offset·limit은 UTF-16 문자 단위이며 `nextOffset`이 null이면 끝이에요. 빈 문자열은 없는 키와 구분해요. 삭제하면 자료·프롬프트의 읽기 기본값이 다시 적용돼요. 봇·모듈·프리셋의 우선순위와 문자열 한도는 [분기 공유 변수](PROMPT-RUNTIME.md#분기-공유-변수)를 공유하고 기존 Host 호출 수·프레임·응답 크기 한도도 유지해요. 호출자가 chatId·branchId·다른 저장 경로를 지정할 수 없어요.

변경은 Guest 실행 중 메모리에만 쌓이며 같은 계산의 후속 변수 조회와 자기 자료 템플릿 읽기에 적용돼요. Guest 반환값은 계속 `{state,result}`예요. Host가 별도로 `program.variables?: {beforeRevision,beforeHash,changes}` 영수증을 만들고 `changes`의 null은 override 삭제를 뜻해요. 읽기만 한 경우에도 빈 changes로 읽은 상태의 의존성을 기록해요. Guest가 이 영수증을 반환해 권한이나 저장 경계를 대신할 수 없어요.

사용자 행동은 패키지 상태·공유 변수·후속 요청 예약을 같은 transaction에서 채택해요. 생성 전/모델 행동의 공유 변경은 전체 실행 순서대로 source 완료 transaction에 채택해요. 응답 후에는 앞 단계의 성공값을 시작으로 패키지 순서대로 계산하고, 성공한 패키지의 임시 변경만 다음 패키지에 전달해요. 실패한 패키지는 자기 변경을 폐기해요. source 채택 시 앞 패키지가 실패해 뒤 패키지의 의존 상태가 달라졌다면 뒤 결과도 CAS로 거절하며 본문과 이미 성공한 준비 결과는 유지해요.

원래 Run snapshot은 바꾸지 않아요. 파생 profile의 공유 상태가 이후 행동·생성 전 지침·자료 읽기에 적용되며 이미 주 모델에 전송한 프롬프트를 자동으로 다시 작성하지 않아요. 취소·skip·권한 철회·상태 충돌은 늦은 채택을 차단하고, 실패한 외부 작업을 재시작·복원에서 자동 재전송하지 않아요. 과거 영수증에는 변수 필드를 추가하지 않으며 새 영수증도 백업·포크·복원에서 보관과 의존성만 검증하고 코드를 재실행하지 않아요. 이 공통 Host 지원은 가져온 특정 자료의 전체 trigger/Lua 실행 완료를 의미하지 않아요.

## Host API로 현재 분기 대화 읽기

행동이 `program.capabilities: ['conversation.read']`를 선언하고 사용자가 채팅에서 그 자료의 정확한 현재 개정에 **대화 읽기 허용**을 켜면, 코드가 현재 선택 분기에서 사용자가 볼 수 있는 대화를 읽을 수 있어요. 모델 전송용 문맥 절삭·요약과는 별도 범위라 Reader에서 펼칠 수 있는 접힌 원문도 포함해요. 다른 채팅·다른 분기·삭제되거나 새 요청으로 대체된 기록은 포함하지 않으며 앱 설정·연결 설정의 API 키·모델 입력·진단도 제공하지 않아요. 사용자가 대화 본문에 직접 쓴 문자열은 다른 메시지 내용과 같은 원문으로 취급해요.

| 메서드 | 인자 | 반환 |
| --- | --- | --- |
| `conversation.list` | `offset` 기본 0, `limit` 기본 20·최대 50 | `items[{index,role,totalChars}]`, `nextOffset`, `total` |
| `conversation.read` | `index`, `offset` 기본 0, `limit` 기본 8000·최대 16000 | 한 메시지의 `{index,role,text,offset,nextOffset,totalChars}` |
| `conversation.page` | `index`·`offset` 기본 0, `limit` 기본·최대 16000 | 여러 메시지의 연속 조각 `items`, 다음 `{index,offset}` 또는 null, `total` |

호출자가 chatId·branchId·runId·source ID를 인자로 고를 수 없어요. 생성 전과 모델 행동에는 예약된 현재 요청을 마지막 사용자 메시지로 덧붙이고, 응답 후에는 같은 요청과 방금 완성된 응답을 덧붙여요. 사용자 버튼은 클릭 때 이미 보이는 대화만 사용해요. 대화 참조가 고정되지 않은 경우 실행 시점의 현재 DB를 다시 읽어 보충하지 않으며, 고정된 빈 대화는 정상적인 빈 목록이에요.

Run과 영구 사용자 작업에는 본문 대신 run/source hash 참조를 고정해요. Host는 그 참조가 가리키는 정확한 본문만 해석하고, 실제로 대화를 읽은 계산에는 `program.conversation: {viewHash}`를 Host 전용 영수증으로 남겨요. 실행 시작 때의 grant와 채택 직전 최신 grant·자료 개정·분기/원문 소유권을 모두 확인하므로 허용 철회나 문맥 변경 뒤 늦은 상태·변수 결과는 반영하지 않아요. fork·전체 archive·채팅 백업은 참조와 영수증을 ID에 맞게 보존·검증하며 복원에서 대화 읽기나 코드를 실행하지 않아요. 채팅 백업으로 만든 새 채팅의 live grant는 다른 확장 grant와 같이 제거해 다시 허용하게 해요.

대화 읽기를 허용받은 자동 행동이 있으면 판정 기회는 고정한 대화의 역할/본문 hash와 현재 요청 hash도 포함해요. 요청이나 사용자에게 보이는 실패 기록이 달라지면 선언 순서와 의존성을 유지하기 위해 같은 자동 행동 묶음을 다시 계산하며, 그 묶음의 대화를 읽지 않는 행동도 함께 실행될 수 있어요. 기존 추첨의 원래 entropy는 보존하므로 같은 상태의 draw seed는 바뀌지 않아요. 입력 단계(`hook: 'input'`·`'edit-input'`)가 있으면 대화 읽기 grant와 무관하게 요청 hash도 구분해요. 입력 단계와 대화 읽기 선언·grant가 모두 없으면 기존 source/state 기반 캐시를 유지해요.

## 생성 전 자동 준비

기존 `before-turn` 행동 중 코드가 하나라도 있으면 해당 Run의 **모든 자동 행동**을 예약 후에 처리해요. 입력 단계(`hook: 'input'`) → 입력 편집 단계(`hook: 'edit-input'`) → 일반 시작 단계 → 전송문 편집 단계(`hook: 'edit-request'`) 순으로 실행하고 각 단계 안에서는 자료 장착과 행동의 선언 순서를 유지해요. 두 입력 단계의 대화 읽기는 이번 요청을 제외하고 시작 단계부터 포함하며, 선언형 계산과 코드는 앞선 임시 상태를 이어받아요. 코드가 없는 기존 자동 행동의 예약 방식은 유지해요.

### 전송 사본을 바꾸는 편집 단계

`hook: 'edit-input'`·`'edit-request'` 행동은 코드를 요구하고 `automaticInput`을 선언하지 않아요. 입력은 Host가 소유하는 고정 schema예요. 입력 편집은 `{value, meta:{index}}`로 앞선 편집 결과를 이어받은 현재 요청과 아직 저장 위치가 없다는 뜻의 `index: -1`을 받고, 결과는 100,000자 이하의 문자열이어야 해요. 전송문 편집은 `{value: [{role, content}], meta: {}}`로 전송용 원문 대화와 이번 요청을 받아요. 메시지 1,000개·메시지당 100,000자·합계 100,000자 안에서만 전달하며 결과는 같은 개수·같은 역할이어야 하고 본문만 바뀔 수 있어요. 다른 값이면 자동 준비 묶음의 실패로 처리해요. 두 단계의 결과는 모델 문맥의 `automaticResults`에 넣지 않아요.

전송문 편집은 대화 본문을 그대로 넘기므로 `conversation.read` 선언과 그 채팅·자료 개정의 대화 읽기 허용을 함께 요구해요. 허용이 없거나 대화가 위 한도를 넘으면 그 행동만 건너뛰고 편집 없이 진행하며 Reader의 안내로 알려요. 시스템 프롬프트·로어·다른 자료의 지침·프롬프트 프리셋은 넘기지 않아요.

채택한 편집은 예약 Run snapshot을 바꾸지 않고 준비 영수증에서 파생한 전송 전용 투영으로만 남아요. 저장한 요청 원문·본문·hash·편집/재요청 기준·대화 읽기 Host의 본문은 그대로이며, 프롬프트의 대화·현재 요청 메시지·문맥 크기 계산·실제 전송·후보·포크·복원이 같은 투영을 사용해요. 문맥이 줄어든 전송에서도 원래 메시지 index를 유지해요. 프리셋 전송 정규식은 이 편집 결과를 입력으로 받고, Reader의 요청 항목은 원문과 전송문을 함께 보여줘요. 예산 계산이나 프롬프트 미리보기는 제작자 코드를 실행하지 않으므로 저장된 원문을 그대로 보여줘요. 실패·건너뛰기·취소는 편집을 적용하지 않고 원래 요청으로 계속해요.

예약에는 자료/코드·입력·기본 상태와 `deferredAutomatic:true`를 고정해요. `package_behavior_runs`의 별도 preparation 기록이 `pending → running → ready/failed/skipped` 진행과 결과를 소유해요. 별도 DB 표나 자료별 실행기는 추가하지 않아요. 계산은 transaction 밖에서 수행하고 준비 결과 전체가 ready일 때만 이번 모델 입력에 투영해요. 현재 상태의 게시 시점은 모델 행동과 같이 성공 원문 저장 때예요.

실행 순서는 기존 상태 대기 완료 → 자료 자동 준비 → 로어/문맥 선택과 예산 계산 → 본문 생성이에요. 준비 중인 기본 상태로 프롬프트를 미리 확정하지 않아요. 예약한 요청·자료·기본 상태는 유지하며, 실제 적용한 상태는 progress와 전송 입력에 남겨요. 문맥 계획/컴파일 결과를 저장할 때도 예약 상태와 실행 결과를 섞지 않아요. 후보는 이미 확정한 준비 결과를 재사용해요.

작업 상세에서 **자료 자동 준비 건너뛰기**를 누를 수 있어요. 기존 **상태 준비 건너뛰기**와 대상이 달라요. 정상 준비는 기다리고, 실행 슬롯이 차면 제한된 대기열에서 기다려요. 실패·건너뛰기는 자동 준비 묶음의 부분 결과를 적용하지 않고 해당 자료의 상태 행동을 이번 요청에서 제외해요. 독립된 모델 전용 행동은 유지해요. 이미 계산한 판정 영수증은 보존하지만 뒤늦은 결과는 현재 상태나 확정 입력을 바꾸지 않아요.

진행 수는 조건이 false라 실행하지 않은 선언도 처리한 항목으로 세요. 취소·서버 중단 뒤 준비를 자동 재실행하지 않으며, 진행 중이던 기록과 Run의 종료 상태를 함께 표시해요. 포크·백업은 준비 상태와 채택된 영수증을 보존하고 코드를 재실행하지 않아요. 복원은 채택된 입력/호스트 조건·선언 순서·상태 연결을 검사하며, 복사된 분기의 새 ID로 과거에 생략한 조건을 재판정하지 않아요.

저장된 프롬프트의 복원 검사는 예약 기본 상태에 준비 영수증의 적용 결과를 투영해 당시 입력과 대조해요. 이때도 예약 snapshot은 바꾸지 않고 자동 준비 코드를 다시 실행하지 않아요.

## 응답 후 코드 처리

본문 모델의 완성 응답은 후처리를 기다리기 전에 기존 `runs.partial_text`에 그대로 보존해요. 이 보존은 원문·상태·사용량의 확정이 아니며 새 표나 schema를 추가하지 않아요. 전체 취소·서버 중단·치명적인 Host 오류 뒤에도 받은 출력은 남고, 종료된 작업 상세에서 읽거나 복사할 수 있어요. 진행 중에는 이 보존본을 표시하지 않으며, 원문 저장이 성공하면 같은 transaction에서 중복 보존본을 비워요. 보존본을 자동으로 원문에 합류시키거나 처리를 재실행하지 않아요.

사용량은 정산 전까지 DB에서 NULL로 유지해요. 정산 없이 중단된 Run의 호출 수는 전송 전 기록한 attempt를 기준으로 확장·문맥 호출을 포함하고 별도 제목·보조 작업은 제외해요. 확인되지 않은 토큰·비용은 null로 남아요.

행동의 `triggers: ['after-turn']`과 schema에 맞는 `automaticInput`을 지정하면 본문 모델의 성공 응답을 받은 뒤 코드를 실행해요. `hook: 'edit-output'`과 `'edit-display'`는 같은 응답 후 단계의 Host 소유 편집 단계로, 편집 → 일반 응답 후 → 표시 편집 순서로 실행하며 `{value, meta:{index}}`에 이어받은 텍스트와 이 응답의 대화 위치를 받아요. 결과는 100,000자 이하의 문자열이어야 하고 다른 값이면 그 자료의 응답 후 묶음 실패로 처리해요.

편집 결과는 저장 원문이 아니라 **이 응답의 표시 사본**이에요. 저장한 본문·hash·다음 턴의 문맥·대화 읽기·`response.read.current`는 원래 응답을 유지하고, 표시는 영수증에서 파생해 Reader가 읽어요. 실패한 자료의 편집은 적용하지 않고 성공한 자료의 결과만 순서대로 이어져요. 읽기·새로고침·분기·복원은 저장한 결과만 읽고 코드를 다시 실행하지 않으며, 원문 편집으로 응답 hash가 달라지면 표시 사본도 사라져요. 첫 범위는 코드 행동이며 선언형 효과·추첨은 섞지 않아요. 같은 행동을 사용자/모델/생성 전에도 허용할 수 있지만 응답 읽기는 `after-turn` 호출에서만 제공해요. 코드 예제의 자료별 계산은 제작자가 바꾸고 별도 자료 전용 서버 함수를 만들지 않아요.

`program.capabilities: ['response.read.current']`를 선언하면 `api.host.call('response.read', {offset, limit})`로 이번 완성 응답을 읽어요. offset은 기본 0, limit은 기본 8,000·최대 16,000 UTF-16 문자이며 반환값은 `{text, offset, nextOffset, totalChars, contentHash}`예요. 반환한 `nextOffset`으로 다음 조각을 읽고 끝이면 null이에요. 원문 전체를 Worker 입력/영수증에 중복 저장하지 않아요. `contentHash`는 실제 저장할 본문 텍스트의 SHA-256이고, 다른 채팅·과거 원문·경로·키를 지정할 인자는 없어요. 게스트의 일반 호출·프레임 한도도 유지해요.

```js
const response = await api.host.call('response.read', {limit: 4000});
return {
  state: {...api.state, count: api.state.count + 1},
  result: {observedChars: response.text.length, hasMore: response.nextOffset !== null}
};
```

입력 상태는 생성 전/모델 행동과 기존 출력 파서를 적용한 뒤의 상태예요. 출력 파서의 사전 계산과 저장은 같은 순수 함수를 사용해요. 한 자료 안의 후처리 행동은 선언 순서대로 자기 임시 상태를 이어받고, 다른 자료는 파서 적용 시점의 고정 상태를 참고해요. 코드는 transaction 밖의 제한된 Worker에서 계산하며, source transaction에서는 기록된 코드/상태 영수증과 현재 상태·원문 귀속을 다시 검사해 채택해요. 본문 텍스트는 바꾸지 않아요.

코드 오류·시간/메모리/출력 제한은 그 자료 후처리 묶음을 적용하지 않는 실패로 남기고 다른 자료와 원문 저장을 계속해요. 이미 성공한 생성 전/모델 행동·출력 파서의 상태는 보존해요. 기존 authoritative 출력 파서가 실패하면 기존 실패 계약을 따르며 후처리로 이를 성공으로 덮지 않아요. 정상 계산은 기다리고, 로컬 코드 묶음의 10초 상한에 모델 설정에 따른 Host 대기 예산(최대 30분)을 별도로 반영해요. 전체 Run 취소·원문 소유권 상실은 결과 채택을 닫고, DB 오류는 코드 실패로 숨기지 않아요. 후처리 진행 정보에는 진행 수와 실패 사실을 표시해요.

후처리는 `RunBehaviorProgress.afterResponse`에 Run·응답 hash별로 보관해요. 모델 입력 시점의 `entries/states`와 같은 판정 기회 캐시에 섞지 않아요. 후보는 자신의 새 응답으로 후처리를 다시 계산하고, 포크·백업 복원은 기록된 결과를 보존하며 코드를 실행하지 않아요. 중단된 처리를 재시작 시 자동 재생하지 않아요. 후처리 Host는 자기 자료·이번 응답·공유 변수·허용된 현재 분기 대화를 읽고 명시 허용된 `variables.write`·`model.generate`를 제공하며 HTTP 호출은 후속 범위예요.

후처리의 모델 호출도 전역 `extensionModel`과 정확한 자료 개정의 채팅별 grant를 사용해요. 이미 본문 호출이 끝났으므로 별도 본문 호출을 예약하지 않고 Run의 남은 호출 한도만 사용해요. 사용량·가격·전송 전 attempt는 본문과 합산하고 attempt에는 `trigger: 'after-turn'` 귀속을 남겨요. 사용자 버튼은 아래의 영구 작업 경로에서 같은 모델 Host API를 사용해요.

작업 상세의 **응답 후 처리 건너뛰기**는 후처리 전체의 상태 채택을 즉시 닫아요. 이미 계산한 일부 결과도 현재 상태에 게시하지 않고 영수증만 보존해요. 진행 중인 Host 호출의 취소·정산이 끝나면 같은 요청의 완성 본문을 그대로 저장해요. 전체 Run 취소와 대상이 다르며, 중복 명령은 원래 결과를 돌려주고 다른 분기/부모 원문의 명령은 거절해요. 최신 grant 철회나 원문 소유권 상실 후 새 호출·늦은 상태 반영을 막아요. 건너뛰기/취소 중 발생한 DB·정산 오류는 부가 실패로 숨기지 않아요.

영수증은 패키지당 100개 행동·100만 문자로 제한하고 기존 Run journal의 합산 한도도 지켜요. 합산 한도를 넘으면 후처리 기록만 제외하고 기존 생성 전/모델 행동의 기록은 보존해요. 이 제외를 기존 작업 이벤트와 화면의 미적용 안내로 남기며 같은 Run에서 코드를 다시 실행하지 않아요.

## 모델 호출과 상태 저장

### 모델 호출 Host API와 명시 권한

`program.capabilities: ['model.generate']`는 자료 제작자가 요청하는 capability일 뿐이에요. 행동이 해당 호출 방법(`user`, `model`, `before-turn`, `after-turn`)을 허용하고, 전역 역할 모델 설정의 `extensionModel`이 선택되어 있어야 하며, 채팅 profile에 `extensionGrants[packageInstanceId] = {packageRevision, capabilities: ['model.generate']}`가 있어야 호출할 수 있어요. `before-turn`은 예약된 `deferredAutomatic` 실행의 준비 중에만 허용해요. 전역 `extensionModel`의 기본값은 `null`이고, 이 모델은 확장 행동의 추가 생성에만 사용해요. 예약할 때 모델·연결·자료 source/revision·허용을 Run에 고정하고 실행 중 전역 설정을 다시 읽지 않지만, 매 호출과 결과 채택에서 최신 grant·connection·소유권을 다시 확인해요.

허용은 정확히 장착한 자료 revision에 묶여요. 자료가 새 revision이 되면 예전 grant를 자동 승계하지 않으며, 사용자가 허용을 철회하면 새 호출을 막고 이미 끝난 늦은 결과도 채택하지 않아요. 자료 native transfer는 확장 grant를 옮기지 않아요. 순수 코드 행동에는 모델 선택이나 추가 호출 허용이 필요하지 않아요.

코드는 `await api.host.call('model.generate', {prompt})`만 요청할 수 있어요. `prompt`는 비어 있지 않은 문자열이고 최대 16,000자예요. 모델 ID·키·endpoint·옵션은 게스트가 지정할 수 없고, 예약된 확장 호출 모델의 generation·context budget·pricing snapshot을 호스트가 사용해요. 출력 토큰 한도도 선택한 모델 설정을 따르며 코드에서 늘릴 수 없어요. 반환값은 `status`, `text`, `truncated`, `error` 필드이며 `text`는 최대 6,000자예요.

Run에 속한 추가 호출은 Run 전체 `maxCalls`를 공유해요. 생성 전/본문 행동은 마지막 본문(main) 호출 한 번을 남기고, 응답 후 처리는 이미 본문 호출을 마쳤으므로 남은 한도만 사용해요. 이 단계는 호스트가 지정하며 게스트가 바꿀 수 없어요. 동시에 여러 호출해도 pending 예약을 함께 세어 한도를 지켜요. 확장 호출을 자동 재시도하거나 임의 도구를 제공하지 않아요. 전송 전에 `role: 'state'`와 `extensionAction` 자료 귀속을 포함한 attempt를 기록하고, 사용량과 가격 snapshot은 기존 모델 실행 경로로 보존해요. 확장 결과는 행동 결과·opportunity/progress·영수증으로 보존하며 원문은 기존 main 호출만 저장해요. 복원에서는 모델이나 코드를 재실행하지 않아요.

자동 준비의 attempt는 `extensionAction.trigger: 'before-turn'`으로 구분하고 기존 모델 행동의 영수증 형식은 유지해요. 준비에서 사용한 호출·토큰·비용은 뒤의 문맥 정리·본문과 합산해요. 문맥 정리는 이미 사용한 준비 호출을 제외한 남은 한도를 사용하며 자기 `summaryCalls`에는 요약 호출만 기록해요. 준비를 건너뛰면 결과 채택은 즉시 닫고 이미 전송한 호출의 취소·사용량 정산 후 같은 본문 요청을 계속해요. 후보가 완료된 준비 결과를 재사용할 때는 모델을 재호출하거나 원래 준비 사용량을 다시 더하지 않아요.

모델·프로바이더·권한 거절은 알려진 부가 행동 실패로 전달해 본문을 이어갈 수 있어요. DB 오류와 원문 소유권 오류는 부가 실패로 숨기지 않고 치명적인 호스트 오류로 처리해요. 모델 호출을 기다리는 실행이 취소되면 caller는 `awaitHostSettlement` 경계에서 전송 전 attempt 정산이 끝날 때까지 기다린 뒤 돌아오며, 철회되거나 늦은 결과가 상태를 바꾸지 않아요.

모델은 허용된 코드 행동을 기존 `behavior_*` 도구로 발견하고 입력을 정해 호출해요. 모델 호출 행동의 코드는 자기 상태와 행동 입력만 받고, 필요한 추가 생성은 위의 `model.generate` Host API를 통해서만 요청해요. 코드 원문이나 서버 객체를 모델 도구 정의에 넣지 않아요. 실행 API는 버튼과 같으며 입력은 해당 실행의 임시 상태에서 읽어요. 연속된 서로 다른 행동은 앞서 성공한 임시 상태를 이어받아요. 원래 `Run.request`와 `snapshot.request`, 예약된 입력 snapshot은 바꾸지 않아요.

코드 계산과 DB 저장은 분리해요. 시작 전에 고정된 자료/행동 권한과 소유권을 확인하고 transaction 밖에서 계산한 뒤, Run·분기/원문 의존성과 실행 중 상태 개정이 맞을 때만 기존 opportunity/progress journal에 결과를 채택해요. 같은 행동/입력의 동시 호출은 한 번 계산하고 각 호출 ID로 응답해요. 반복 호출은 기록된 결과를 사용하며 같은 판정 기회의 다른 입력은 거절해요.

이 결과는 **본문이 성공적으로 저장될 때** 현재 상태로 게시해요. 취소·본문 실패에서는 현재 상태를 바꾸지 않아요. 코드 오류·출력/시간/메모리 제한은 안전한 실패 코드로 모델에 전달하고 해당 도구 없이 본문 생성을 이어가요. 원문 소유권 충돌과 DB 오류는 코드 실패로 숨기지 않아요. 다음 실행의 프롬프트는 게시된 상태를 사용하며, 실행 중인 모델은 반환된 도구 결과를 참고해요.

## 권한과 실행

버튼 실행은 이 자료의 상태/입력 읽기와 반환한 상태의 반영을 요청하는 동작이에요. 선택한 capability와 채팅별 grant에 따라 자기 자료나 현재 분기 대화를 읽을 수 있지만 다른 자료·키·환경변수·DB 객체·앱 DOM을 받지 않아요. ID나 권한을 결과에 추가해도 권한이 늘어나지 않아요. 파일·일반 HTTP·동적 모듈 import는 연결하지 않았어요. `model.generate`와 `conversation.read`는 사용자 버튼·생성 전·응답 후 자동 처리와 모델이 호출한 행동에서 같은 공통 실행 경계를 사용해요.

사용자 버튼에서는 호스트가 현재 장착 자료와 행동·패널 허용 목록, 입력·상태 개정·원문 의존성을 확인한 뒤 transaction 밖에서 계산해요. 계산이 끝나면 자료/프로필·분기/원문·상태와 진행 중 Run을 다시 확인하고, 같은 경계에서 결과 검사와 journal 저장을 수행해요. 계산 중 다른 작업이 바뀌면 늦은 결과는 반영하지 않아요. 같은 명령 키의 동시 실행은 합치고, 이미 저장된 명령은 원래 영수증을 반환해요. 같은 키의 다른 명령은 충돌이에요.

무한 계산·메모리/출력 초과·잘못된 결과·취소는 해당 행동을 실패시켜요. 기존 상태·원문은 유지하며 새 채팅 요청을 막는 실패 상태를 만들지 않아요. 실제 DB 저장 실패를 성공으로 숨기지는 않아요. 모델 capability가 없는 동기 버튼 요청의 HTTP 연결 종료 또는 Run 취소는 해당 계산을 취소하고, 종료 후 결과를 채택하지 않아요. 영구 사용자 작업은 아래의 명시적 취소 경계를 따라요.

## 사용자 버튼의 영구 작업

기본 버튼과 커스텀 패널은 기존 actions endpoint를 그대로 사용해요. `user` 행동의 프로그램이 `model.generate` 또는 `conversation.read` capability를 선언하면 서버가 영구 작업으로 접수하고 `{operationId}`를 반환해요. 클릭 시점의 자료·입력·상태·프로필과 필요한 모델 설정·대화 참조를 고정하며 별도 본문 Run이나 가짜 본문 snapshot을 만들지 않아요. 브라우저 이동이나 HTTP 연결 종료 뒤에도 서버 작업은 유지돼요.

`server/extension-operation-runner.ts`는 모델 호출과 대화 읽기 모두 `executePackageExtensionProgram`의 공통 Host 경계를 사용해요. 실제 모델 호출에는 전역 `extensionModel`과 정확한 자료 source/revision의 grant가 필요하고, 대화 읽기에는 별도의 정확한 자료 개정 grant가 필요해요. capability 선언만으로 모델 호출이 필수인 것은 아니에요. 호출 전 최신 권한·연결·소유권을 확인하고 모델 전송에는 기존 product attempt에 `trigger: 'user'`를 기록해요. 작업에 고정한 `maxCalls`를 사용하며 본문 호출 몫을 예약하지 않아요. 전송된 호출의 사용량은 해당 작업에 귀속하고 미정산 토큰·비용은 `null`로 표시해요.

완성 상태는 기존 `performBehaviorAction`의 schema·CAS 검사와 `ui-action` journal로만 채택하며 작업 완료와 한 transaction으로 저장해요. 계산 중 현재 자료·프로필·분기·원문·상태가 달라지거나 본문 실행과 충돌하면 늦은 상태를 반영하지 않아요. 본문은 계속 진행할 수 있고 원문을 이 작업의 결과로 바꾸지 않아요. 계산은 끝났지만 채택에 실패한 결과는 **상태에 미반영**으로 보존해요. 이 기록은 새 상태 schema에 맞지 않을 수도 있으므로 제한된 계산 영수증의 무결성과 실제 상태 채택 검증을 구분해요.

기존 자료 패널과 작업 활동의 **자료 코드 작업**에서 진행 상태·호출 수·명시적 취소와 **계산 결과 보기**를 제공해요. 목록은 결과 유무와 metadata만 반환하며 결과는 `GET /api/chats/:id/extension-operations/:operationId?includeResult=1`로 명시적으로 조회해요. 취소는 `/cancel`에 POST하고 늦은 채택을 닫은 뒤 전송된 attempt를 정산해요. 서버 재시작·복원은 queued/running을 interrupted로 보존하고 자동 재실행하지 않아요. 같은 명령 키는 취소·실패·중단을 포함한 원래 작업을 반환하고, 사용자가 새로 실행한 행동은 새 키를 사용해요.

DB v18의 작업·attempt 연결 표와 archive15/chat-backup1의 선택적 collection에 기록을 보존해요. 과거 백업의 collection 누락은 빈 목록으로 처리하며 복원에서 코드나 모델을 재호출하지 않아요. 복원한 채팅의 live grant 제거 원칙은 그대로예요.

## 실행 엔진의 경계

모델 Host 연결을 지원하는 네 호출 경로는 `server/package-extension-execution.ts`의 `executePackageExtensionProgram`으로 Host 연결·모델 결과 사용 추적·정산 대기를 공유해요. 성공한 모델 결과를 받은 코드는 계산 완료 뒤에도 모델 접근 가능 여부를 다시 확인해요. 모델 사용 불가를 처리한 로컬 대체 결과에는 성공한 모델 결과의 권한을 요구하지 않아요. 사용자 작업은 재확인 전에 완성 계산을 보관하므로 채택이 거절되어도 미반영 결과를 남겨요. 각 호출자는 진행 상태·건너뛰기·취소·CAS·저장 시점을 계속 소유해요. 짧은 사용자 계산과 순수 상태 변환도 같은 하위 `executeExtensionProgram` 엔진을 사용해요.

새 계산의 영수증 생성은 `server/extension-program-receipt.ts`의 `createExtensionProgramReceipt`를 사용해 프로그램 hash·엔진·출력 한도·상태 schema를 함께 검사해요. 보관 기록의 검증은 같은 계산 검증을 공유하면서 원래 채택 상태와 결과의 일치까지 확인해요. 공통 모델 도구 지침은 행동의 권한·기록·중복 실행 규칙만 정하며 결과를 서사에 어떻게 사용할지는 현재 요청과 자료·프롬프트가 정해요.

JavaScript는 `quickjs-emscripten-core`와 `@jitl/quickjs-wasmfile-release-sync` **0.32.0**, Lua는 `wasmoon` **1.16.0**의 새 WASM 인스턴스를 작업별 Worker에서 실행해요. Lua는 포함된 WASM의 예상 메모리 선언을 검사해 최대치를 고정하며 선언이 달라지면 실행을 거부해요. Lua allocator는 8 MiB로 제한하고 JS 객체 interop를 게스트에 제공하지 않아요. 게스트 코드를 Node의 `eval`·`vm`이나 웹 패널에서 실행하지 않아요. JSON 입력과 크기를 제한한 JSON 결과만 교환해요.

엔진 내부 allocator 한도와 별개로 **16 MiB 고정 WASM 선형 메모리**를 제공해요. 게스트 계산은 CPU 100ms와 active wall 1초, Worker 동시 2슬롯의 기존 제한을 유지해요. 과거 후보 실험에서 실패했던 `setMemoryLimit`만을 격리 근거로 사용하지 않아요. 엔진 계산 중단, 부모의 실행 종료, 입력/출력 상한도 적용해요. 실제 Host 대기에서만 별도의 `hostWaitMs` 예산을 사용하며 최대 1,800,000ms예요. `hostWaitMs`가 생략되거나 0이면 자료 읽기 Host await를 즉시 timeout으로 만들지 않고 기존 전체 wall 1초를 유지해요. 자동 준비의 슬롯 대기는 호스트만 선택하는 제한된 대기열이며 취소하면 제거해요. Worker의 V8 heap 제한은 WASM 메모리와 별도예요. 이 구성은 OS의 전체 RSS 제한이나 모든 엔진 취약점에 대한 보증이 아니에요. Linux/Docker 실제 실행·전체 컨테이너 자원 제한은 5~6단계 검증에 남아 있어요.

소스는 최대 524,288 UTF-16 문자, 결과 `result`는 JSON 8,000자예요. 전체 상태/결과 계약은 JSON 131,072자 이내이며 실행기의 입력/출력 프레임은 **128 KiB UTF-8** 이하라 비ASCII 문자열에는 더 작은 한도가 적용돼요. 제한은 자료가 변경할 수 없어요. 정확한 실행 한도와 오류 코드는 [서버 실행기](../server/extension-runtime.ts)가 소유해요.

실행기 의존성은 MIT이며 Uimori 소스의 AGPL-3.0-only와 개별 제3자 조건은 [제3자 고지](../THIRD_PARTY_NOTICES.md)를 따라요. 메모리 전달 API는 [QuickJS variant API](https://github.com/justjake/quickjs-emscripten), Worker 제한의 범위는 [Node Worker 문서](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html)를 참고해요.

## 보존과 후속 확장

프로그램은 패키지 개정에 속하므로 기존 자료 이동·snapshot·백업에 함께 들어가요. 저장한 행동 영수증에는 API·코드 지문·엔진 식별자·상태/결과와 사용한 대화의 `viewHash`를 보존해요. 모델 호출의 영수증은 opportunity·Run progress·최종 journal 사이에도 결합해요. 일반 채팅 백업으로 새 채팅을 복원할 때는 다른 사람의 백업이 목적지에서 모델 호출이나 대화 읽기 권한을 자동으로 주지 않도록 live profile의 `extensionGrants`를 제거하고, 사용자가 그 채팅에서 다시 허용하게 해요. source/grant 이력과 대화 참조는 과거 Run snapshot·영구 작업·attempt 귀속 영수증에 보존해 복원 검증에 사용해요. 같은 workspace 안의 fork는 기존 허가를 보존하고, 자료 native transfer는 grant를 처음부터 만들지 않아요. 전체 DB archive는 전역 연결을 disabled·비밀 제거하는 기존 복구 경계를 따르며 이 계약에서 별도 grant 삭제를 추가하지 않아요. 커밋·포크·복원은 고정한 source/revision·입력 schema·호스트 조건과 영수증·저장 결과의 일치를 확인하며 코드를 다시 실행하지 않아요. 이것은 승인된 결과의 보존이며 복원 때 계산의 의미를 재평가했다는 증거가 아니에요. 공유용 진단에는 이 코드나 입력/출력을 자동 포함하지 않아요.

엔진 실행, `uimori-state-action-v1` 입력 계약, 상태 저장 호스트는 별도 모듈이에요. 자동 준비와 모델 행동은 `server/package-behavior-run.ts`에서 행동 해석·영수증·효과 채택과 공통 Host를 공유해요. 응답 후 코드는 `server/package-after-response.ts`가 별도 응답 귀속 영수증으로 같은 Worker·상태 저장 경계를 사용해요. 일반 HTTP, 설치·의존성 권한 관리와 Lua의 입력·요청 편집과 출력·표시 편집 등 미연결 API는 후속 작업이에요. 자료별 함수명을 서버 분기로 옮기지 않아요.
