# 제한된 실행 context와 계산

프롬프트 제작 코드는 한 번 데이터 AST를 만들고, 요청마다 host가 넘긴 JSON context를 읽어 AST를 평가해요. `PromptProgram.version: 1`과 기존 scalar `PromptValue`/control 의미는 유지해요. 새 실행 값 `RuntimeValue`는 scalar, 배열, 문자열 key를 가진 객체를 지원해요. 외부 IO, 코드 실행, 상태 저장, 난수 생성은 이 평가기의 기능이 아니에요.

## 공개 API

### Gemini 중간 system 임시 호환 처리

2026-09-08: `core/provider-messages.ts`는 모델 ID가 `gemini-*`(게이트웨이의 `google/gemini-*` 등 마지막 경로 요소 포함)일 때 첫 non-system 메시지 이후의 모든 system 메시지를 전송 시 user로 바꿔요. 선두의 연속 system, 본문, 순서, 저장된 AST·Run snapshot은 보존하며 `GEMINI_MID_SYSTEM_TO_USER` 진단에 원래 block/index를 남겨요. Vertex는 기존 방식대로 연속 user의 parts를 합쳐요. 다른 모델의 role·지원 검사는 유지해요.

영구적인 Gemini 제약으로 간주하지 않아요. 신모델이 중간 system을 지원하면 모델·프로토콜별 지원을 확인하고 해당 모델의 변환을 해제하도록 개선해요. 현재 검증은 로컬 직렬화 회귀이며 실제 Gemini 응답·품질 검증은 아니에요.

```ts
validatePromptExpression(value, controlIds = [], localNames = []): PromptExpression
validatePromptTemplate(value, controlIds = [], localNames = []): PromptTemplate
evaluatePromptExpression(expression, values = {}, { runtime, locals, limits } = {}): RuntimeValue
renderPromptTemplate(template, values = {}, slots = {}, { runtime, locals, limits } = {}): string
compilePromptProgram(program, { values, slots, history, runtime, limits }): PromptCompilation
```

`runtime`와 `locals`는 `Record<string, RuntimeValue>`예요. 평가 입력은 검증 후 복사하며 반환하는 구조화 값도 분리된 복사본이에요. `context` 경로에는 **host가 명시적으로 제공한 필드만** 존재해요. 이름이 있다고 DB·환경 변수·파일을 조회하지 않아요. `slots`는 기존 원문 문자열 삽입 계약으로 유지하며 context와 혼용하지 않아요.

## 데이터 AST

```json
{"context":["state","hp"]}
{"local":"npc","path":["name"]}
{"literal":{"labels":["calm","bright"],"enabled":false}}
{"op":"map","args":[{"context":["npcs"]},{"local":"npc","path":["name"]}],"as":"npc"}
```

`context`/`local.path`는 own property만 읽어요. 배열 index는 경로의 숫자 문자열로 지정해요. 없는 필드나 index는 null이며, null 아래로 경로를 더 읽어도 null을 반환해요. 문자열·숫자·불리언에서 하위 필드를 읽는 잘못된 접근은 오류예요. `__proto__`, `constructor`, `prototype` 경로 및 객체 key는 허용하지 않아요. Date·함수·accessor·순환 참조 등 JSON이 아닌 데이터는 거절해요.

`map`/`filter`는 `args: [source, body]`, 필수 `as`, 선택 `index` 이름을 사용해요. `filter`의 body는 boolean 또는 null이어야 해요. 반복 source는 실제 배열이어야 하며 JSON 문자열을 다시 파싱하지 않아요.

템플릿에는 다음 두 노드가 추가돼요.

```ts
{ kind: 'each', source, as: 'npc', index: 'i', body: [...], else: [...] }
{ kind: 'let', name: 'total', value: expression, body: [...] }
```

각 binding은 body 안에서만 유효해요. `each.else`는 배열이 비었을 때 바깥 scope에서 평가해요. 같은 이름을 안쪽에서 선언하면 바깥 이름을 가리고, 블록을 벗어나면 바깥 binding이 유지돼요. local 참조는 검증 단계에서도 확인하므로 미선택 분기 안의 잘못된 이름이나 문법이 허용되지는 않아요.

## 연산 의미

| 범주 | 함수 | 계약 |
|---|---|---|
| 기존 scalar | `all any not equal notEqual greater greaterEqual length replace` | 기존 표시 문자열·truthiness 유지. boolean 출력은 `1`/`0`. `length`는 표시 문자열 길이, `replace`는 기존 JS 문자열 치환의 `$&`, `$$`, prefix/suffix 치환 의미까지 유지 |
| 엄격 산술 | `add subtract multiply divide mod pow clamp round floor ceil abs` | 실제 유한 number만 허용. 문자열·boolean·null을 숫자로 변환하지 않음. 0 나누기/비유한 결과는 오류. `round(x,digits?)` 자릿수는 0–12 |
| 엄격 비교 | `gt gte lt lte typedEqual` | 대소 비교는 number 전용. typedEqual은 JSON 구조 비교로 `true`와 `1`을 구별하고 객체 key 순서는 무시 |
| 집계 | `min max sum average` | number 배열 하나 또는 여러 number 인자. 빈 배열 sum은 0, 나머지는 null |
| 문자열 | `contains startsWith endsWith trim lower upper split join` | 문자열 전용. join은 문자열 배열, split은 문자열 배열 반환 |
| 자료 | `get size slice range unique array object` | get은 객체 key/배열 index, size는 문자열·배열·객체 크기, slice는 문자열/배열. range는 `(end)`, `(start,end)`, `(start,end,step)`이며 끝 제외·step 0 금지. unique는 JSON 구조 동등성 기준. object는 key/value 쌍이며 중복 key 금지 |
| 선택 | `exists coalesce typedIf` | exists는 null만 부재로 취급. coalesce는 첫 non-null 값. `0`, `false`, 빈 문자열을 유지. typedIf는 boolean/null 조건으로 선택한 인자만 평가 |
| 반복 | `map filter` | source 배열을 제한된 횟수만 순회하며 lexical local/index 사용 |
| UTC 날짜 | `datePart dateAddDays dateFormat` | 입력 ISO UTC 문자열만 사용. 현재 시각을 스스로 읽지 않음 |

`all`/`any`, `coalesce`, `typedIf`, 조건부 템플릿은 필요한 분기만 평가해요. 기존 v1 scalar 연산의 출력 의미는 유지해요. 새 산술은 IEEE-754 number 계산이며 금액의 정밀 소수 연산을 제공하는 API가 아니에요.

날짜는 `YYYY-MM-DDTHH:mm:ss[.SSS]Z` 형식과 실제 날짜 유효성을 엄격히 확인해요. `datePart`는 `year/month/day/weekday/hour/minute`이고 weekday는 일요일 0이에요. `dateAddDays`는 정수 ±365,000일 이내, 결과 연도 0000–9999 범위예요. `dateFormat`은 `date` → `YYYY-MM-DD`, `time` → `HH:mm:ss`, `iso` → millisecond 포함 정규화 문자열이에요. 시간대 암묵 변환은 없어요.

## 제작과 선택형 문법

```ts
system('npcs', letValue('total', expr.sum(expr.context<number[]>('scores')), total =>
  text`합계 ${total}\n${each(expr.context<{name:string}[]>('npcs'), 'npc', npc =>
    text`${expr.get<string>(npc, 'name')}\n`
  )}`
))
```

`expr.context<T>()`의 T는 작성자의 타입 선언이고, 실제 입력과 연산 타입은 런타임에서 다시 검증해요. `expr.map/filter`와 `each`에 전달한 제작 callback도 작성 시점에 한 번 호출하여 AST를 만들어요. 실행 중 일반 JS 함수를 호출하지 않아요. 중첩 scope에서 바깥 값도 함께 참조하려면 서로 다른 binding 이름을 지정해요.

```text
{% let total = sum(context.scores) %}
합계 {{ local.total }}
{% each npc, i in context.npcs %}
{{ local.i }}. {{ local.npc.name }}
{% else %}등록된 인물이 없어요.{% endeach %}
{% endlet %}
{{ dateFormat(context.time.iso, "date") }}
```

상수 배열/객체는 `[1,2]`, `{"name":"Mira"}` 또는 명시적 `literal(...)`로 작성해요. 함수형 반복은 `map(source, "npc", body)`와 `filter(source, "npc", predicate)`, index를 함께 쓰면 `mapIndexed(source, "npc", "i", body)`/`filterIndexed(...)`예요. 산술 기호 `+ - * / % **`도 AST 연산으로 변환해요. 기존 비교 기호는 기존 scalar 비교 의미를 유지하므로 엄격 비교가 필요하면 `gt`/`typedEqual` 등을 사용해요.

출력기는 AST를 보존하며 문법을 정규화해요. 드문 명시적 빈 `local.path: []`는 `localPath("name", [])`로 왕복해요. 치환 값이나 chat history에 문법 구분자가 있어도 다시 파싱하지 않아요.

## 실행 한도

한 요청 컴파일의 모든 블록과 반복은 하나의 평가 budget을 공유해요. 기본 상한은 100,000 steps, 1,000 ms, 출력 1,500,000 UTF-16 코드 단위예요. 구조화 값은 JSON 크기 1,000,000 코드 단위, 30,000 nodes, 배열/객체당 2,000 entries, 깊이 32까지예요. caller의 `limits`는 상한을 낮출 수 있지만 높일 수는 없어요. `evaluatePromptExpressions(expressions, values, options)`는 여러 식에 evaluator와 step/time budget 하나를 적용하고, 전체 반환값의 합계 크기/nodes도 제한해요. 개별 `evaluatePromptExpression` 호출은 각각 budget을 가지므로 한 action의 여러 효과는 batch API로 평가해요.

목록 편집은 원본을 바꾸지 않는 `append(array, value)`, `concatArrays(...arrays)`, `setAt(array, index, value)`로 처리해요. `setAt`은 0 이상이고 현재 길이보다 작은 정수 index만 허용하며, 끝에 추가할 때는 `append`를 써요. `merge(record, record)`는 오른쪽 필드가 우선하는 얕은 병합이에요. 배열/record 타입과 결과 크기를 검사하고 잘못된 index를 자동 보정하지 않아요. 이 네 함수는 같은 이름의 `expr` TypeScript helper와 선택 문법 함수로도 제공해요. 문자열 `concat`의 기존 의미에는 영향을 주지 않아요.

큰 range·split·반복 결과, 문자열 치환·대소문자 확장, JSON escape 확장과 직렬화 크기를 확인한 뒤 생성해요. 시간 초과는 협력적 검사이며 OS 차원의 임의 코드 격리가 아니에요. 사용자 정규식·임의 JS를 받아 실행하지 않고, 상한이 있는 고정 연산만 사용해요. 기존 program 전체 1,000,000 JSON 코드 단위, control/블록/표현식 깊이 및 최종 provider prompt 한도도 유지해요.

state write·action idempotency·job dispatch·random draw 저장·reroll·source hash 귀속은 host가 책임져요. 이 계산기가 상태를 직접 저장하거나 원문을 바꾸지는 않아요.
