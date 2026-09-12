# native JSON 가져오기

> 현재 구현의 사용 안내예요. [베타 결정](DECISIONS-2026-09-12-BETA.md)에 따라 Risu 가져오기·표현 변환·선택적 호환 실행을 준비하며 구현/검증 상태는 [베타 계획](../project-plan/BETA-PLAN.md)에 기록해요.

앱은 Uimori의 `ContentPackage`와 `PromptProgram` JSON을 검사하고 편집 초안으로 불러와요. Risu 원본 `.risup`·`.risum`·`.charx`나 Character Card JSON을 앱에서 직접 변환하지 않아요. 원본 이식은 [Risu 자료 이식 가이드](RISU-PORTING.md)에 따라 에이전트가 RisuToki 구조화 도구로 조사한 뒤 native JSON과 대응·손실 보고, 검증 결과를 만드는 방식이에요.

## 봇·페르소나·모듈

서재에서 해당 종류의 자료를 만들거나 편집하고 **패키지 가져오기·내보내기와 역할 사본 → 패키지 JSON 가져오기**를 선택해요.

1. `ContentPackage` 자체, `{ "package": ... }` wrapper 또는 이미지를 포함한 `uimori-package-bundle` JSON을 선택해요. 파일은 64 MiB 이하여야 하며 [native 패키지 스키마](PACKAGES.md) 검증도 통과해야 해요. 이미지 bundle은 서버에서 이미지 hash와 참조를 검사해요.
2. 제목·로어·지침 수를 확인하고 **가져온 패키지로 초안 바꾸기**를 눌러요. 패키지의 제목·설명·본문·내부 자료가 편집 초안에 반영돼요. **가져오기 취소**로 검토를 끝낼 수도 있어요.
3. 내용과 선택한 자료 종류를 확인한 뒤 **자료 등록** 또는 **새 revision 저장**을 눌러요. JSON 선택이나 초안 교체만으로 저장하지 않아요.

wrapper 바깥의 콘텐츠 ID·revision·종류·기타 metadata를 복원하는 기능은 아니에요. 자료 종류는 현재 편집기 선택을 따르고, 저장 시 서버가 콘텐츠 ID/revision과 패키지를 정규화해요. 연결한 공통 모듈은 단일 패키지 파일에 포함하지 않으므로 대상 서재에도 같은 ID·개정이 있어야 해요. 채팅 장착은 저장된 참조로 따로 진행해요. 역할을 바꾸어도 원문의 인물 관점이나 지침을 자동 각색하지 않아요.

## 프롬프트

프롬프트 편집의 메시지 구성에서 **JSON 불러오기**를 선택해요. `PromptProgram` 자체 또는 `program`과 선택적인 `title`·`role`·`values`를 담은 native 파일을 받아요. 파일은 1,500,000 bytes 이하이며 [프롬프트 스키마와 실행 한도](PROMPT-AUTHORING.md)를 검사해요.

성공하면 이름·역할·구성과 옵션 값이 편집 초안에 반영되고 상위 편집기에서 명시적으로 저장해야 해요. 기존 프리셋을 편집 중일 때 다른 역할의 파일은 거절하고 새 프롬프트에서 불러오도록 안내해요. 원본의 ID·revision이나 저장된 옵션 조합 목록을 통째로 복원하지 않아요. `values`가 없는 예전 wrapper의 `suggestedCombination.values`는 기본 옵션 값으로 읽어요. 정의는 `program.controls`, 값은 `values`로 검증하며 내보내기에도 이름·역할·AST·현재 옵션 값을 담아요. 실제 계약은 [prompt-file](../core/prompt-file.ts)을 봐요.

파일 형식이나 스키마 검증이 실패하면 적용된 자료·프롬프트는 유지해요. JSON 가져오기·검증·저장에는 모델 호출이나 원본 스크립트 실행이 없어요. 스키마 통과는 Risu 원본과의 동작 동등성을 뜻하지 않으므로 이식 보고와 대표 동작 검증을 함께 확인해요.

현재 화면 구현은 [LibraryPanel](../web/LibraryPanel.tsx), [PackageTransfer](../web/PackageTransfer.tsx)와 [PromptComposer](../web/PromptComposer.tsx)에 있어요. 전체 DB의 v15 archive 복원은 이 파일 가져오기와 별개이며 [사용 안내](USAGE.md)를 확인해요.
