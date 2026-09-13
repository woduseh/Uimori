# 상태 계산 코드

현재 [베타 계획](../project-plan/BETA-PLAN.md)의 2~3단계 구현이에요. 봇·페르소나·모듈의 사용자 버튼, 생성 전 자동 준비, 모델이 호출하는 행동에 JavaScript 계산을 연결할 수 있어요. `program.capabilities: ['model.generate']`는 제작자가 요청하는 capability이며, 실제 호출에는 전역 `extensionModel` 선택과 채팅별 정확한 자료 개정 권한이 모두 필요해요. 자료별 알고리즘은 코드에 두고 상태 schema·소유권·충돌·저장은 Uimori가 담당해요. Risu/Lua 직접 실행, 일반 HTTP, 게스트가 모델·키·endpoint·옵션을 고르는 권한, 확장 설치 관리 전체를 지원한다는 뜻은 아니에요.

## 제작과 사용

서재의 자료 편집 → **상태와 행동**에서 비어 있는 자료에는 **코드 계산 예제 넣기**를 사용할 수 있어요. 기존 자료는 제작자용 동작 JSON의 action에 `program`을 추가하고 검증·적용한 뒤 저장해요. 기본 행동 폼과 [커스텀 패널](PACKAGE-PANELS.md)의 버튼은 같은 서버 경로를 사용해요. GET·미리보기·자료 저장만으로 코드를 실행하지 않아요.

추가 모델 호출을 사용하는 순서는 간단해요.

1. 설정 → 역할별 모델에서 전역 **확장 호출 모델**을 선택해요. 기본값은 없음이에요.
2. 자료의 행동에서 제작자가 `model` 호출 방법과 `model.generate` capability를 요청해요.
3. 채팅에서 장착한 자료의 **추가 모델 호출 허용**을 켜요. 이 허용은 그 자료의 현재 revision에만 적용돼요.
4. 본문(main) 모델이 해당 행동을 호출하면 코드가 `model.generate`를 사용할 수 있어요.

첫 지원은 모델이 호출한 행동의 추가 생성이에요. 기존 순수 코드 사용자 버튼과 생성 전 자동 준비는 그대로 동작하며, 사용자 버튼이나 `before-turn`에서 추가 모델을 호출하는 기능은 후속 범위예요.

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

호스트는 실행을 시작할 때 장착 인스턴스와 자료 버전을 고정해요. 생성 전/모델 행동은 예약된 Run profile을, 사용자 버튼은 클릭 시점의 유효 profile을 사용해요. 본문·로어의 이름/옵션 템플릿과 채팅별 로어 변경은 기존 자료 투영 경로를 재사용해요. 템플릿이 제한을 넘으면 기존 경로와 같이 원래 글을 사용해요. 모델 입력에 이 읽기를 자동 삽입하지 않으며 필요한 결과를 코드가 반환해요.

코드가 chatId·다른 packageId·경로를 지정할 인자는 없어요. 다른 자료의 ID와 존재하지 않는 ID는 같은 오류로 거절해요. 연결된 모듈은 별도 패키지이므로 자기 자료 읽기 범위에 포함하지 않아요. 공유 자료/의존성의 추가 읽기 범위는 후속 권한 계약으로 확장해요. 요청마다 현재 작업 소유권을 재확인하고 취소·충돌 뒤에는 읽기와 결과 채택을 닫아요.

요청은 Worker 메시지의 제한된 JSON으로 전달하고 실제 작업은 게스트 밖의 호스트가 수행해요. 호출당 요청/응답 128 KiB, 한 계산에서 32회·동시 대기 8회·응답 합계 512 KiB를 제한해요. 호스트 대기는 게스트 CPU 예산에 합산하지 않지만 전체 실행 시간 제한 안에 있어요. 권한 거절 등 예상 가능한 오류는 알려진 `error.code`만 코드에 전달하고 서버 오류 원문·스택은 전달하지 않아요. 코드가 처리하지 않은 오류는 일반 프로그램 실패예요. 소유권 충돌·DB 오류는 게스트에서 잡아 성공으로 바꿀 수 없으며 원래 호스트 오류 처리 경로로 돌아가요. `model.generate`는 아래 모델 호출 경계에서 현재 연결하지만, 일반 HTTP와 그 밖의 통신 메서드는 연결하지 않았어요.

프로그램 지문에는 capability 선언도 포함돼요. 읽기는 고정 profile의 자기 자료만 투영하며 별도 읽기 로그/본문 사본을 DB에 추가하지 않아요. 기존 영수증과 Run snapshot을 보존하고 복원 때는 읽기나 코드를 재실행하지 않아요. 영수증 검증은 승인된 상태/결과의 보존 확인이며 코드의 계산을 재평가한 증거가 아니에요.

## 생성 전 자동 준비

기존 `before-turn` 행동 중 코드가 하나라도 있으면 해당 Run의 **모든 자동 행동**을 예약 후에 처리해요. 자료 장착과 행동의 선언 순서를 유지하므로 선언형 계산과 코드가 앞선 임시 상태를 이어받아요. 코드가 없는 기존 자동 행동의 예약 방식은 유지해요.

예약에는 자료/코드·입력·기본 상태와 `deferredAutomatic:true`를 고정해요. `package_behavior_runs`의 별도 preparation 기록이 `pending → running → ready/failed/skipped` 진행과 결과를 소유해요. 별도 DB 표나 자료별 실행기는 추가하지 않아요. 계산은 transaction 밖에서 수행하고 준비 결과 전체가 ready일 때만 이번 모델 입력에 투영해요. 현재 상태의 게시 시점은 모델 행동과 같이 성공 원문 저장 때예요.

실행 순서는 기존 상태 대기 완료 → 자료 자동 준비 → 로어/문맥 선택과 예산 계산 → 본문 생성이에요. 준비 중인 기본 상태로 프롬프트를 미리 확정하지 않아요. 예약한 요청·자료·기본 상태는 유지하며, 실제 적용한 상태는 progress와 전송 입력에 남겨요. 문맥 계획/컴파일 결과를 저장할 때도 예약 상태와 실행 결과를 섞지 않아요. 후보는 이미 확정한 준비 결과를 재사용해요.

작업 상세에서 **자료 자동 준비 건너뛰기**를 누를 수 있어요. 기존 **상태 준비 건너뛰기**와 대상이 달라요. 정상 준비는 기다리고, 실행 슬롯이 차면 제한된 대기열에서 기다려요. 실패·건너뛰기는 자동 준비 묶음의 부분 결과를 적용하지 않고 해당 자료의 상태 행동을 이번 요청에서 제외해요. 독립된 모델 전용 행동은 유지해요. 이미 계산한 판정 영수증은 보존하지만 뒤늦은 결과는 현재 상태나 확정 입력을 바꾸지 않아요.

진행 수는 조건이 false라 실행하지 않은 선언도 처리한 항목으로 세요. 취소·서버 중단 뒤 준비를 자동 재실행하지 않으며, 진행 중이던 기록과 Run의 종료 상태를 함께 표시해요. 포크·백업은 준비 상태와 채택된 영수증을 보존하고 코드를 재실행하지 않아요. 복원은 채택된 입력/호스트 조건·선언 순서·상태 연결을 검사하며, 복사된 분기의 새 ID로 과거에 생략한 조건을 재판정하지 않아요.

## 모델 호출과 상태 저장

### 모델 호출 Host API와 명시 권한

`program.capabilities: ['model.generate']`는 자료 제작자가 요청하는 capability일 뿐이에요. 행동이 `model` trigger여야 하고, 전역 역할 모델 설정의 `extensionModel`이 선택되어 있어야 하며, 채팅 profile에 `extensionGrants[packageInstanceId] = {packageRevision, capabilities: ['model.generate']}`가 있어야 호출할 수 있어요. 전역 `extensionModel`의 기본값은 `null`이고, 이 모델은 확장 행동의 추가 생성에만 사용해요. 예약할 때 모델·연결·자료 source/revision·허용을 Run에 고정하고 실행 중 전역 설정을 다시 읽지 않지만, 매 호출과 결과 채택에서 최신 grant·connection·소유권을 다시 확인해요.

허용은 정확히 장착한 자료 revision에 묶여요. 자료가 새 revision이 되면 예전 grant를 자동 승계하지 않으며, 사용자가 허용을 철회하면 새 호출을 막고 이미 끝난 늦은 결과도 채택하지 않아요. 자료 native transfer는 확장 grant를 옮기지 않아요. 기존 순수 코드 버튼과 `before-turn` 자동 준비는 추가 모델 호출 없이 유지해요.

코드는 `await api.host.call('model.generate', {prompt})`만 요청할 수 있어요. `prompt`는 비어 있지 않은 문자열이고 최대 16,000자예요. 모델 ID·키·endpoint·옵션은 게스트가 지정할 수 없고, 예약된 확장 호출 모델의 generation·context budget·pricing snapshot을 호스트가 사용해요. 출력 토큰 한도도 선택한 모델 설정을 따르며 코드에서 늘릴 수 없어요. 반환값은 `status`, `text`, `truncated`, `error` 필드이며 `text`는 최대 6,000자예요.

추가 호출은 Run 전체 `maxCalls`를 공유하고 마지막 본문(main) 호출 한 번을 남겨요. 동시에 여러 호출해도 pending 예약을 함께 세어 한도를 지켜요. 확장 호출을 자동 재시도하거나 임의 도구를 제공하지 않아요. 전송 전에 `role: 'state'`와 `extensionAction` 자료 귀속을 포함한 attempt를 기록하고, 사용량과 가격 snapshot은 기존 모델 실행 경로로 보존해요. 확장 결과는 행동 결과·opportunity/progress·영수증으로 보존하며 원문은 기존 main 호출만 저장해요. 복원에서는 모델이나 코드를 재실행하지 않아요.

모델·프로바이더·권한 거절은 알려진 부가 행동 실패로 전달해 본문을 이어갈 수 있어요. DB 오류와 원문 소유권 오류는 부가 실패로 숨기지 않고 치명적인 호스트 오류로 처리해요. 모델 호출을 기다리는 실행이 취소되면 caller는 `awaitHostSettlement` 경계에서 전송 전 attempt 정산이 끝날 때까지 기다린 뒤 돌아오며, 철회되거나 늦은 결과가 상태를 바꾸지 않아요.

모델은 허용된 코드 행동을 기존 `behavior_*` 도구로 발견하고 입력을 정해 호출해요. 모델 호출 행동의 코드는 자기 상태와 행동 입력만 받고, 필요한 추가 생성은 위의 `model.generate` Host API를 통해서만 요청해요. 코드 원문이나 서버 객체를 모델 도구 정의에 넣지 않아요. 실행 API는 버튼과 같으며 입력은 해당 실행의 임시 상태에서 읽어요. 연속된 서로 다른 행동은 앞서 성공한 임시 상태를 이어받아요. 원래 `Run.request`와 `snapshot.request`, 예약된 입력 snapshot은 바꾸지 않아요.

코드 계산과 DB 저장은 분리해요. 시작 전에 고정된 자료/행동 권한과 소유권을 확인하고 transaction 밖에서 계산한 뒤, Run·분기/원문 의존성과 실행 중 상태 개정이 맞을 때만 기존 opportunity/progress journal에 결과를 채택해요. 같은 행동/입력의 동시 호출은 한 번 계산하고 각 호출 ID로 응답해요. 반복 호출은 기록된 결과를 사용하며 같은 판정 기회의 다른 입력은 거절해요.

이 결과는 **본문이 성공적으로 저장될 때** 현재 상태로 게시해요. 취소·본문 실패에서는 현재 상태를 바꾸지 않아요. 코드 오류·출력/시간/메모리 제한은 안전한 실패 코드로 모델에 전달하고 해당 도구 없이 본문 생성을 이어가요. 원문 소유권 충돌과 DB 오류는 코드 실패로 숨기지 않아요. 다음 실행의 프롬프트는 게시된 상태를 사용하며, 실행 중인 모델은 반환된 도구 결과를 참고해요.

## 권한과 실행

버튼 실행은 이 자료의 상태/입력 읽기와 반환한 상태의 반영을 요청하는 동작이에요. 선택한 권한으로 자기 자료를 읽을 수 있지만 채팅 전체·다른 자료·키·환경변수·DB 객체·앱 DOM을 받지 않아요. ID나 권한을 결과에 추가해도 권한이 늘어나지 않아요. 사용자 버튼과 `before-turn`에서의 추가 모델 호출, 파일·일반 HTTP·동적 모듈 import는 연결하지 않았어요. `model.generate`는 모델이 호출한 행동에서만 사용할 수 있어요.

사용자 버튼에서는 호스트가 현재 장착 자료와 행동·패널 허용 목록, 입력·상태 개정·원문 의존성을 확인한 뒤 transaction 밖에서 계산해요. 계산이 끝나면 자료/프로필·분기/원문·상태와 진행 중 Run을 다시 확인하고, 같은 경계에서 결과 검사와 journal 저장을 수행해요. 계산 중 다른 작업이 바뀌면 늦은 결과는 반영하지 않아요. 같은 명령 키의 동시 실행은 합치고, 이미 저장된 명령은 원래 영수증을 반환해요. 같은 키의 다른 명령은 충돌이에요.

무한 계산·메모리/출력 초과·잘못된 결과·취소는 해당 행동을 실패시켜요. 기존 상태·원문은 유지하며 새 채팅 요청을 막는 실패 상태를 만들지 않아요. 실제 DB 저장 실패를 성공으로 숨기지는 않아요. 버튼 요청의 HTTP 연결 종료 또는 Run 취소는 해당 계산을 취소하고, 종료 후 결과를 채택하지 않아요.

## 실행 엔진의 경계

현재 구현은 `quickjs-emscripten-core`와 `@jitl/quickjs-wasmfile-release-sync` **0.32.0**의 새 QuickJS WASM 인스턴스를 작업별 Worker에서 실행해요. 게스트 코드를 Node의 `eval`·`vm`이나 웹 패널에서 실행하지 않아요. JSON 입력과 크기를 제한한 JSON 결과만 교환해요.

엔진 내부 allocator 한도와 별개로 **16 MiB 고정 WASM 선형 메모리**를 제공해요. 게스트 계산은 CPU 100ms와 active wall 1초, Worker 동시 2슬롯의 기존 제한을 유지해요. 과거 후보 실험에서 실패했던 `setMemoryLimit`만을 격리 근거로 사용하지 않아요. 엔진 계산 중단, 부모의 실행 종료, 입력/출력 상한도 적용해요. 실제 Host 대기에서만 별도의 `hostWaitMs` 예산을 사용하며 최대 1,800,000ms예요. `hostWaitMs`가 생략되거나 0이면 자료 읽기 Host await를 즉시 timeout으로 만들지 않고 기존 전체 wall 1초를 유지해요. 자동 준비의 슬롯 대기는 호스트만 선택하는 제한된 대기열이며 취소하면 제거해요. Worker의 V8 heap 제한은 WASM 메모리와 별도예요. 이 구성은 OS의 전체 RSS 제한이나 모든 엔진 취약점에 대한 보증이 아니에요. Linux/Docker 실제 실행·전체 컨테이너 자원 제한은 5~6단계 검증에 남아 있어요.

소스는 최대 65,536 UTF-16 문자, 결과 `result`는 JSON 8,000자예요. 전체 상태/결과 계약은 JSON 131,072자 이내이며 실행기의 입력/출력 프레임은 **128 KiB UTF-8** 이하라 비ASCII 문자열에는 더 작은 한도가 적용돼요. 제한은 자료가 변경할 수 없어요. 정확한 실행 한도와 오류 코드는 [서버 실행기](../server/extension-runtime.ts)가 소유해요.

두 추가 의존성은 MIT이고 기존 프로젝트의 라이선스 미정 정책을 변경하지 않아요. 외부 Risu 원본 코드를 제품에 포함하지 않았어요. 메모리 전달 API는 [QuickJS variant API](https://github.com/justjake/quickjs-emscripten), Worker 제한의 범위는 [Node Worker 문서](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html)를 참고해요.

## 보존과 후속 확장

프로그램은 패키지 개정에 속하므로 기존 자료 이동·snapshot·백업에 함께 들어가요. 저장한 행동 영수증에는 API·코드 지문·엔진 식별자·상태/결과를 보존해요. 모델 호출의 영수증은 opportunity·Run progress·최종 journal 사이에도 결합해요. 일반 채팅 백업으로 새 채팅을 복원할 때는 다른 사람의 백업이 목적지에서 선택한 `extensionModel`에 자동 과금 권한을 주지 않도록 live profile의 `extensionGrants`를 제거하고, 사용자가 그 채팅에서 다시 허용하게 해요. source/grant 이력은 과거 Run snapshot과 attempt 귀속 영수증에 보존해 복원 검증에 사용해요. 같은 workspace 안의 fork는 기존 허가를 보존하고, 자료 native transfer는 grant를 처음부터 만들지 않아요. 전체 DB archive는 전역 연결을 disabled·비밀 제거하는 기존 복구 경계를 따르며 이 계약에서 별도 grant 삭제를 추가하지 않아요. 커밋·포크·복원은 고정한 source/revision·입력 schema·호스트 조건과 영수증·저장 결과의 일치를 확인하며 코드를 다시 실행하지 않아요. 이것은 승인된 결과의 보존이며 복원 때 계산의 의미를 재평가했다는 증거가 아니에요. 공유용 진단에는 이 코드나 입력/출력을 자동 포함하지 않아요.

엔진 실행, `uimori-state-action-v1` 입력 계약, 상태 저장 호스트는 별도 모듈이에요. 자동 준비와 모델 행동은 `server/package-behavior-run.ts`에서 행동 해석·영수증·효과 채택을 공유해요. 현재 `model.generate` broker는 모델이 호출한 행동에만 연결되어 있어요. 사용자 버튼·`before-turn`에서의 추가 모델 호출, 일반 HTTP, 응답 후 코드 처리, 실행 설치·의존성 권한 관리와 Lua 어댑터는 후속 작업이에요. 자료별 함수명을 서버 분기로 옮기지 않아요.
