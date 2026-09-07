# 공통 콘텐츠 패키지

봇·페르소나·모듈은 동일한 `ContentPackage` 형식을 써요. 패키지에 인물 정보가 있어야 할 필요는 없어요. 지침·옵션·정규식만 있는 패키지도 유효해요. 채팅에 붙일 때 `{id, revision, role: "bot" | "persona" | "module"}`로 역할을 정해요. 같은 패키지를 다른 역할로 붙여도 본문을 다시 작성하거나 인물의 의미를 자동으로 바꾸지 않아요.

스키마와 검증은 [content-package.ts](../core/content-package.ts), 요청 투영·상태 표시 descriptor는 [package-runtime.ts](../core/package-runtime.ts)에 있어요. 아래는 인물이 없는 작은 패키지예요.

```json
{
  "version": 1,
  "id": "scene-guide",
  "revision": 1,
  "title": "장면 지침",
  "description": "지침과 상태 표시를 묶은 패키지",
  "body": "현재 장면의 설정을 유지한다.",
  "roleBindings": { "module": "이 자료는 인물이 아니라 작문 지침이다." },
  "lore": [
    { "id": "harbor", "title": "항구", "description": "항구의 지리", "text": "동쪽 부두에는 파란 종이 있다.", "loading": "discoverable" }
  ],
  "instructions": [
    { "id": "detail", "target": "main", "text": "기존 사물의 구체적인 감각을 묘사한다.", "when": { "control": "detail" } },
    { "id": "names", "target": "translation", "text": "원문의 인명과 호칭을 일관되게 번역한다." }
  ],
  "controls": [
    { "id": "detail", "label": "세부 묘사", "type": "boolean", "default": true }
  ],
  "stateView": { "title": "상태", "fields": [{ "key": "hp", "label": "체력", "format": "number" }] },
  "transforms": [
    { "id": "status-label", "target": "source", "pattern": "<status>([\\s\\S]*?)</status>", "flags": "g", "replacement": "[상태]\n$1" }
  ]
}
```

## 데이터와 실행 경계

- `version`은 형식 버전, `revision`은 저장한 콘텐츠 개정 번호예요. `id`는 개정 간 유지해요. 패키지와 attachment의 ID·revision이 다르면 실행하지 않아요.
- `body`, 선택적 `identity: {name, description}`, 선택적 `roleBindings`는 원문 그대로 보관해요. 역할별 binding은 작성자가 직접 넣는 지침이에요.
- 로어는 패키지 내부 배열이에요. `pinned`는 고정 공급, `discoverable`은 모델이 검색·조회할 자료예요. 내부 `relatedIds`는 같은 패키지의 실제 로어 ID만 참조해요. Risu 트리거 키를 자동 실행하지 않아요.
- `instructions.target`은 `main`, `translation`, `state`, `memory`, `status`, `image` 중 하나예요. `attachmentRoles`로 적용할 부착 역할을 선택할 수 있어요. 생략하면 모든 부착 역할에 적용돼요.
- `controls`는 기존 `PromptControl` 형식을 재사용해요. 지침은 `when` 조건 및 선택적 `template` AST를 지원해요. `template`이 있으면 실행에 사용하며 보관된 `text`는 그대로 유지해요. 패키지 템플릿의 외부 slot은 현재 제공하지 않으므로 사용하면 `PROMPT_UNKNOWN_SLOT` 오류가 나요.
- `compilePackageAttachment`는 `{resources, pinned, instructions, controls, values, stateView?, transforms}`를 반환해요. resource ID에는 패키지 ID·부착 역할·내부 ID가 포함돼 서로 충돌하지 않아요. 패키지 ID 및 내부 ID는 64자 이내이며 이 조합은 읽기 도구의 200자 ID 한도 안에 있어요. 호스트가 이 투영을 역할 입력에 연결하며 패키지는 도구 권한을 만들지 못해요.
- [package-context.ts](../core/package-context.ts)의 `compiledPackages`는 Run에 고정된 `profile.packageAttachments/packages/packageValues`만 읽어요. 값의 키는 `id@revision:role`이에요. 누락된 개정은 오류이며 현재 라이브러리로 대체하지 않아요. 메인·번역·상태·기억·표시·이미지에는 각각의 대상 지침만 제공해요. 메인에서 persona 참조를 끄면 해당 persona 패키지의 본문과 내부 로어도 제외해요. 번역은 원문시점 persona 자료를 계속 참고할 수 있어요.
- `stateView`는 키·이름·값 형식·접미사를 지정하는 표시 descriptor예요. `renderPackageStateView`는 문자열과 누락 여부를 반환해요. `0`과 `false`는 누락으로 취급하지 않아요. 상태 계산·canon 변경·HTML 실행은 하지 않아요. UI는 값을 텍스트로 표시해야 해요.

## 정규식 표시 변환

[package-transforms.ts](../server/package-transforms.ts)의 `applyPackageTransforms(text, rules, target, {timeoutMs?})`는 서버 worker에서 정규식을 실행해요. 결과는 `{text, applied, changed}`예요. 원문·번역 저장본과 hash는 수정하지 않으며, 호출자는 표시용 결과로만 사용해야 해요. `source` 규칙은 원문 표시에, `translation` 규칙은 번역 표시에만 적용돼요.

일반 JavaScript 정규식과 `gimsuy` flags, 캡처·named capture·여러 줄·치환 토큰을 지원해요. 문자열 길이를 줄이는 것만으로 정규식 안전성을 주장하지 않아요. worker 시간 제한과 메모리 제한으로 과도한 역추적을 중단해요. 패키지의 pattern과 replacement는 `workerData`에 담긴 데이터이며 코드 문자열에 삽입하지 않아요.

한 호출에서 원문 1,000,000 UTF-16 단위, 규칙 32개, 각 pattern 4,096자·replacement 16,384자, 변환 결과 2,000,000자까지 허용해요. 기본 제한 시간은 worker 시작을 포함해 1초이며 호출자가 10ms–10초 안에서 지정할 수 있어요. 잘못된 정규식은 `PACKAGE_REGEX_INVALID`, 시간 초과는 `PACKAGE_TRANSFORM_TIMEOUT`, 결과 초과는 `PACKAGE_TRANSFORM_OUTPUT_LIMIT`로 실패해요. 오류를 빈 성공 결과로 바꾸지 않아요. 패턴 문법 오류는 worker 실행 시 확인해요.

선택적 `behavior`는 타입 있는 상태·행동·기록된 추첨·출력 파서를 제공해요. 작성·실행·복구 방법과 범위는 [패키지 동작](PACKAGE-BEHAVIOR.md)에 있어요. Lua·임의 JavaScript 실행, Risu 호환 스크립트, HTML/CSS 삽입은 제공하지 않아요.

[package-presentation.ts](../server/package-presentation.ts)의 `buildPackagePresentation`은 원문 Run의 패키지 정의로 표시용 원문과 번역을 만들어요. 선택적 상태 인자는 해당 원문의 ID/hash와 일치해야 해요. 상태가 없으면 누락 표시를 반환하며 생성 전 상태를 현재 원고 상태로 사용하지 않아요. `format: "plain-text"` 결과를 HTML 실행에 사용하지 않아요.

Reader는 패키지를 사용한 원고에만 `GET /api/chats/:id/sources/:sourceId/presentation`을 요청해요. API는 원고 소유 채팅, 원문 hash, 최신 완료 번역과 유효 상태를 확인해요. 원문·번역 수정이나 이야기 포크에는 표시 변환을 사용하지 않아요. 변환 오류는 저장된 본문과 오류 안내로 표시해요. 히든 구간이 있는 원고에서는 경계 제거로 인한 노출을 막기 위해 정규식 표시를 적용하지 않고 기존 히든 Reader를 유지해요. 여러 문단을 합치는 변환 결과는 하나의 표시 블록이며 기존 이미지 주석은 그 뒤에 표시해요.

## 검증

`npx vitest run tests/content-package.test.ts tests/package-runtime.test.ts tests/package-context.test.ts`는 합성 자료로 역할별 격리·개정 불일치·본문 보존·조건·상태 표시·정규식 치환 및 과도한 역추적 종료를 검사해요. 원문시점 자료 고정과 구조화 프롬프트의 실제 host context도 확인해요. 실제 작품의 의미 품질이나 모든 브라우저 화면 통합을 증명하는 검사는 아니에요.
