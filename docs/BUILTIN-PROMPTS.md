# 기본 제공 프롬프트

2026-09-11에 사용자가 승인한 Uimori용 Phēmē·Hermēneía와 작문 협업 프리셋을 기본 제공해요. 새 DB의 현재 작문은 **Phēmē**, 번역은 **Hermēneía**로 시작해요. 협업은 기본으로 켜지지 않아요. 기존 DB의 현재 작업본·선택 옵션·저장 프리셋·과거 Run은 교체하지 않아요.

## 선택과 편집

프롬프트 관리의 **기본 프롬프트**에서 원하는 항목을 추가해요. 추가하면 새 ID의 일반 프리셋으로 저장하고 편집할 수 있어요. 현재 프롬프트 설정에서 그 프리셋을 선택하면 다음 요청부터 적용돼요. 프리셋 추가만으로 현재 작업본을 바꾸지 않아요. 삭제하거나 편집한 사본을 시작할 때마다 복구하거나 덮어쓰지 않으며, 기본 제공 목록에서 다시 추가할 수 있어요.

| ID | 제목 | 역할·구성 |
| --- | --- | --- |
| `pheme` | Phēmē | 작문. RP·소설·OOC의 3개 모드, 45개 옵션 |
| `hermeneia` | Hermēneía | 한국어 문학 번역 |
| `pheme-collaboration` | Phēmē · 협업 | 인물·관계·대사 / 설정·연속성 / 전개·미해결 줄기 |
| `pheme-simulation` | Phēmē · 시뮬레이션 협업 | 기본 3명 + 장외 인물·세계의 움직임 |
| `pheme-ooc` | Phēmē · OOC 검토 | 근거·설정·수정의 일관성을 검토하는 1명 |

작문의 기본값은 원본을 유지해요. RP·영어 응답·Shared Authorship·Decree로 시작하며 옵션에서 바꿀 수 있어요. OOC 검토 사본만 모드 기본값을 OOC로 바꿔요. 번역 출력은 한국어예요. Shared Authorship는 사용자 캐릭터의 공동 서술을 허용하는 선택이므로, 사용자가 자기 캐릭터의 서술을 직접 맡으려면 서술권 옵션을 바꿔요.

협업 사본은 선택하면 협업이 켜져 있고 모든 협업자가 `on-demand`로 참여해요. 모델을 지정하지 않아 메인 모델을 따르며, 전체 보조 호출 상한은 8/8/4예요. 보조의 조회 왕복도 Run 전체 호출 예산에서 차감돼요. 프리셋 추가·적용으로 모델·Run 호출 예산을 변경하지 않아요. 의견·조회 근거·초안을 선택해서 전달하는 계약과 불확실 실행 처리는 [작문 협업](AGENT-COLLABORATION.md)을 따라요.

## 제공과 출처

`server/builtin-prompts.ts`가 고정 ID 목록과 독립 사본 생성을 담당해요. `GET /api/prompt-templates`는 작은 제목·역할·설명 목록만, `GET /api/prompt-templates/:id`는 선택한 프로그램과 해석한 기본 옵션을 반환해요. 두 API는 읽기 전용이에요. 추가·편집·적용은 기존 프리셋 및 현재 작업본 API의 검증·revision·초안 보호를 사용해요.

원문은 `server/builtin-prompts/`에 포함해요. 작문 본문 1개, 번역 본문 1개, 협업 정의 3개로 보관해서 작문 본문 네 벌의 중복을 피했어요. 가져오기 사본의 작성된 블록·역할·순서·컨트롤과 번역 원칙은 보존해요. OOC의 모드 기본값 이외의 실행 내용은 바꾸지 않아요. 오래된 변환 기록의 누락된 보고서 링크는 이 문서를 가리키도록 정리했어요. `provenance.sourceHash`는 최초 Phēmē 원문의 해시이며 현재 JSON 파일의 해시가 아니에요.

제품 반영의 기준 사본은 다음과 같아요. 원본과 개인 생성 스크립트·검증 보고서·로컬 경로는 제품 번들에 포함하지 않아요.

| 2026-09-11 기준 사본 | SHA-256 |
| --- | --- |
| Uimori용 Phēmē 작문 | `09f79ac0648bf37fb01997eada50bc07566ea5302f605c4a87d803eb3c1ec6c3` |
| Uimori용 Hermēneía 번역 | `8e1ead7ffc2b66485e7dc659ddb32930f37daddf313996bd1b6f809e1556f9b1` |
| Phēmē 기본 협업 3명 | `8035ae951381fc2f42a4ef459965f68de7db0656509f2b7934a5ba924e11899b` |
| Phēmē 시뮬레이션 협업 4명 | `7afe27cdeeea802e24c4d1412eb53a46bf8676dd0a74ecafa15a385b466eeb02` |
| Phēmē OOC 검토 | `d55e87a2b6bd97927920aec3b9b48d03f0c2c94ce47f1f3dfd11b069b1882477` |

## 검증 범위

`tests/builtin-prompts.test.ts`는 새 환경의 초기 선택, 기존 DB 재시작 시 보존, 목록 조회의 비변경성, 추가와 적용의 분리, 독립 사본, 작성된 세 모드의 컴파일과 번역 원문 1회 전달을 확인해요. 합성 브라우저 검사는 `npm run verify:packages`에 포함돼요. 실제 모델의 창작·번역 품질과 비용·지연은 별도 평가 대상이에요.

2026-09-11 제품 반영 검증은 다음과 같아요.

- `npm run quality:full`: 서식·lint·타입·의존성·하네스 회귀·빌드 PASS, 단위/통합 **1,959 PASS / 1 opt-in skip**. 로그는 `output/builtin-prompts-quality-full-verified-20260911.log`예요.
- `npm run verify:smoke`: F02·F03·F06 **3 PASS**, cleanup PASS. 실행 ID는 `2026-09-11T10-50-11-633Z-6555b2bc`예요.
- `npm run verify:packages`: **10 PASS**, cleanup PASS. 실행 ID는 `package-ui-2026-09-11T10-50-10-359Z-70559391`예요. 새 BPTUI01·02는 5개 목록·추가·편집·현재 작업본 및 다른 미저장 초안 보존·폴더 배치·오류 재시도·중복 클릭을 검사해요. 390/1440px PNG도 직접 확인했어요.
- 두 앱 검사의 소스/빌드 지문은 `a53c7418b2f5d3d8656f71c7712f444987ab4945f34224a40cc98dc8d125bc58`로 같아요. 각각 `output/playwright/<실행 ID>/summary.json`에 reporter·DB·cleanup 증거가 있어요.

첫 전체 실행은 **1,940 PASS / 19 FAIL / 1 opt-in skip**이었어요(`output/builtin-prompts-quality-full-final-20260911.log`). 기존 짧은 프롬프트를 가정한 전용 옵션 fixture와 번역 원문 추출·Vertex 첫 요청 판별을 수정했어요. 문맥 예산 전용 검사는 자신이 측정하는 짧은 프롬프트를 명시하고 기존 예산 단정은 유지해요. 실패 기록은 그대로 보존하며 위 최종 전체 결과와 구분해요. 제품 검증·입력 예산·provider continuation 단정을 완화하지 않았어요.
