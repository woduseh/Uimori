# 공통 실행 계약 통합과 전용 경로 정리

2026-09-08 코드베이스 개선 작업이에요. 특정 자료의 옵션·내용·상태 규칙이 제품 실행기에 섞여 있던 경로를 공통 패키지·프롬프트 계약으로 옮겼어요. 이번 작업은 개인 Risu 자료의 재이식이나 유료 시험을 포함하지 않아요.

| 이전 경로 | 현재 구현 |
| --- | --- |
| 고정 CreativeControls·창작 프리셋·자동 분량 지침 | PromptProgram과 그 revision에 속한 옵션 조합. personaReference는 독립 권한 필드 |
| Phēmē variant와 특정 옵션 이름으로 story.submit 활성화 | PromptProgram.execution.storySubmission을 컴파일해 Run에 고정 |
| NativeBot의 고정 상태축·언어·분량·행동 버튼 | ContentPackage의 controls/instructions/behavior/stateView와 user 행동 nextRequest |
| Hidden Story 전용 자료·35개 옵션·시드 지침·고정 마커 | ContentPackage.sourceSegments의 자료별 경계·조건·유지 길이. 지침은 패키지 데이터 |
| native-archive에 섞인 공통 Run 검증·포크 처리 | server/snapshot-archive.ts의 논리 이력·contextPlan·컴파일·구간 정책 검증 |
| 기본 이미지·장면 문자열 추론과 기본 사실 주입 | 합성 fixture에 격리. 실제 이미지 catalog는 명시 등록한 자료만 사용 |
| M0 resources 테이블·생성 callback·archive/포크 복사 | 현재 프로필의 공통 자료 snapshot으로 통일. 테스트 자료도 명시적 패키지로 등록 |
| 봇 없는 채팅과 전용 패널·종료된 live journey 본문 | 생성 시 botId 필수. 공통 편집기로 통합하고 종료 실행기는 명시 BLOCKED만 반환 |

sourceSegments는 저장 원문을 고치지 않아요. 요청·조회·요약·기억에서 source/hash·범위·viewHash를 유지하며 번역 경계와 인물 지식의 불확실성도 검증해요. 새 요청의 정책과 과거 Run의 고정 정책을 구분해요. 세부 계약은 [원문 구간](../docs/SOURCE-SEGMENTS.md)과 [패키지 행동](../docs/PACKAGE-BEHAVIOR.md)을 봐요.

다음 요청 예약은 행동과 같은 트랜잭션에서 기록하고 Run 접수 때 한 번 소비해요. source/hash·조상 원문·profile·상태 revision이 바뀐 예약은 실행할 수 없어요. 중복 행동 응답으로 소비·취소된 예약을 되살리지 않으며 포크에는 새 요청으로 복사하지 않아요.

후보 생성은 원래 Run의 프롬프트 컴파일과 준비된 문맥을 재사용해요. 새 후보 분기의 ID로 원래 프롬프트 조건을 다시 계산하지 않아요. 보관 검증은 후보의 원본 계보·고정 입력·컴파일을 함께 검증하고, 준비되지 않은 문맥도 원본 분기 조건으로 계산해요. 독립 포크는 새 이야기의 범위로 검증해 원본 채팅 삭제 후에도 복원할 수 있어요.

현재 DB와 JSON archive는 **v10**이에요. 구형 v9 DB·archive·전용 native 자료는 자동 변환하지 않아요. 사용자 DB는 열거나 초기화하지 않았어요. 새 형식으로 다시 시작할 때의 명시적 개발 초기화는 [개발 안내](../docs/DEVELOPMENT.md)를 따라요. 과거 이식 보고서는 당시의 증거로 보존하며 현재 공통 형식 호환을 보증하지 않아요.

현재 UI가 사용하는 독립 로어·스킬·명칭집, 후보 API와 독립 채팅 포크, 일반 상태·기억 실행기는 유지해요. 이들은 특정 자료 전용 우회 경로와 별개의 기능이에요. 병행 작업의 포맷·품질 도구·공급자 등록 변경도 보존했어요.

최종 검증은 **PASS**예요. [기계 판독 증거](../output/codebase-cleanup/FINAL-VERIFICATION.json)와 아래 원본 결과를 남겼어요.

| 검사 | 결과 | 증거·범위 |
| --- | --- | --- |
| 품질·타입 | PASS | `npm run quality`: Biome 390개 파일, lint/format 및 TypeScript. [로그](../output/codebase-cleanup/quality-final-pass.log) |
| 빌드 | PASS | [로그](../output/codebase-cleanup/build-final-pass.log). 기존 500 kB 번들 크기 권고는 남아 있어요. |
| 전체 단위·통합 | **1,226 PASS · 1 skip · 0 FAIL** | 115개 파일. [원본 JSON](../output/codebase-cleanup/unit-verified.json). 설치된 Codex CLI 사전 검사는 명시 opt-in이라 실행하지 않았어요. |
| 전체 UI 회귀 | **96/96 PASS** | [최종 브라우저 결과](../output/playwright/redesign-2026-09-07T18-28-27-864Z-b9a63712/summary.json). 새 DB·port·profile, 소스/빌드 일치, 프로세스·runtime cleanup PASS. |
| 직접 화면 확인 | PASS | 390px 예약 카드·프롬프트 옵션·원문 구간 번역·미적용 초안, 1440px 원문 구간 Reader. 두 번째 브라우저 실행의 PNG를 직접 확인했으며 최종 제품 빌드 hash가 같아요. |

최종 source/build는 `66f3ca330b8093f2e75c485cd17027f71d5d270a22339eb4d5abf68be288539e`, 제품 dist hash는 `f492176efb40ced44017c3cb1c70a0a3880289392737b27dc58ba20e5f72a673`이에요. 단위 검사 시 source/build는 `93743f02512bd73a0b3dfd0455847ef0b0768f05da95f6b86ab45b8d1ac564dc`였고, 이후 코드 변경은 PKUI02 브라우저 기대 선택지를 현재 7개로 맞춘 것뿐이에요. 최종 제품 dist hash는 동일해요. 문서 수정은 빌드 입력이 아니에요.

첫 전체 검사 실패(`unit-first.json`)와 후보 복원 반례, 후속 집중 검사도 지우지 않아요. 첫 브라우저 84/96 결과는 소속 봇·명시 이미지 catalog·현행 탭/메시지 계약을 테스트 fixture에 반영하기 전의 증거로 보존해요. 두 번째 95/96 실패는 PKUI02의 남은 자료 종류 기대값을 잡았어요. 검사 실패를 단순 제거하지 않고 원래 검증 목적에 필요한 자료를 명시했어요.

브라우저와 동시에 실행한 단위 검사에서 HTTP 취소/시간 제한 두 건이 시간 초과됐어요. 브라우저 종료 후 해당 두 파일을 단독 실행한 결과는 23/23 PASS(`http-serial.json`)이며 최종 전체 단위·브라우저 검사는 순차 실행했어요. 동시 실행이 원인이라는 확정이나 제품 성능 주장은 하지 않아요.

합성 DB·loopback provider·브라우저 결과만 주장하며 실제 모델 의미 품질·과금·개인 원본 전체 호환·휴대폰/IME·Linux/Docker·외부 배포는 검증하지 않아요. `verify:packages`는 공통 패키지·프롬프트 UI 검사이며 기존 `verify:native` 명령을 대체해요.
