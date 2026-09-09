# 패키지 상태와 CBS 계열 기능

공통 패키지에 선택적 `behavior`를 넣으면 채팅 분기별 상태, 입력 폼과 행동 버튼, 기록된 주사위, 원문 출력 해석을 사용할 수 있어요. 봇·페르소나·모듈 모두 같은 형식이에요. 서재의 자료 편집 → **상태와 행동**에서 시작 예제를 넣거나 동작 JSON을 검증·적용한 뒤 자료를 저장해요. 채팅 화면의 상태와 행동 패널에서 실행해요.

[합성 일상 상태 예제](../fixtures/daily-state-behavior.json)를 동작 JSON에 붙여 넣을 수 있어요. 인벤토리 추가, 자원 소비, 기록된 d6, 다음 날/중복 없는 일정 섞기를 포함해요. 실제 봇의 개인 본문·Lua·에셋을 가져온 예제가 아니에요.

[자동·사용자·모델 호출 예제](../fixtures/hybrid-actions-behavior.json)는 자동 날씨·10% 조우, 사용자 d6 버튼, 모델의 설득 판정을 같은 실행기로 처리해요.

이 문서가 현재 API이고 [복잡한 봇 확장 계획](../project-plan/PACKAGE-BEHAVIOR-PLAN.md)의 전체 항목이 구현됐다는 뜻은 아니에요. CBS 태그를 그대로 해석하는 호환 파서, 임의 Lua/JavaScript, 원본 카드 전체 포팅은 제공하지 않아요.

## 읽기 문맥과 계산

[execution-context.ts](../core/execution-context.ts)는 저장된 Run에서만 문맥을 만들어요. 프롬프트와 패키지의 `template/when`, 상태 액션과 출력 파서 조건이 같은 계산 함수를 사용해요. `{ "context": ["state", "energy"] }`처럼 경로로 읽어요. [연산·타입·제한](PROMPT-RUNTIME.md), [선택 문법](PROMPT-LANGUAGE.md), [TypeScript 제작 API](PROMPT-AUTHORING.md)를 함께 볼 수 있어요.

| 경로 | 의미 |
| --- | --- |
| `chat` | chat/branch ID, 부모 원문 ID, 완료 원문 수 기준 `turnIndex` |
| `bot`, `user` | 해당 역할의 이름·설명. 설명 16,000자 상한과 `descriptionTruncated` |
| `input.text` | 현재 요청. 액션에서는 `input`이 검증된 액션 입력으로 대체됨 |
| `history` | 요청용 투영의 최근 100개 논리 메시지/60,000자 이내. `total/truncated/lastUser/lastAssistant` 포함 |
| `state` | 패키지 안에서는 그 장착 인스턴스의 상태. 일반 프롬프트에서는 기존 이야기 상태 값 |
| `packages` | 현재 역할에서 참조 가능한 장착 인스턴스 목록. ID/revision/role/상태/옵션/추첨 결과 |
| `package`, `options`, `draws` | 패키지 안에서 선택된 인스턴스. 옵션 기본값과 `0/false`를 보존 |
| `model` | 해당 작업에 선택된 모델 ID·프로토콜·catalog 기능 정보. 현재 wire가 지원하지 않는 `prefill`은 `false` |
| `time` | 저장된 `iso`, Unix 초, `timezone: "UTC"`. 과거 snapshot에 없으면 `null` |
| `catalog` | 조회 가능한 자료의 메타데이터 최대 200개. 설명은 500자, 절단 여부 포함. 본문은 기존 조회 도구 사용 |

`history.total`은 이 Run에 선택된 논리 이력의 개수예요. 문맥 압축으로 과거 일부가 제외된 경우 전체 채팅 메시지 수와 다를 수 있어요. 메인의 히든 구간 제외와 persona 참조 설정을 따르며 credential·endpoint는 문맥에 넣지 않아요. 번역 프롬프트는 추가로 `source.id/hash/blocks`를 읽어요. 실제 데이터는 역할별로 고정된 snapshot을 사용해요.

미리보기는 현재 상태를 읽고 한 번의 기준 시각을 만들어요. DB를 초기화하거나 주사위를 굴리지 않아요. 실제 Run은 생성 시각과 상태를 저장하고, candidate는 원래 Run의 값과 추첨을 재사용해요. 이야기 속 날짜는 `state`의 별도 필드로 작성하고 명시적 액션으로 바꿔요.

## 지침 삽입

`instructions`의 main 항목에 `position: "scene-state"`를 넣으면 메인 프롬프트의 동일한 이름을 가진 slot에 들어가요. 장착 순서, 패키지 내 지침 순서를 유지해요. 자동 host 지침에 중복 추가하지 않아요. 해당 slot이 프롬프트에 선언되지 않으면 `PACKAGE_INSERTION_SLOT_MISSING`으로 실패해요. slot 자체의 조건은 프롬프트 작성자가 결정해요.

```json
{ "id": "scene-state", "title": "진행 상태", "kind": "slot", "role": "system", "slot": "scene-state" }
```

패키지 내부에서 다른 패키지의 문자열 slot을 재귀 호출하지 않아요. 공통 읽기 문맥의 `packages`를 조회하거나 제작 시 TypeScript 함수로 템플릿 조각을 재사용해요.

## 상태와 행동

`behavior`는 `revision`, `schemaVersion`, `stateSchema`, `initialState`, `actions`, `outputParsers`를 가져요. `mode`는 기본 `authoritative`, 선택값 `annotation`이에요. 필수 상태가 실패하거나 원문 의존성이 바뀌면 다음 생성은 409로 멈춰요. annotation 실패는 생성 진입을 막지 않아요.

상태 schema는 number(min/max/integer), string(maxLength), boolean, enum(values), list(items/maxItems), record(properties)를 지원해요. 루트는 record예요. 누락된 필드와 알 수 없는 필드는 모두 오류예요. 상태 JSON은 250,000자 이내이며 개별 자료·실행기의 상한도 적용돼요.

액션은 `id`, 선택적 `label/description`, `inputSchema`, 선택적 `triggers/automaticInput/when/draws/result`, `effects`로 구성해요. 각 effect의 `path`는 상태 schema에 선언된 경로, `value`는 계산식이에요. **한 행동의 효과는 모두 그 행동 직전의 같은 상태**를 읽어요. 완성된 다음 상태 전체를 검증하고 `result`를 계산해요. `result`에서는 `nextState`도 읽을 수 있어요. 서로 다른 행동은 순서대로 실행하며 앞선 행동의 결과를 읽을 수 있어요. 겹치는 쓰기 경로는 거부해요. 목록은 `append/filter/map/setAt` 등으로 새 값을 만들고 전체 필드에 저장해요.

`draws`는 정수 범위 추첨, 값 목록 선택, 목록 섞기를 지원해요. seed와 실제 결과를 journal에 함께 기록해요. 액션 조건과 효과는 DB·네트워크·시각·난수를 직접 읽지 못해요. 호스트가 고정한 문맥과 추첨 결과만 사용해요. 한 행동에서 식 여러 개가 실행 한도를 공유해요.

명령은 `expectedStateRevision`, `expectedSourceHash`, `idempotencyKey`로 보호해요. 같은 명령 재전송은 최초 결과를 반환하고, 같은 키에 다른 입력은 409예요. 다른 액션·출력 처리가 먼저 상태를 바꾸면 재조회해야 해요. 원문 생성 중에는 상태 버튼을 잠가요.

## 다음 요청 예약

사용자 전용 행동에 `nextRequest` 계산식을 넣으면 그 행동의 결과를 다음 원문 요청으로 예약해요. 예를 들어 `result: {"context":["input","request"]}`와 `nextRequest: {"context":["result"]}`는 폼에서 입력한 제안을 예약해요. 이 식은 `state/input/draws/nextState`와 완성된 `result`를 읽으며, 결과는 비어 있지 않은 4,000자 이하 문자열이어야 해요. `nextRequest`가 있는 행동은 `triggers: ["user"]`만 허용해요. 상태 변경과 예약은 한 트랜잭션에서 처리하고, 자동·모델 호출은 예약을 만들지 않아요.

한 분기에 예약은 하나예요. 새 예약은 이전 예약을 대체해요. 화면의 **작성란에 넣기**를 누른 뒤 **원문 생성**을 실행하면 `packageRequestId`가 같은 요청 문자열과 함께 전송되고, Run을 수락하는 트랜잭션에서 한 번 소비돼요. 작성란을 직접 고치면 예약 ID를 제거하고 독립된 사용자 요청으로 보내요. 예약 자체는 모델을 호출하지 않아요.

예약은 당시 패키지 인스턴스·상태 revision·채팅 설정 revision·원문 ID/hash와 전체 선행 원문 hash에 묶여요. 상태·설정·원문이 바뀌면 이전 예약은 실행할 수 없어요. 같은 행동이나 Run 요청의 재전송은 소비·취소한 예약을 되살리지 않아요. **예약 취소**는 상태 변경을 되돌리지 않으며, 포크는 예약을 복사하지 않아요. 보관/복원은 행동 journal·요청·소비 Run의 귀속을 검증해요.

[공통 합성 패키지](../tests/fixtures/action-package.ts)와 `tests/package-request.test.ts`, `tests/package-request-browser.spec.ts`가 임의 상태 축·언어·분량 옵션, 예약과 1회 소비를 확인해요. 특정 봇의 축·언어 목록·분량별 상태 규칙은 제품에 내장하지 않아요.

## 호출 방법 선택

서재의 상태와 행동 편집에서 행동별 체크박스로 선택해요. 선택한 내용을 **동작 검증 후 적용 → 자료 저장**해요. 여러 호출 방법을 함께 허용할 수 있고, `triggers: []`는 그 행동을 비활성화해요. 생략 시 기본값은 `["user"]`예요.

| 값 | 실행 시점과 입력 | 적합한 작업 |
| --- | --- | --- |
| `user` | 사용자가 폼·버튼으로 명시한 입력. 즉시 상태에 반영 | 주사위 버튼, 휴식, 아이템 사용 |
| `before-turn` | Run을 만들 때 장착 순서·행동 선언 순서대로 실행. `automaticInput` 또는 `{}` 사용 | 턴 경과, 고정 확률 조우, 날씨·일정 일괄 결정 |
| `model` | 메인 모델이 해당 행동의 Tool을 요청. schema로 검증한 입력만 사용 | 문맥에 따른 설득·탐색·전투 판정 |

세 경로는 `evaluateBehaviorAction()`을 사용해요. 함수 본문은 모델에 보내지 않아요. 조건·효과·결과가 하나의 실행 예산을 공유하고, 결과 JSON은 8,000자 이내예요. `result`를 생략하면 `{ "applied": true, "draws": ... }`를 반환해요. `effects: []`인 순수 계산도 사용할 수 있고, 사용자 호출의 결과는 **최근 행동 결과**에 표시돼요.

메인에 참조 가능한 장착 인스턴스에서 `model`로 허용한 행동만 각각 하나의 Tool이 돼요. 보조 모델에는 노출하지 않아요. 비활성 페르소나는 자동·모델 실행에서 제외해요. 모델 입력의 루트 schema는 `record`예요. 주사위·계산·효과를 한 행동으로 묶으면 모델이 각 연산을 따로 요청할 필요가 없어요. 모델에 전달하는 값은 제작자가 선언한 짧은 결과로 정할 수 있어요.

모델 행동은 메인 요청 전체에서 최대 20개, 자동 선언은 최대 100개, 한 Run에서 실행하는 자동·모델 행동은 합계 최대 100개예요. Run/기회 journal 각각 JSON 4,000,000자 한도가 있어요. 공급자 catalog 또는 사용자 설정에서 도구 미지원이 확정된 모델은 요청 전에 거부해요. 기능 정보가 미확정인 프로바이더는 실행을 허용하지만 실제 공급자의 지원을 보증하지 않아요.

## 판정 기회와 완료·취소

자동 계산은 최초 프롬프트의 상태와 `automaticResults`에 고정해요. 생성 중 모델 행동은 Run의 별도 journal과 임시 상태를 변경하고, 결과를 모델에 반환해요. **현재 채팅 상태는 원문이 완료될 때 반영돼요.** 취소·거절·전송 실패에서는 임시 효과를 게시하지 않아요. 미리보기는 실행·추첨·journal 기록을 하지 않아요.

원문·분기·패키지 상태와 설정이 같은 재요청은 같은 판정 기회를 사용해요. 모델이 call ID·요청 문구를 바꾸거나 생성이 취소돼도 같은 행동을 재추첨하지 않아요. 한 기회에서 행동마다 한 번 판정하며 같은 입력은 같은 결과를 반환해요. 다른 입력으로 재요청하거나, 다른 패키지의 선행 상태가 원래 판정 당시와 다르면 409로 거부해요. 필요한 선행 행동을 같은 순서로 실행하면 저장된 결과를 재사용할 수 있어요. 조건 `when`은 호스트에서 확인하며, 거짓인 자동 행동은 건너뛰어요.

candidate는 원래 Run의 자동 결과·판정 기회를 사용하고, 새 분기는 자동 실행 전 상태에서 시작해 중복 적용을 막아요. 아직 판정하지 않은 행동의 필요 여부는 모델이 결정할 수 있어요. 사용자가 상태 버튼을 직접 실행하거나 원문을 완료해 상태가 전진하면 새 기회가 생겨요. 복사한 채팅은 기록된 결과를 유지하며 이후의 새 턴은 독립적으로 진행해요.

## 출력 해석과 복구

`outputParsers`는 원문 전체 또는 고정된 `start/end` 사이를 JSON/구분자 목록으로 읽고, 선언된 `from` 경로를 상태 `path`에 절대값으로 반영해요. 필드 타입과 범위를 검사하고 여러 파서를 한 그룹으로 반영해요. 기존 evidence 기반 상태 모델의 delta 규칙은 변경하지 않아요.

- 원문 500,000자 이하, 파서 최대 30개예요. 일반 정규식이나 실행 코드를 받지 않아요.
- `required: false`이며 시작·끝 표식이 **둘 다 없는 경우**만 건너뛰어요. 반쪽·중복 표식과 구조 손상은 실패예요.
- 자동·모델 행동과 authoritative 출력 파서는 여러 패키지에 걸쳐 한 묶음으로 적용해요. 하나라도 실패하면 묶음 전체를 되돌리고 다음 authoritative 생성을 막아요. 완료된 원문 자체는 남아요.
- annotation 출력 파서는 그 뒤 별도로 적용해요. annotation 파싱만 실패한 경우 이미 검증된 행동의 상태·추첨은 유지하고 해당 표시 상태만 실패로 기록해요. annotation 오류 자체는 다음 원문을 막지 않아요.
- 원문 또는 이전 원문을 수정하면 관련 상태는 stale이에요. 자동 재파싱·과거 효과 재실행은 없어요. 화면에서 확인 후 **초깃값으로 복구**하면 현재 원문들을 기준으로 새 상태 revision을 만들고 이전 journal을 보존해요.
- 본문·로어 등만 수정하고 `behavior` 정의가 같으면 상태·추첨·journal을 유지해요. 동작·parser·schema·initialState·behavior revision이 바뀌면 `BEHAVIOR_MIGRATION_REQUIRED`로 차단하고 기존 상태를 보여 줘요. 사용자가 확인한 뒤 **초깃값으로 복구**하면 최신 정의로 재설정하며, 이전 상태와 정의 출처를 journal에 남겨 당시 schema로 검증해요. GET/preview는 저장·추첨을 하지 않아요. 임의 schema migration API는 제공하지 않아요.

분기는 선택한 원문 직후 상태를 사용해요. 과거 원문이 바뀐 후보는 거부하고 새 분기의 상태는 stale로 유지해요. schema/archive **v15**은 현재 상태뿐 아니라 판정 기회·임시 실행·결과·출처의 일치도 검증해요. **정식 배포 전에는 구버전 DB·자료·채팅·백업과의 하위 호환성을 지원하지 않아요.** 개발 DB를 새로 시작하는 방법은 [개발 안내](DEVELOPMENT.md)를 봐요.

## 제공 범위와 검증

상태 화면은 문자열·수치·목록·중첩 레코드와 최근 행동 결과를 읽기 전용으로 표시하고, 버튼 입력은 타입별 폼을 사용해요. 에셋/이미지 및 상태·번역 보조 모델 경로도 같은 패키지 문맥을 읽어요. 패키지가 임의로 새 종류의 모델 job을 만드는 hook/job API, 임의 코드 실행, 전용 달력·전투판 view DSL은 제공하지 않아요.

`tests/prompt-runtime.test.ts`, `tests/execution-context.test.ts`, `tests/package-behavior*.test.ts`는 계산·타입·실행 제한, 실제 prompt 연결, CAS·중복 제출·출력 실패·원문 수정·분기·아카이브를 합성 데이터로 확인해요. `tests/package-behavior-browser.spec.ts`는 사용자 폼, 충돌 후 초안 보존, 390px 화면을 확인해요. 원본 봇 전체 동작이나 실제 provider 품질을 증명하지 않아요.
