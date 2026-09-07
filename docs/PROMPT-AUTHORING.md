# 프롬프트 제작 방식 비교

TypeScript 제작 API를 별도 후보로 추가했어요. 기본 작성 방식의 채택을 확정하는 변경은 아니에요. 기존 본문/JSON 편집과 선택형 템플릿 문법을 유지하고, 모든 작성 결과를 기존 `PromptProgram` 데이터 AST로 모아요. 현재 제공하는 TypeScript API는 **작성할 때 한 번 실행해 AST를 생성하는 방식**이에요.

| 판단 기준 | 독자 템플릿 문법 | TypeScript 제작 API → AST | 요청마다 격리 TypeScript 런타임 |
|---|---|---|---|
| 사람이 읽고 수정하기 | 문장과 짧은 조건을 한 화면에서 수정 | IDE 자동완성·타입 검사·함수 재사용 | 일반 코드 표현력을 요청 시점에도 사용 |
| 조건·반복 | 제한된 each/let와 고정 계산 문법 | 작성 시 반복은 일반 TS, 요청 시 조건은 `when`/`choose`, 자료 반복은 `expr.map/filter`/`each`, 지역값은 `letValue` | 일반 `if`/반복으로 현재 요청값 처리 가능 |
| 실시간 옵션 | 선언한 옵션 참조를 AST로 변환 | typed `Expression`을 AST에 저장 | 실제 값을 runtime context에 전달 |
| 실행 권한 | 파서와 허용된 AST 연산만 실행 | 신뢰한 제작 코드의 명시적인 로컬 실행은 일반 코드 권한을 가짐. 생성물은 데이터만 저장 | 격리 프로세스·명시 권한·CPU/메모리/시간·네트워크/파일 정책 필요 |
| 재현·보관 | 원본과 컴파일 AST 고정 | TS 원본, 빌드 환경과 생성 AST를 함께 고정 가능 | 코드 외에 runtime 버전·의존성·외부 상태도 고정해야 함 |
| imported 자료 | 데이터로 파싱·변환 | AI가 검토 가능한 제작 코드 초안으로 변환 가능 | imported 코드를 실행 대상으로 신뢰하는 추가 문제가 생김 |
| 현재 구현 | `core/prompt-language.ts`, 선택형 UI | `core/prompt-authoring.ts`, 합성 단위/타입 검사 | 구현하지 않음 |

제작 API는 복잡한 프롬프트의 재사용·타입 검사에 적합한 후보예요. 일반 TS의 표현력을 제공하되, 실행 중에 옵션을 읽어 달라지는 동작은 명시적 AST 연산으로 제한한다는 차이를 문서와 UI에서 숨기면 안 돼요. 요청별 runtime은 도구/환경 접근이 꼭 필요한 요구가 확인되기 전까지 별도 설계·권한 범위로 남겨요.

## 실제 제작 예시

다음은 저장소에서 신뢰하고 직접 실행하는 `.prompt.ts` 제작 모듈의 내용이에요. 앱에서 업로드한 TS를 자동 실행하거나 요청마다 import하는 기능은 없어요. 상대 import 경로는 파일 위치에 맞게 조정해요.

```ts
import {
  definePrompt, option, expr, text, choose, when,
  system, user, assistant, slot, history, cache,
} from '../core/prompt-authoring.js';

const styleNotes = ['행동으로 드러내요.', '장면의 변화에 집중해요.'];

export default definePrompt({
  controls: {
    detail: option.number({ label: '상세도', default: 1, min: 0, max: 3 }),
    brief: option.boolean({ label: '짧게', default: false }),
    tone: option.select({
      label: '분위기', default: 'calm',
      options: [
        { label: '차분하게', value: 'calm' },
        { label: '활기차게', value: 'bright' },
      ],
    }),
  },
  compose: ({ options }) => [
    system('direction', text`분위기: ${options.tone}\n${
      choose(options.brief, '짧게 진행해요.', '장면을 충분히 전개해요.')
    }`),
    ...styleNotes.map((note, i) => system(`style-${i}`, note)),
    when(expr.greaterEqual(options.detail, 2), system('detail', '감각을 구체화해요.')),
    slot('bot', 'description'),
    user('example-question', '합성 예시 질문'),
    assistant('example-answer', '합성 예시 답변'),
    history(), // 현재 입력도 포함해요. current()를 추가하면 중복 검사에 걸려요.
    cache('end'),
  ],
});
```

`definePrompt`가 반환하는 값은 함수가 없는 검증된 `PromptProgram`이에요. `JSON.stringify(program, null, 2)` 결과를 기존 JSON 불러오기로 열 수 있어요. 자동 파일 탐색/실행 CLI는 제공하지 않아요. 생성 작업을 자동화한다면 신뢰한 제작 모듈을 **경로가 고정된 제작 스크립트에서 직접 import**하고 JSON 파일로 쓰는 방식으로 구현해요. 그 로컬 실행은 일반 코드 실행이며 템플릿의 제한된 실행 권한과 같지 않아요. 외부 자료의 JavaScript/Lua/TS를 변환 과정에서 그대로 import하거나 실행하지 않아요.

## `compose(ctx)`와 런타임 옵션의 차이

이 구현의 `compose({options})`는 메시지 문자열을 즉시 완성하는 요청 콜백이 아니에요. 옵션은 현재 boolean/number/string 값이 아닌 **타입이 붙은 AST 참조 객체**예요. 따라서 `if (options.brief)`는 일반 JavaScript에서 객체의 참 여부를 보는 잘못된 작성이에요. TypeScript가 이런 모든 실수를 자동으로 막아 주는 것도 아니에요. 조건부 블록은 `when(options.brief, block)`, 조건부 문장은 `choose(options.brief, yes, no)`로 작성해야 해요. `options.detail > 2` 대신 `expr.greater(options.detail, 2)`를 사용해요.

일반 `if`, `for`, 함수, 배열 map은 **작성 시점의 상수·자료로 AST를 구성하는 작업**에 사용할 수 있어요. 제작 콜백을 한 번 실행한 다음 옵션을 변경하여 여러 번 컴파일해도 제작 콜백은 다시 실행되지 않는 것을 테스트해요. 요청값을 일반 TS `if`로 분기하는 별도의 `compose(runtimeCtx) -> messages`를 원한다면, 현재 AST 제작 API와 다른 실행 모델이 필요해요.

## 계약과 제한

- 옵션 ID는 `controls`의 key에서 만들어지고 `options`에도 같은 key가 타입으로 노출돼요. select 값은 문자열·수·boolean 리터럴 집합으로 추론돼요. 기존 import의 미설정 상태를 위해 모든 옵션은 null을 허용해요.
- `expr`는 기존 동등/대소/논리/길이/치환에 더해 typed context, 산술·자료·문자열·UTC 날짜·반복 연산을 제공해요. 기존 `equal/greater` 등은 표시 문자열/숫자 변환 의미를 유지하며 새 `typedEqual/gt` 등은 엄격 타입 연산이에요. 자세한 계약은 [PROMPT-RUNTIME.md](PROMPT-RUNTIME.md)에 있어요.
- `text` 태그는 구분자를 파싱하지 않아요. `${options.x}`는 값 AST, `${slotText('persona')}`는 슬롯 AST이고 ordinary text에 담긴 `{{ ... }}`는 그대로 남아요.
- `when`을 여러 번 적용하면 기존 조건과 AND로 합쳐요. `choose`의 else 생략과 `trimLines` 옵션을 보존해요. `slot`의 감싸는 템플릿 안에서 `slotText('slot')`은 현재 슬롯 내용을 뜻해요.
- 반환 시 `validatePromptProgram`이 옵션·ID·연산 깊이·블록 수·원문 크기·전체 크기를 검사해요. 기존 최대 150 controls, 300 blocks, 깊이 32, 개별 text 200,000자, program JSON 1,000,000자 제한은 유지돼요. 요청 컴파일의 메시지/출력 1,500,000자 제한, history 중복·누락, 마지막 prefill, 슬롯 존재 검사는 실제 context가 있는 기존 컴파일러에서 검사해요.
- 타입 검사는 JavaScript 호출/캐스팅/잘못된 외부 데이터를 신뢰 근거로 바꾸지 않아요. 데이터 검증을 함께 수행해요. TS 제작 콜백 자체가 결정적인지는 작성자가 관리해야 해요. 날짜·난수·외부 상태를 사용하면 생성 과정은 달라질 수 있으므로 고정 생성 AST를 런타임 산출물로 사용해요.

## AI 변환 절차와 손실 보고

1. 원본 자료는 데이터로 읽고 role/순서/조건/옵션/참조/history/cache/prefill 목록을 만들어요. 원문 hash와 변환 범위를 기록해요.
2. 기존 데이터 AST가 있으면 우선 그대로 보존해요. 사람이 편집할 TS가 필요하면 제작 API 호출로 옮기고, 선택형 문법이 편하면 해당 소스를 만들어요. 다른 시스템의 코드를 실행하며 의미를 추측하지 않아요.
3. 조건과 제어는 typed 옵션 및 `expr`/`when`/`choose`로 옮겨요. 지원하지 않는 부작용·임의 평가·동적 도구 정의는 이름, 원래 목적, 대체 여부, 누락 영향을 손실 보고에 적어요. 조용히 텍스트로 바꾸거나 삭제하지 않아요.
4. 생성된 AST를 검증하고 대표 옵션 조합의 role/순서/원문/조건 포함 결과를 원본과 비교해요. 합성 자료로 일반 경로·예외·빈 옵션·기본값·중첩 조건을 검사해요.
5. 검토할 산출물은 원본 지문, 변환 소스, 생성 AST, 비교 결과, 잔여 손실 목록이에요. 원본 AST를 수정 없이 표현할 수 있으면 손실 없음의 근거를 구조 비교로 남겨요. 실제 provider 호출 없이 확인한 것은 로컬 의미/요청 구성 범위로 보고해요.

권장 손실 보고 열은 `원본 위치 | 원래 동작 | 대상 표현 | 상태(동등/대체/미지원/불확실) | 영향 | 확인 방법`이에요. 제작 API 자체에는 숨겨진 AI 호출이나 자동 실행이 없어요.
