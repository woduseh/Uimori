# Uimori 프롬프트 문법

현재는 기존 본문/JSON 편집 옆에서 선택하는 시험용 작성 방식이에요. 기본 작성 방식 채택은 TypeScript 제작 API 비교 후 결정해요. 문법 초안에 오류가 있으면 기존 AST를 유지하고 위치를 표시하며, 초안을 적용하거나 되돌리기 전에는 상위 저장과 프롬프트 전환을 막아요.

작성한 프롬프트만 기존 `PromptTemplate` 데이터 AST로 변환해요. 채팅·봇 자료·옵션의 문자열을 다시 문법으로 해석하지 않아요. JavaScript, 임의 함수, 파일·네트워크 접근은 없어요. CBS 호환 문법이 아니며 기존 데이터 AST를 실행하는 런타임은 유지해요.

```text
{{ bot.name }}의 이야기를 작성해요.
{% if options.detail >= 2 and not options.brief %}
감각과 행동을 구체적으로 묘사해요.
{% else %}
짧게 진행해요.
{% endif %}
```

- 옵션: `options.detail`, 특수 문자가 있는 기존 ID는 `options["legacy::id"]`예요. 선언된 ID만 허용해요.
- 슬롯: `{{ bot.name }}` 또는 `{{ slot("legacy-name") }}`예요. 호출자가 허용한 이름만 사용할 수 있어요. 슬롯은 조건식의 피연산자가 아니에요.
- 값: 작은따옴표·큰따옴표 문자열, 유한수, `true`, `false`, `null`, 상수 JSON 배열·객체예요. 문자열은 JSON escape 및 `\'`를 지원해요. 명시적인 `literal(...)`도 지원해요.
- 연산: `== != > >= < <=`, `and or not`, `+ - * / % **`, 괄호를 지원해요. 우선순위는 원자/단항, 거듭제곱, 곱셈 계열, 덧셈 계열, 비교, `and`, `or` 순이에요. 거듭제곱은 오른쪽 결합이에요. `not (options.x == 1)`처럼 복합 부정은 괄호로 표시해요. 비교 연결은 왼쪽부터 적용하므로 범위는 `options.x >= 1 and options.x <= 3`으로 작성해요.
- 고정 함수: 기존 `length`, `replace`, 비교·논리 외에 산술·자료 접근·집계·문자열·UTC 날짜·map/filter를 지원해요. 전체 의미와 한도는 [PROMPT-RUNTIME.md](PROMPT-RUNTIME.md)에 있어요. 함수 호출은 허용된 AST 연산으로만 변환돼요.
- 조건: `{% if 조건 %}...{% else %}...{% endif %}`예요. else는 생략할 수 있어요. 공백·개행은 그대로 유지해요.

기존 런타임 의미를 유지하므로 boolean 출력은 `1`/`0`, null은 `null`이에요. 비교의 동등성은 표시 문자열, 대소 비교는 숫자 변환을 사용해요. 거짓 값은 null, false, 숫자 0, 빈 문자열, 문자열 `0`/`false`/`null`이에요.

AST 왕복을 위해 `{% if_trim 조건 %}`은 선택한 분기의 앞뒤 빈 줄을 제거하고 `{% if_trim_false 조건 %}`은 명시적인 `trimLines: false`를 보존해요. `{% text "리터럴 {{ 문법 }}" %}`은 구분자를 포함한 원문과 빈/인접 text 노드를 보존해요. 출력기는 연산을 고정 함수 형태로 정규화하며 else 유무와 text 노드 경계를 보존해요. 원래의 들여쓰기나 따옴표 스타일을 보존하는 소스 포매터는 아니에요.

API는 `parsePromptTemplate(source, controlIds, slots?)`와 `printPromptTemplate(template)`예요. 슬롯 기본 목록은 `DEFAULT_PROMPT_SLOTS`이고 실제 실행 자료의 슬롯 목록을 명시 전달하는 것이 좋아요. `PromptLanguageError`는 `code`, 0부터 시작하는 UTF-16 `offset`, 1부터 시작하는 `line`/`column`을 제공해요. 소스는 200,000 UTF-16 코드 단위, 템플릿 노드는 5,000개, 중첩은 32, 함수 인자는 100개까지예요. 출력기는 같은 제한을 적용하며 제한을 초과한 기존 AST는 잘라내지 않고 실패해요.

실행 context는 `context.state.hp` 또는 `context["state"]["hp"]`로 읽어요. `{% each npc, i in context.npcs %}...{% else %}...{% endeach %}`와 `{% let total = sum(context.scores) %}...{% endlet %}`를 지원하고 지역값은 `local.npc`/`local.i`/`local.total`로 참조해요. scope를 벗어난 참조는 오류예요. 표시 슬롯이 존재한다고 같은 이름의 context가 자동으로 생성되지는 않아요.
