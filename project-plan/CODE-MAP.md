# 개발 작업의 코드 지도

관련 행의 계약과 진입점부터 읽어요. 이 지도는 기능·지원 범위를 새로 정의하지 않으며 전체 읽기가 작업의 선행 조건도 아니에요. 현재 목표는 [BETA-PLAN](BETA-PLAN.md), 제품 원칙은 [베타 결정](../docs/DECISIONS-2026-09-12-BETA.md), 검사 시점은 [QUALITY](../docs/QUALITY.md)가 소유해요. 세부 제약은 계약과 실제 호출 경로에서 확인하고 경로가 바뀌면 해당 행을 갱신해요.

| 작업 분야 | 계약 | 먼저 볼 코드 |
| --- | --- | --- |
| Risu 파일·단방향 변환 | [가져오기](../docs/RISU-IMPORT.md), 지원 밖의 수동 이식만 [이식 안내](../docs/RISU-PORTING.md) | `server/character-card-file.ts`, `import-envelope.ts`, `risu-import.ts`와 단계별 `risu-import-*.ts`, `risu-plugin-import.ts`, `uploads.ts`, `risu-preset-file.ts`, `risu-preset-import.ts`, `risu-module-file.ts`, `risu-module-json.ts`, `compat/risu/lorebook.ts`, `compat/risu/rpack.ts`; `core/risu-plugin.ts`; `third_party/risuai/cad8595a/lorebook.ts` |
| 이름·기본 변수·CBS·프롬프트 AST | [프롬프트 실행](../docs/PROMPT-RUNTIME.md), [패키지](../docs/PACKAGES.md), [예약 snapshot 영수증](../docs/RESERVATION-SNAPSHOTS.md#snapshot-영수증) | `core/prompt-program.ts`, `template-variables.ts`, `package-identity.ts`, `package-runtime.ts`, `risu-compat.ts`; `server/risu-cbs.ts`, `compat/risu/cbs.ts`; `third_party/risuai/cad8595a/cbs.ts`, `cbs-parser.ts`, `cbs-support.ts` |
| 분기 공유 변수·직접 편집·시점 보관 | [공유 변수](../docs/PROMPT-RUNTIME.md#분기-공유-변수), [패널](../docs/PACKAGE-PANELS.md) | `core/chat-variables.ts`, `template-variables.ts`; `server/chat-variables.ts`, `chat-variables-archive.ts`, `chat-variable-context.ts`, `chat-variable-routes.ts`; `web/ChatVariables.tsx` |
| 공유 패키지·로어·시작·이미지 | [패키지](../docs/PACKAGES.md), [로어 문맥](../docs/LORE-CONTEXT.md) | `core/content-package.ts`, `package-context.ts`, `package-start.ts`; `server/product-store.ts`, `package-start.ts`, `package-images.ts` |
| 확장 상태·행동·상태 변환 | [행동](../docs/PACKAGE-BEHAVIOR.md), [확장 코드](../docs/EXTENSION-PROGRAMS.md) | `core/package-behavior.ts`; `server/package-behavior-host.ts`, `package-behavior-store.ts`, `package-behavior-run.ts`, `package-behavior-archive.ts` |
| 격리 실행·Host 호출·영수증 | [확장 코드](../docs/EXTENSION-PROGRAMS.md) | `server/package-extension-execution.ts`, `extension-runtime.ts`, `extension-worker.ts`, `extension-lua-worker.ts`, `extension-program-receipt.ts`, `extension-materials.ts`, `extension-model.ts`, `extension-variables.ts`; `core/extension-model.ts` |
| 현재 분기 대화 읽기·고정 참조 | [대화 Host](../docs/EXTENSION-PROGRAMS.md#host-api로-현재-분기-대화-읽기) | `core/extension-conversation.ts`, `reader-conversation.ts`; `server/extension-conversation.ts`, `extension-conversation-access.ts`, `package-conversation.ts`, `snapshot-archive.ts` |
| Risu 트리거·Lua 콜백·변수/JSON·대화·조건 | [Lua 가져오기](../docs/RISU-IMPORT.md#lua-콜백-가져오기), [선언형 효과](../docs/RISU-IMPORT.md#선언형-트리거-효과) | `server/risu-lua-adapter.ts`, `risu-trigger-effects.ts`, `risu-variable-defaults.ts`, `risu-import.ts`, `risu-cbs.ts` |
| 생성 전/후·사용자 모델 작업 | [확장 코드](../docs/EXTENSION-PROGRAMS.md), [예약](../docs/RESERVATION-SNAPSHOTS.md) | `server/package-behavior-run.ts`, `package-after-response.ts`, `extension-request-edit.ts`, `extension-response.ts`, `extension-operation-runner.ts`, `extension-operations.ts`; `core/after-response.ts`, `extension-request-edit.ts`, `extension-operation.ts` |
| 확장 화면·정규식·본문 구간 | [패널](../docs/PACKAGE-PANELS.md), [변환](../docs/PROMPT-TRANSFORMS.md), [구간](../docs/SOURCE-SEGMENTS.md) | `web/PackagePanelFrame.tsx`; `core/package-panels.ts`, `source-context.ts`; `server/text-transforms.ts`, `prompt-transforms.ts`, `package-presentation.ts`, `package-requests.ts` |
| 본문 예약·모델 전송·복원 | [예약](../docs/RESERVATION-SNAPSHOTS.md), [실행 구성](../docs/RUNTIME-SIMPLIFICATION.md) | `server/reservation-snapshot.ts`, `prompt-snapshot.ts`, `main-request.ts`, `model-runner.ts`, `snapshot-archive.ts`, `store.ts` |
| DB·자료 이동·백업 | [이관](../docs/DATA-MIGRATIONS.md), [자료 이동](../docs/NATIVE-TRANSFER.md), [채팅 백업](../docs/CHAT-BACKUP.md), [본문 교환](../docs/CHAT-TRANSCRIPT.md) | `server/schema-migrations.ts`, `product-store.ts`, `native-transfer.ts`, `chat-backup.ts`, `chat-backup-codec.ts`, `chat-transcript.ts`, `source-editing.ts` |
| 프롬프트·역할 모델·공급자 | [전역 모델](../docs/GLOBAL-MODELS.md), [공급자](../docs/PROVIDERS.md), [옵션](../docs/MODEL-PARAMETERS.md), [비용](../docs/MODEL-PRICING.md) | `server/prompt-workspace.ts`, `provider-connection-test.ts`; `core/model-capabilities.ts`, `provider-cache.ts`, `provider-catalog.ts`, `provider-rejection.ts` |
| 문맥·요약·메모·상태 준비 | [문맥 한도](../docs/CONTEXT-LIMITS.md), [상태 준비](../docs/STATE-PREPARATION.md) | `server/context-planning.ts`, `context-compaction.ts`, `context-store.ts`, `story-notes.ts`, `story-store.ts`, `context-tools.ts`; `core/context-budget.ts` |
| 도우미·초안·협업 | [도우미 계획](HELPER-CONTEXT-PLAN.md), [협업](../docs/AGENT-COLLABORATION.md) | `server/helper-runtime.ts`, `helper-workspace.ts`, `edit-drafts.ts`, `chat-overrides.ts`, `agent-collaboration.ts` |
| 구성·삽화 | [구성](../docs/OUTLINE.md), [삽화](../docs/ILLUSTRATIONS.md) | `server/outline-store.ts`, `outline-routes.ts`, `illustrations.ts`, `illustration-runner.ts`, `comfyui-client.ts`, `codex-runtime.ts` |
| 서재·Reader·UI | [UI 원칙](../docs/UI-PRINCIPLES.md), [서재](../docs/LIBRARY.md), [읽기](../docs/READING.md) | `server/reader.ts`, `chat-organization.ts`, `library-organization.ts`; `web/useStory.ts`, `SourceReader.tsx`, `Prose.tsx`, `NewStory.tsx` |
| 진단·설치·업데이트 | [진단](../docs/DIAGNOSTICS.md), [self-host](../docs/SELF-HOST.md), [업데이트](../docs/UPDATES.md), [Oracle 릴리스](../docs/ORACLE-RELEASE.md) | `server/diagnostic-report.ts`, `network-policy.ts`, `access-session.ts`, `maintenance.ts`; `./compose.yaml`, `deploy/nginx.conf`, `scripts/release-oracle.mjs`, `scripts/update-controller.mjs`, `scripts/uimori-update.mjs` |
| 검사 실행기·환경 문제 | [품질](../docs/QUALITY.md), [개발](../docs/DEVELOPMENT.md), [검사 운영](../docs/TESTING-AUDIT.md) | `package.json`, `scripts/browser-verification.mjs`, `scripts/lib.mjs`, `tests/harness.test.ts`, `tests/module-cycles.test.ts` |

같은 디렉터리의 연속 파일은 첫 경로의 디렉터리를 이어 읽어요. 모듈·함수 이동 여부는 `rg --files`·심볼 검색으로 확인해요. 관련 검사 이름도 `tests/`와 `package.json`에서 찾아 실제 범위로 선택해요.

## 확장 작업에서 먼저 확인할 연결

- 공통 실행은 `executePackageExtensionProgram`, 계산 영수증 생성은 `createExtensionProgramReceipt`를 사용해요. `onExecuted`는 채택 전 계산 보존이고 진행·취소·CAS·저장은 호출자가 소유해요.
- 사용자 버튼의 모델 호출·대화 읽기는 기존 actions API와 영구 extension operation을 사용해요. 생성 전은 deferred preparation, 응답 후는 고정된 완성 본문과 별도 afterResponse 영수증을 사용하며 가짜 본문 Run이나 중복 Host 실행기를 만들지 않아요.
- 모델 호출은 공통 `createExtensionModelService`·`authorizeExtensionModelAccess`의 자료 개정·grant·모델/연결 확인을 거쳐요. 자기 자료 조회는 `extension-materials.ts`와 고정 profile을 사용해요. 기존 지원은 해당 계약에서 확인하고 새 capability는 권한·취소·보존까지 실제 흐름에 연결해요.
- 대화 조회는 Reader와 같은 가시 순서의 run/source hash 참조를 예약에 고정하고 `extension-conversation-access.ts`에서 정확한 자료 개정의 과거·최신 grant를 확인해요. 읽은 view의 hash만 영수증에 남기며 참조가 없으면 현재 DB에서 보충하지 않아요.
- 공유 변수 Host는 `createExtensionVariableSession`에서 임시 변경과 읽기 의존성을 보관하고 `adoptExtensionVariableMutation`으로 기존 행동/source transaction에 채택해요. 생성 전/모델의 `commitRunBehaviorVariables`는 인스턴스별 묶음이 아닌 전체 실행 순서를 유지하고, 응답 후는 패키지별 성공·rollback 경계를 따라요.
- `previewBehaviorUpgrade/applyBehaviorUpgrade`는 명시적으로 계산한 후보의 CAS 채택이에요. 일반 조회·저장·복원에서 변환을 실행하지 않아요. 계산 실패나 미반영 결과와 유효한 현재 상태를 구분해요.
- Risu 기본 변수는 저장된 공유 state의 초기 복사본이 아니에요. 읽기 기본값과 저장된 공유 쓰기/Lua 실행의 지원 여부는 해당 계약에서 확인하고 패키지 인스턴스의 state로 조용히 대체하지 않아요. CharX 내부 모듈은 같은 카드의 canonical 자료이며 별도 장착 모듈로 중복 등록하지 않아요.

## 문서를 갱신할 때

루트 AGENTS에는 작업 원칙과 공통 보존 경계만 유지해요. 이 지도에는 경로와 연결 관계, 계약 문서에는 현재 의미·한도, BETA-PLAN에는 현재 작업과 완료 근거를 둬요. 과거 AGENTS의 자세한 설명은 Git 이력 `1c055ef:AGENTS.md`에서 확인할 수 있으며 현재 지침으로 다시 로드하지 않아요.
