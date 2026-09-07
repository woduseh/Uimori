# native JSON 가져오기

앱은 Uimori의 `ContentPackage`와 `PromptProgram` JSON을 검사하고 편집 초안으로 불러와요. Risu 원본 `.risup`·`.risum`·`.charx`나 Character Card JSON을 앱에서 직접 변환하지 않아요. 원본 이식은 [Risu 자료 이식 가이드](RISU-PORTING.md)에 따라 에이전트가 RisuToki 구조화 도구로 조사한 뒤 native JSON과 대응·손실 보고, 검증 결과를 만드는 방식이에요.

## 봇·페르소나·모듈

서재에서 해당 종류의 자료를 만들거나 편집하고 **패키지 가져오기·내보내기와 역할 사본 → 패키지 JSON 가져오기**를 선택해요.

1. `ContentPackage` 자체 또는 `{ "package": ... }`를 담은 JSON을 선택해요. 파일은 1,500,000 bytes 이하여야 하며 [native 패키지 스키마](PACKAGES.md) 검증도 통과해야 해요.
2. 제목·로어·지침 수를 확인하고 **가져온 패키지로 초안 바꾸기**를 눌러요. 패키지의 제목·설명·본문·내부 자료가 편집 초안에 반영돼요. **가져오기 취소**로 검토를 끝낼 수도 있어요.
3. 내용과 선택한 자료 종류를 확인한 뒤 **자료 등록** 또는 **새 revision 저장**을 눌러요. JSON 선택이나 초안 교체만으로 저장하지 않아요.

wrapper 바깥의 콘텐츠 ID·revision·종류·기타 metadata를 복원하는 기능은 아니에요. 자료 종류는 현재 편집기 선택을 따르고, 저장 시 서버가 콘텐츠 ID/revision과 패키지를 정규화해요. 채팅 장착은 저장된 참조로 따로 진행해요. 역할을 바꾸어도 원문의 인물 관점이나 지침을 자동 각색하지 않아요.

## 프롬프트

프롬프트 편집의 메시지 구성에서 **JSON 불러오기**를 선택해요. `PromptProgram` 자체 또는 `{ "program": ... }` JSON을 받아요. 파일은 1,500,000 bytes 이하이며 [프롬프트 스키마와 실행 한도](PROMPT-AUTHORING.md)를 검사해요.

성공하면 프롬프트 구성 초안이 바뀌고 상위 편집기에서 명시적으로 저장해야 해요. wrapper의 제목·ID·revision·역할을 통째로 복원하지 않아요. 별도 텍스트 지침 저장 방식은 없고 간단 편집과 구성 편집이 같은 `program`을 수정해요. 선택적인 `suggestedCombination`은 옵션과 함께 검증하고 **가져온 권장 조합을 목록에 추가**로 별도 적용해요. 조합 저장도 해당 편집기의 명시적 저장을 따라요.

파일 형식이나 스키마 검증이 실패하면 적용된 자료·프롬프트는 유지해요. JSON 가져오기·검증·저장에는 모델 호출이나 원본 스크립트 실행이 없어요. 스키마 통과는 Risu 원본과의 동작 동등성을 뜻하지 않으므로 이식 보고와 대표 동작 검증을 함께 확인해요.

현재 화면 구현은 [LibraryPanel](../web/LibraryPanel.tsx)과 [PromptComposer](../web/PromptComposer.tsx)에 있어요. 전체 DB의 v10 archive 복원은 이 파일 가져오기와 별개이며 [사용 안내](USAGE.md)를 확인해요.
