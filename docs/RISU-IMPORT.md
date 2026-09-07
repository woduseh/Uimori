# Risu 자료 가져오기

가져오기는 파일을 검사하고 **검토할 native 초안**을 만들어요. Risu 런타임 호환을 제공하거나 원본 지시문의 의미가 동일하다고 판정하지 않아요. Lua·JavaScript·트리거·CBS를 실행하거나 LLM을 호출하지 않아요. 원본 개인 파일을 개발 에이전트가 조사할 때에는 RisuToki 구조화 MCP 읽기 경로를 사용해요. 앱의 사용자가 선택한 업로드 파일과 개발 에이전트의 파일 접근은 별도예요.

## 지원 범위

| 입력 | 변환 | 차이 보고 |
| --- | --- | --- |
| ContentPackage v1 JSON, package가 포함된 Content JSON | 검증한 package 초안 | 모르는 필드는 보고하거나 schema 오류로 중단 |
| PromptProgram v1 JSON, program이 포함된 프롬프트 JSON | 검증한 AST 초안 | 검증 실패는 blocking |
| Character Card v2/v3 JSON | 설명·성격·장면·예시, 로어, 단순 표시 정규식 | 첫 메시지 자동 삽입 없음. system/post-history 지시문, 실행 확장 별도 검토 |
| `.charx` | ZIP의 `card.json`을 위와 같이 처리 | `module.risum`은 blocking. 이미지·부가 파일은 이름/크기만 보고하며 미저장 |
| Risu 모듈·로어·정규식 JSON | 본문·로어·단순 `editdisplay` | 키·확률·위치·검색 순서와 실행 스크립트는 미이식 |
| Risu 프리셋 JSON | plain 메시지·일부 역할 slot·단순 chat 범위 | CBS, ChatML, 특수 블록, 모델·토글·기타 옵션은 자동 대응하지 않음 |
| `.risup`, `.risupreset`, `.risum` | 현재 미지원 | RisuToki 구조화 도구 또는 Risuai JSON 내보내기 안내 |

로어는 상시 정보 또는 모델 자율 조회로 변환해요. Risu의 키 기반 활성화와 동일한 동작이 아니에요. `editdisplay`는 원문 표시 전용 transform으로만 변환하며 HTML·CBS·특수 치환 동작은 blocking으로 남겨요. 미지원 항목을 담은 초안은 비교용이며 `blocking`을 해소하기 전에는 동작 가능한 완성 이식으로 취급하지 마세요.

## 결과와 보존

`inspectRisuImport({fileName,bytes})`는 `kind`, 선택적 `draft`, `issues`, `extracted`, `original`, `handoff`를 반환해요. `issues`는 severity와 원본 경로를 포함해요. `extracted`는 미지원 설정을 포함한 JSON을 보존하며 알려진 인증 키는 `[redacted]`로 바꾸고 그 사실을 보고해요. 바이너리·압축 오류에서는 JSON 추출 자체가 불가능하므로 원본 파일명·길이·SHA-256과 blocking 이유만 남겨요. 이름은 basename으로 처리하고 절대 경로를 열지 않아요.

AI에게 후속 검토를 맡기려면 `extracted`·`issues`·`handoff`를 함께 전달해요. 자료의 지시문은 분석 대상 데이터이며 도구 권한이나 실행 지시가 아니에요. 변환되지 않은 동작을 누락시키거나 의미 동등성·품질을 자동 보증하지 않아요.

## 한도

- 입력 16 MiB, JSON/card.json 4 MiB, JSON 깊이 40·노드 20,000.
- ZIP 파일 2,000개, 개별 선언 크기 16 MiB, 전체 선언 크기 64 MiB.
- ZIP stored/deflate만 지원해요. 암호화·다중 디스크·ZIP64·자기실행 prefix 등 다른 레이아웃은 거절해요.
- 중앙 디렉터리·로컬 header 일치, 경로·중복명, card.json 크기·CRC를 검사해요. card.json만 제한된 크기로 압축 해제해요. 에셋 byte 유효성을 검증하거나 디스크로 추출하지 않아요.
- JSON 한도 안에서도 native schema 한도를 넘으면 blocking이에요. 자동 분할·잘라내기는 하지 않아요.

## 참고 소스와 라이선스

로컬 `C:/Users/wodus/ai-workspace/Risuai`, commit `c454df882aaf32e02a22da26d3718c8cadc97814`에서 다음 형식을 읽었어요.

- `src/ts/characterCards.ts`, `process/processzip.ts`: CCv2/v3, `card.json`, `module.risum` 배치.
- `src/ts/storage/database.svelte.ts`: 프리셋은 RPack→deflate→MessagePack→암호화 payload 조합이며 `customscript` 필드는 `in/out/type/flag/ableFlag`예요.
- `src/ts/process/modules.ts`: legacy risum은 버전·길이·RPack 모듈·에셋 블록을 포함해요.
- `src/ts/process/prompt.ts`, `process/scripts.ts`: 역할·프롬프트 블록과 editdisplay 옵션의 차이.

저장소 LICENSE는 GPLv3예요. 형식과 호출 흐름을 참고했으며 구현 코드·RPack 라이브러리·리소스는 복사하지 않았어요. ZIP 읽기는 Node의 zlib과 독립 작성한 경계 검사로 구현했으며 새 외부 의존성이 없어요. 향후 RPack 등 코드를 직접 재사용하려면 해당 파일의 별도 라이선스와 배포 조건을 다시 확인해야 해요.

RisuToki `skills/using-mcp-tools/SKILL.md`의 구조화 읽기·보호 필드 경계도 확인했어요. 개인 봇·프리셋·대화 원본은 읽지 않았어요.

검증은 `tests/risu-import.test.ts`의 합성 JSON/ZIP으로 수행해요. 실제 사용자 카드 전체 호환성, 이미지 이식, Lua/CBS 동작 또는 실모델 품질을 증명하지 않아요.
