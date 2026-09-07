# 실제 자료 native 이식 계획 · 2026-09-07

> 유지보수 변경: 아래 표의 Phēmē·히든 스토리 전용 변환기와 `scripts/import-pheme.mjs`, 전용 변환 시험은 당시 이식의 역사적 기록이에요. 이후 전용 변환 코드는 제거하고 [공통 이식 가이드](../docs/RISU-PORTING.md)로 대체해요. 이미 생성된 native 자료의 저장·조립·표시 계약은 유지하며, 히든 조립 타입/함수는 `core/hidden-story-runtime.ts`에 분리해요. 현재 회귀 검사는 원본 변환기 대신 합성 native fixture로 실행해요. 아래 과거 검증 수치는 이번 변경의 재검증 결과를 뜻하지 않아요.

상태: 아래 계약에 따른 native 구성·변환기·저장·리더·공급자 연결과 합성 검사를 구현했고, 실제 지정 자료의 별도 로컬 가져오기·조립·화면 확인을 완료했어요. 최초 계획의 단계와 인수 조건은 유지하며, 승인된 Hinano 비성적 각색과 Hidden partial 범위를 구분해요. 최종 빌드와 전체 검사 결과는 [CURRENT.md](CURRENT.md), 구체적 인수 근거와 한계는 [NATIVE-RESULTS.md](NATIVE-RESULTS.md)를 기준으로 확인해요. RisuAI 파일 전체 호환을 주장하지 않고 실제 사용 동작을 Uimori 구조로 옮겨요.

## 지정 자료와 확인 범위

초기 조사에서는 RisuToki의 프리셋·봇·모듈 작성 스킬을 참고하고 headless MCP `inspect_document`/`read_content`로 외부 파일을 읽었어요. 이후 변환기는 구조화된 읽기 결과를 입력으로 사용해요. 원본 파일을 수정하거나 원본 스크립트를 실행하지 않으며, 개인 자료의 외부 모델 전송도 하지 않아요. 기준은 다음 로컬 파일의 이번 열람 시점이며 commit으로 고정한 자료는 아니에요. 원본 본문·원본 에셋을 저장소의 공개 fixture나 문서에 복제·재배포하지 않아요.

| 자료 | 확인한 구조 | 이식 목표 |
| --- | --- | --- |
| `RisuToki/risu/prompts/phēmē/src/pheme-source.md`, `src/pheme-toggles.txt`, `dist/pheme-preset.risup` 및 tool-call variant | V4.0.6 정본/생성본 관계, 일반 risup의 prompt item 45개·regex 5개, system/user/bot 및 history/cache 항목 | role·순서·이력 삽입·조건부 블록·사용자 정의 토글과 조합 저장을 갖춘 프롬프트 구성 |
| `RisuToki/risu/bot/Fujimiya Hinano/Fujimiya Hinano_v2.4.3-test - 복사본.charx` | 첫 메시지·설명·global note·기본 변수·CSS, lore 56개·regex 7개·trigger 1개·Lua 3구역. Lua는 변수 초기화/경계, 버튼·상태 설정, 다음 입력의 장면 주입 구조 | 봇 패키지, 시작 화면/장면 선택, 상태 계산·명시적 사용자 명령, 에셋 표현, 로어 조회 |
| `RisuToki/risu/modules/_🫦히든 스토리 3.43.risum` | 폴더 포함 lore 9개·regex 13개·manual trigger 2개(하나는 effect 없음), Lua 없음. 토글·조건부 지침·CSS/표현 포함 | 본문 사이의 다른 시점 이야기, 접기/제목·스타일, 개수/분량/범위/테마 설정, 등장인물별 지식 경계 |

이 표의 숫자는 조사한 원본 구조의 개수이며 동작 검증이나 모든 내용의 의미 검토 완료를 뜻하지 않아요. 아래 구현 표의 native 에셋·버튼 수와는 별개예요. 원본 에셋의 완전한 호환성을 주장하지 않으며 native 패키지 내부 참조를 검증해요. `risu/`의 다른 자료는 필요할 때 특정 기능과 관련된 것만 읽어요.

## 1. role과 순서를 소유하는 프롬프트 구성

기존 `core/prompts.ts`의 지침 문자열 편집을 유지하면서, 선택한 프리셋이 `program`을 가지면 메시지 조립이 실제 요청을 결정하도록 확장했어요. 구성 편집기는 텍스트 초안과 구조화된 메시지 초안을 구분해 보존해요. 다음은 최초 계약이며 아래 대응표로 구현 위치를 연결해요.

- 프롬프트 프리셋은 모델 연결/추론 설정과 분리해요. 블록마다 안정적인 ID, 종류, 명시적 `system`/`user`/`assistant` role, 순서, 활성 조건을 저장해요. 이력 블록은 원래 대화 role을 유지해요.
- 텍스트·봇/페르소나·상시 자료·이력 구간·현재 입력을 조립해요. Phēmē의 `Initialization Boundary`는 user, `Unified Initialization Receipt`와 `Readiness Echo`의 Risu `bot`은 assistant로 대응해요. 이력을 `0..-2`와 `-2..end`로 나누는 구조는 원본의 경계 의미를 확인해 누락·중복 없이 옮겨요.
- 사용자 정의 토글은 타입·선택지·기본값·조건을 프롬프트 패키지에 보관하고, 자주 쓰는 조합을 채팅별로 선택해요. CBS 전체 실행기 대신 지정 자료가 실제 사용하는 조건/치환을 명시적으로 변환해요. 임의 스크립트 실행은 필요하지 않아요.
- 조립 미리보기는 블록 출처·role·순서·조건 적용 결과를 보여줘요. 설정 revision과 최종 입력을 실행 시점에 고정해요. 도구 권한과 원문 보존 계약은 사용자 프롬프트와 별도로 유지해요.
- 논리적 메시지 배열과 공급자별 전송 형식은 분리해요. 중간 system 메시지, 연속 같은 role, assistant prefill, 캐시 위치를 지원하지 않는 경로는 제한을 명시하고 무음 평탄화를 하지 않아요. prefill은 완료된 assistant 메시지와 구분해요. provider 실제 지원은 구현 시 별도로 확인해요.

| 원본/계약 | native 구현 | 변경·미지원·남은 경계 | 검사 대응 |
| --- | --- | --- | --- |
| Phēmē 일반·tool-call variant와 사용자 토글 | `core/pheme-converter.ts`와 `scripts/import-pheme.mjs`가 두 구조화 입력을 별도로 변환해요. 각 variant의 45개 제어 정의·타입·선택지와 provenance를 보존해요. | 45개 제어와 일반 45개/tool-call 46개 prompt item은 다른 수예요. 원본에 없는 현재 사용자 선택값을 추정하지 않고 `null`로 두며, 선언된 기본값과 권장 조합은 분리해요. 가져온 권장 조합도 명시적으로 선택해야 해요. | `tests/pheme-converter.test.ts`; 실제 지정 자료의 제한된 기준 해석기와 native 조립 비교 결과는 CURRENT에 기록해요. |
| 메시지 role·순서·이력 경계·assistant 형식·캐시 | `core/prompt-program.ts`, `server/prompt-snapshot.ts`가 안정적인 블록 ID와 typed template을 조립하고 선택값·logical history·최종 배열을 Run에 고정해요. | Risu `bot`은 assistant예요. 지원 문법만 변환하며 알 수 없는 필드·연산·인자 수·참조·잘못된 범위는 명시적 오류예요. 일반 CBS/Lua 실행기는 아니에요. | `tests/prompt-settings.test.ts`, `tests/pheme-converter.test.ts`, `tests/native-integration.test.ts` |
| 모델 선택과 분리된 프롬프트·이야기별 조합 | `web/PromptEditor.tsx`, `web/PromptComposer.tsx`에서 블록 편집·이동·조건·JSON import/export와 미적용 초안을 관리해요. 선택값과 이름 붙인 조합을 정확한 preset ID/revision에 저장해요. | 프롬프트 저장·선택값 저장은 명시적 동작이에요. 잘못된 JSON 초안은 지우지 않고, 미저장 편집으로 기존 실행 snapshot을 바꾸지 않아요. | `tests/custom-prompts.test.ts`, `tests/native-browser.spec.ts`의 NUI01 |
| 실제 전송 전 조립 확인과 공급자 역할 제한 | `server/main-request.ts`의 요청 구성을 실제 runner와 무호출 미리보기가 공유해요. 동적 호스트 자료는 첫 history/current 앞의 별도 `native.host-context` user 메시지로 표시해요. | 사용자 블록의 상대 순서·역할·캐시 ID를 유지해요. 프로토콜별 지원 오류를 숨기지 않아요. logical 배열 검사는 실제 유료 모델 실행의 성공을 뜻하지 않아요. | `tests/native-main-request.test.ts`, `tests/native-wire.test.ts`, `tests/transport.test.ts` |
| tool-call variant의 완료와 후속 도구 응답 | variant와 세션 모드에 맞춰 `story.submit` 완료 경계와 일반 최종 텍스트 경로를 연결하고 opaque continuation을 유지해요. | 완료 원문 저장·권한·도구 목록은 호스트 계약이에요. 원본 regex 파이프라인을 범용으로 실행하지 않아요. | `tests/native-main-request.test.ts`, `tests/native-wire.test.ts` |

## 2. 히나노를 실제 사용 가능한 패키지로

설정·첫 메시지·로어·에셋·상태 정의·화면/명령을 한 패키지로 연결하고 채팅별 설정을 분리해요. 상시 필요한 로어와 모델이 목록에서 선택해 조회할 자료를 구분하며, 기존 keyword 발동만을 유일한 조회 경로로 삼지 않아요.

Lua/regex를 그대로 호스트에서 실행하는 대신 동작별로 옮겨요. 장면 버튼은 명시적 명령과 다음 입력에 붙는 장면 선택으로, 변수 초기화·값 제한은 검증된 상태 전이로, 출력의 상태 JSON 추출은 보조 상태 작업으로, 상태창/캐릭터 이미지는 원문에 귀속된 표현으로 대응해요. 처음부터 전부 보조 모델에 맡기지 않고 결정적인 버튼 동작은 코드가 처리해요.

원본 동작 → Uimori 대응 → 미지원/변경점 → 검증 사례를 기록해요. 무시한 기능이 있는데 가져오기 성공으로 표시하지 않아요. 원문 수정·포크·지연 작업에서 상태/이미지가 다른 원문으로 붙지 않는 기존 계약을 유지해요.

구현 범위는 사용자가 승인한 **비성적 일상 재구성**이에요. 원본의 미성년 성적 내용이나 이미지를 포함하지 않아요. 아래 개수는 원본의 동일 내용 재현 수가 아니라 native 패키지에서 검증하는 구성 수예요.

| 원본 동작/구조 | native 구현 | 변경·미지원·남은 경계 | 검사 대응 |
| --- | --- | --- | --- |
| 봇 설명·로어와 자료 간 연결 | `core/native-bot.ts`, `core/native-context.ts`의 비성적 패키지는 로어 노드 56개 중 그룹 11개·조회 가능한 본문 45개를 가지며 그룹·관련 ID·상시/발견형 자료를 구분해요. | 원본 개인 본문을 재배포하지 않고 승인된 일상 범위로 새로 작성했어요. keyword 활성화만을 유일한 검색 경로로 삼지 않아요. | `tests/native-bot.test.ts`, `tests/native-integration.test.ts` |
| 첫 화면·장면 버튼·다음 입력 주입 | 한국어·영어·일본어 시작 장면 10개와 조건이 있는 행동 제안 16개를 제공해요. `web/NativeBotPanel.tsx`에서 선택하면 요청을 예약하고 작성란에 넣을 수 있어요. | 버튼만 눌러 모델을 자동 재생하지 않아요. 장면 예약은 branch·source revision/hash·idempotency에 묶고 생성 시 한 번 소비해요. 임의 Lua/trigger는 실행하지 않아요. | `tests/native-bot.test.ts`, `tests/native-integration.test.ts`, `tests/native-browser.spec.ts`의 NUI02 |
| 변수 초기화·경계·상태 설정 | 친밀도·신뢰도·자립도 3개 수치를 1–100으로 검증하고 언어·응답 길이·장면을 명시적 명령으로 변경해요. `server/native-state.ts`가 원문 근거를 가진 보조 상태 결과를 연결해요. | 결정적인 입력과 범위 보정은 코드가 맡아요. 상태 결과가 늦게 도착하거나 원문이 편집되면 오래된 결과를 현재 상태로 적용하지 않아요. | `tests/native-bot.test.ts`, `tests/state.test.ts`, `tests/story-state-dependencies.test.ts` |
| 캐릭터/장면 이미지 참조 | 패키지 안의 정확한 asset ID에 합성 SVG 114개를 대응하고 장면 심볼과 목록을 표시해요. | 원본 그림을 복사하거나 원본과 같은 시각 표현이라고 주장하지 않아요. 합성 심볼의 존재·참조 검사는 원본 에셋 복원 검사가 아니에요. | `tests/native-bot.test.ts`, `tests/native-browser.spec.ts`의 NUI02 |
| 채팅·분기·상태 소유권과 복원 | `server/native-bot.ts`, `server/native-archive.ts`, `server/chat-fork.ts`가 branch별 설정·동결 snapshot·예약의 소유권을 보존해요. | 포크에 과거 원문/해시는 연결하되 미소비 다음 요청을 새 분기에 자동 실행하지 않아요. 가져오기 실패 시 부분 상태를 남기지 않아요. | `tests/native-bot.test.ts`, `tests/native-integration.test.ts`, `tests/source-editing.test.ts` |

## 3. 히든 스토리의 창작과 표현 분리

핵심 lore는 사용자 시점 본문과 사용자가 지각하지 못하는 다른 시점 이야기를 구분하고, 후자를 본문 문단 사이에 배치하며 관련 인물만 그 정보를 알도록 지시해요. 따라서 이 모듈은 단순 상태창이나 접기 UI가 아니에요.

새 사건을 쓰는 부분은 메인의 창작에 포함하고, 보조 작업은 이미지·상태·표현을 맡도록 설계해요. 본문 구간과 히든 구간은 원문 안에서 식별 가능하게 보존하고, 접힘 여부와 무관하게 번역 대상이 되게 해요. 독자에게 보이는 정보, 등장인물이 아는 정보, 세계에서 발생한 사실을 별도로 표현해 기억/요약에서 지식이 새지 않게 해요. 토글의 대상 범위와 지침 사이에 모호함이 있으면 대응표에 남기고 실제 사용 의도로 확정해요.

| 원본 동작/계약 | native 구현 | 변경·미지원·남은 경계 | 검사 대응 |
| --- | --- | --- | --- |
| 35개 토글·조건부 창작 지침·원본 삽입 순서 | `core/hidden-story-converter.ts`가 35개 제어 ID·타입, 원본 lore index/order/depth와 변환 이슈를 보존해요. `server/hidden-story.ts`가 선택한 모듈과 조합을 snapshot에 고정해요. | 변환 상태는 `partial`이에요. 외부 lore 활성화, 임의 HTML/regex, 외부 POLISH 문맥을 재현하지 않아요. 범위 지침 충돌·선택 불가능한 분기 등은 오류/변경 목록으로 남겨요. Hinano 결합에는 승인된 비성적 조합을 적용해요. | `tests/hidden-story.test.ts`, `tests/native-hidden-integration.test.ts` |
| 본문 문단 사이에 놓이는 다른 시점 이야기 | `core/hidden-story.ts`가 main/hidden/evaluation의 정확한 원문 범위를 나누고 `web/HiddenStoryReader.tsx`, `web/SourceReader.tsx`가 원래 위치에 제목·장소·때·시점과 접기 표시를 넣어요. | 원문은 다시 쓰지 않아요. 모호하거나 깨진 경계는 원문과 진단을 남겨요. 스타일은 해당 리더 안으로 제한하고 원본 CSS가 앱 다른 패널을 바꾸지 않아요. 생성 OFF와 과거 원문 표시 여부도 별개예요. | `tests/hidden-story.test.ts`, `tests/native-browser.spec.ts`의 NUI03 |
| 독자의 열람·인물 지식·세계 사실 구분 | `knownByActorIds` 등은 근거가 없으면 `null`, 지식 상태는 `unknown`으로 남겨요. 명시적 지식에는 같은 구간의 증거 범위와 source revision/hash가 필요해요. | 제목·시점 이름·독자의 펼침으로 인물이 알게 됐다고 추정하지 않아요. 믿음·회상·추정은 자동으로 세계의 사실이 되지 않아요. | `tests/hidden-story.test.ts`, `tests/native-hidden-integration.test.ts` |
| 히든/평가 구간 요청 제외와 기억 조회 | `core/hidden-context.ts`와 source range 필터가 history·참조·기억 소비에 동일한 제외 범위를 적용해요. 제외된 구간을 요약이나 도구 조회로 다시 넣지 않아요. | 접힘은 요청 제외 설정이 아니에요. malformed 경계를 안전하게 분리할 수 없으면 제외 성공으로 처리하지 않아요. | `tests/hidden-story.test.ts`, `tests/native-hidden-integration.test.ts` |
| 접힌 구간까지 번역하고 구조 보존 | `core/auxiliary.ts`, `server/product-auxiliary.ts`가 source-time 문맥과 선택한 번역 program/제어를 고정하고 모든 prose를 번역 대상으로 유지해요. 제목·장소·시간 등의 자연어는 번역하되 원문 marker와 portrait 참조를 검증해요. | 번역 완료 전에 전체 조립 결과의 누락·순서·marker 훼손을 검사해요. 실패 chunk만 재시도하는 기존 계약을 유지하고, actor knowledge와 world truth를 번역 모델의 추정으로 채우지 않아요. | `tests/native-translation.test.ts`, `tests/translation-context.test.ts`, `tests/hidden-story.test.ts` |
| 포크·원문 수정·보관 복원 | 분기 복사와 archive에서 source ID의 대응과 hash·hidden 문맥 귀속을 유지하고 변조된 참조를 거부해요. | 원문 수정 뒤 이전 hash의 번역/상태 결과가 최신 원문에 붙지 않아요. 원문 보존은 개인 자료의 공개 fixture 복제를 의미하지 않아요. | `tests/native-hidden-integration.test.ts`, `tests/native-integration.test.ts`, `tests/source-editing.test.ts` |

## 완료 기준과 순서

1. 프롬프트 구성 저장/편집/미리보기와 provider 변환을 구현하고, role·순서·조건·이력 경계·실행 snapshot을 로컬 검사해요.
2. Phēmē 정본·일반/도구 variant와 토글을 변환하고 주요 토글 조합의 조립 결과를 원본과 비교해요. 본문을 복사한 뒤 이름만 붙이는 것으로 완료하지 않아요.
3. 히나노의 시작 장면·버튼·상태·이미지·로어 조회를 native 패키지로 구현해요.
4. 히든 스토리를 결합하고 시점·번역·접기·기억·포크/원문 수정까지 실제 화면에서 확인해요.

현재 1–4단계의 native 구현과 위 합성 회귀 검사는 마련했어요. UI 검증은 `tests/native-browser.spec.ts`와 `scripts/verify-native-ui.mjs`를 사용하며 새 SQLite·자동 배정 포트·실행별 browser profile/출력으로 격리해요. 시작/종료 build fingerprint, 실제 reporter 결과, 원문/Run/attempt 불변, 자체 프로세스 종료와 증거 보존을 확인해요. 합성 화면 검사를 실제 지정 자료의 import·조립·표시 인수 완료로 대신하지 않아요. 그 별도 결과와 최신 전체 검사 상태는 [CURRENT.md](CURRENT.md)에 기록해요.

로컬 검증은 새 DB·포트와 합성 사례로 실행하고 실제 자료의 가져오기/조립/표시 결과를 별도로 남겨요. 로컬 성공과 실제 모델의 문학·번역·장기기억 품질은 분리해요. 개인 자료의 유료 외부 평가는 현재 중단 상태를 유지해요. 원본 코드/자료의 재배포가 필요하면 해당 라이선스를 먼저 확인해요.
