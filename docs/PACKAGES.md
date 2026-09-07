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
- `loreContext`로 고정 로어의 배경/장면 배치·그룹·순서를 정해요. 실제 읽은 자동 로어의 다음 턴 유지와 정리 정책은 [로어 문맥](LORE-CONTEXT.md)에 있어요.
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

Reader는 패키지를 사용한 원고에만 `GET /api/chats/:id/sources/:sourceId/presentation`을 요청해요. API는 원고 소유 채팅, 원문 hash, 최신 완료 번역과 유효 상태를 확인해요. 원문·번역 수정이나 이야기 포크에는 표시 변환을 사용하지 않아요. 변환 오류는 저장된 본문과 오류 안내로 표시해요. 별도 원문 구간이 선언된 원고에서는 경계 제거로 인한 노출을 막기 위해 정규식 표시를 적용하지 않고 구간 Reader를 사용해요. 표현 변환으로 문단 대응을 확인할 수 없는 이미지는 숨기고 위치를 확인할 수 없다는 안내를 표시해요. 별도 본문 구간에 속한 이미지는 해당 구간 안에서만 표시해요.

## 공통 자료 제작과 역할 사용

서재의 종류는 분류이며 실행 역할을 제한하지 않아요. 봇·페르소나·모듈 어느 종류의 패키지든 **이 자료를 봇으로 시작**하거나 **페르소나로 사용**할 수 있어요. 역할 사본은 별도 자료를 만드는 선택이며, 역할 사용 자체는 ID나 원본 종류를 바꾸지 않아요. 페르소나도 본문·로어·이미지·지침·옵션·동작을 같은 형식으로 작성해요.

옵션 편집기는 토글·선택형·숫자·텍스트, 기능 그룹 `group`, 표시 조건 `visibleWhen`을 지원해요. 표시 조건은 같은 패키지의 옵션을 읽으며, 숨겨진 입력의 값도 유지해요. 표시 조건 자체는 실행 조건이 아니므로 지침 활성화는 `when`으로 정해요. 옵션·지침의 미적용 초안은 탭 이동 후에도 유지하며 검증 후 적용해야 자료를 저장할 수 있어요. 지침은 대상 역할·위치·부착 역할·조건·템플릿을 편집할 수 있어요. 보관 본문을 고쳐도 실행 `template`은 유지하며 일반 본문으로 바꾸는 동작을 명시적으로 선택해야 제거돼요.

## 공유 모듈과 원문 구간

`modules?: {id, revision}[]`는 이 자료가 요구하는 공통 모듈을 고정된 개정으로 연결해요. 여러 봇이나 페르소나가 같은 모듈을 요구하면 `module` 역할에서는 한 번 장착해요. 같은 ID의 다른 개정, 순환 참조, 깊이 20·총 100개 제한을 넘는 연결은 거부해요. 채팅에는 사용자가 고른 루트 장착만 저장하고, Run snapshot에는 확장한 전체 패키지와 개정을 고정해요. 필수 모듈은 채팅 설정에서 개별 해제하지 않으며 이를 요구하는 루트를 해제해야 해요. 공유 정의의 상태는 기존 채팅·분기·장착 인스턴스 범위로 분리돼요.

`sourceSegments?: {version:1,rules:[...]}`는 자료가 사용하는 원문 경계와 접힘·요청 제외·유지 길이를 선언해요. **연결과 기능**에서 규칙을 편집하거나 native JSON으로 조건식을 작성해요. 마커·지침·옵션의 이름과 개수는 자료가 정하며, 전용 Hidden 자료 연결이나 고정 35개 옵션은 없어요. 여러 장착 자료의 충돌하는 선언은 거부하고 Run에는 당시 옵션으로 평가한 규칙을 고정해요. 구조와 원문·번역·기억 보호는 [원문 구간](SOURCE-SEGMENTS.md)을 봐요.

## 공통 이미지

`images`는 `{id, title, description, blobHash, mime, allowedUse}` 목록이고, `portraitImageId`는 그중 대표 이미지 하나를 가리켜요. PNG·JPEG·WebP를 파일당 2,000,000 bytes까지 올릴 수 있어요. 이름·설명·용도를 편집하고 50개 단위 목록에서 검색·선택해요. 같은 이름도 내부 ID로 구분하며 이미지 제거는 새 개정의 참조만 없애므로 과거 패키지·원문에 고정된 이미지는 유지돼요. 파일 내용은 SHA-256을 ID로 하는 불변 blob이고 패키지·Run snapshot에는 base64를 넣지 않아요.

이미지 역할에는 예약한 원문의 ID/hash와 당시 목록을 고정해요. 패키지 참조는 `package:{packageId}:{role}:{imageId}`이며 개정·파일 hash·사용 용도를 함께 검증해요. 검색 도구는 이름과 설명의 metadata를 페이지로 반환하고, 전체 이미지 목록이나 bytes를 모델에 넣지 않아요. 장면의 이름·의상·장소 문자열 일치를 필수 정답으로 삼지 않아요. 실제 장면에 적절한 이미지를 고르는 의미 품질은 모델 평가가 필요해요.

Reader의 **이미지 선택 / 다시 선택**은 현재 서재 장착과 채팅 이미지의 목록을 새로 고정해요. 모델·역할 지침은 해당 원문 Run의 snapshot을 사용해요. 원문 hash와 이미지 작업 개정의 CAS로 중복·낡은 요청을 거부하고, 진행 중인 같은 작업은 재사용해요. 새 선택은 최신 이미지 슬롯을 교체하며 저장 원문을 고치지 않아요. 표시할 때도 참조·개정·hash·용도를 다시 확인해요.

패키지 JSON 내보내기는 이미지가 있으면 이미지 bytes를 포함한 `uimori-package-bundle`을 만들어요. 가져오기는 64 MB 이내 파일의 hash와 모든 이미지 참조를 검증한 뒤 초안 적용을 제안해요. 연결한 공통 모듈은 이 단일 패키지 파일에 포함하지 않으므로 대상 서재에 같은 ID·개정이 필요해요. 전체 자료와 채팅의 이동에는 기존 전체 보관 기능을 사용해요. 이미지 목록이 없으면 비어 있으며 합성 기본 이미지를 자동 주입하지 않아요.

## 도입문과 채팅 시작

`starts`는 최대 20개의 `{id, title, description?, mode, text, values?, initialAction?}` 선택지예요. `authored`는 작성된 원문을 정확히 저장하며 100,000자까지, `generate`는 4,000자까지의 요청을 기존 메인 실행기에 전달해요. 새 채팅 화면에서 미리보기·이번 채팅 옵션을 확인하고 확정해요. 단순 미리보기는 Run·상태·모델 호출을 만들지 않아요.

작성된 도입문은 모델 attempt, 상태·기억 보조 예약이나 자동 이미지 작업을 만들지 않아요. Reader에는 작성된 도입문으로 표시하고, 다음 모델 대화에서는 실제 도입문만 assistant 이력에 들어가요. 초기 행동은 기존 타입 검증·상태 실행 계약으로 한 번 실행하며 채팅 옵션·원문 귀속을 유지해요. 확정 요청의 idempotency key는 응답 유실 시 같은 결과를 돌려주고, 다른 시작을 다시 확정하는 요청은 거부해요. 실행 옵션과 초기 상태는 채팅에 속하며 페르소나나 패키지 원본을 수정하지 않아요.

## 검증

`npx vitest run tests/content-package.test.ts tests/package-runtime.test.ts tests/package-context.test.ts`는 합성 자료로 역할별 격리·개정 불일치·본문 보존·조건·상태 표시·정규식 치환 및 과도한 역추적 종료를 검사해요. 원문시점 자료 고정과 구조화 프롬프트의 실제 host context도 확인해요. 실제 작품의 의미 품질이나 모든 브라우저 화면 통합을 증명하는 검사는 아니에요.
