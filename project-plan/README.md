# Uimori 계획과 인수 기준

이 디렉터리는 제품 범위·설계·검증 계약을 관리해요. v0.6.1 착수 명세(2026-09-06)를 바탕으로 후속 사용자 결정과 구현 결과를 반영했어요. **현재 진행은 [CURRENT.md](CURRENT.md)**, 앱 실행은 [루트 README](../README.md)를 먼저 확인해요.

## 문서 지도

| 파일 | 내용 |
| --- | --- |
| [CURRENT.md](CURRENT.md) | 현재 구현, 검증 근거, 남은 작업 |
| [PROJECT.md](PROJECT.md) | 목적, 우선순위, 실제 사용 조건, 비목표 |
| [MILESTONES.md](MILESTONES.md) | M0–M3 범위와 종료 조건 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 데이터·자율 조회·역할별 처리·번역·상태·이미지 계약 |
| [VERIFICATION.md](VERIFICATION.md) | 검사·실패·승인·증거 계약 |
| [ACCEPTANCE.json](ACCEPTANCE.json) | 인수 ID, 기대 결과, 증거와 주장 한계 |
| [SOURCES.md](SOURCES.md) | 참고 자료와 채택·비채택 근거 |
| [M0 결과](M0-RESULTS.md) · [M1 결과](M1-RESULTS.md) · [M2 결과](M2-RESULTS.md) | 단계별 구현과 당시 검증 기록 |
| [UI 결과](UI-RESULTS.md) · [Sol 결과](SOL-RESULTS.md) | 후속 UI·공급자 통합 기록 |

새 작업은 CURRENT에서 남은 범위를 확인한 뒤 관련 계약만 읽어요. 인수 목록의 모든 향후 항목을 한 번에 구현할 필요는 없어요. 현재 사용자 요청을 우선하며 파일 간 실질적 충돌은 결정과 영향을 기록해요.

## 초기 명세와 작업 지시

[REVIEW.md](REVIEW.md)는 초기 v0.6.1 명세 검토 기록이에요. `KIT_VALIDATION.json`은 당시 계획 묶음의 구조 검사이며 앱·모델 품질 검증 결과가 아니에요.

[첫 M0 작업 지시](prompts/01-build-M0.ko.md)는 초기 착수 기록으로 보존해요. 후속 작업에는 [이어가기 지시](prompts/03-continue.ko.md), 별도 검토에는 [독립 검토 지시](prompts/02-review.ko.md)를 참고해요. 이미 구현한 M0를 다시 착수하거나 과거 지시를 동시에 실행하지 않아요. [AGENTS 템플릿](templates/AGENTS.md.template)도 초기 참고 자료이며 현재 지도는 [루트 AGENTS.md](../AGENTS.md)예요.

## 자료와 증거

개인 창작 자료는 Git 제외 경로인 `.local/reference/` 등에 보관하고 공개 테스트에는 합성 자료를 사용해요. 다른 공급자 평가로 재전송하거나 공개하려면 해당 범위의 허용이 필요해요.

결과 문서의 `output/` 링크는 해당 로컬 실행을 보관한 환경에서만 열려요. 과거 실패와 snapshot은 당시 근거로 보존하며 현재 인수 상태와 구분해요.
