# 런타임 간소화 구현 결과

작업 브랜치: `codex/simplify-runtime`. 기준 commit은 `661befd`이며 별도 작업트리에서 구현했어요. UI v2와의 병합·배포·운영 데이터 변경은 포함하지 않아요. 현재 기능 계약은 [RUNTIME-SIMPLIFICATION.md](../docs/RUNTIME-SIMPLIFICATION.md)를 봐요.

## 변경

- 작문·번역의 프로그램과 옵션을 전역 현재 작업본으로 분리했어요. 프리셋 적용은 복사이며 채팅별 프롬프트 참조를 제거했어요.
- 원문 전체를 일반 텍스트로 번역하고 응답 앞 1,000자만 설정된 경량 모델에 보내 거절을 판정해요. 추가 재요청 기본 1회·허용 0~5회이며 전체 호출 한도 안에서 실행해요.
- 수동 재번역은 현재 설정으로 새 작업을 만들고 실패·취소 시 이전 성공본을 표시해요. 직접 수정은 최신 revision CAS와 worker fencing을 유지해요.
- 성공·실패 원문 요청 모두 현재 설정으로 새 분기에서 재요청할 수 있어요. 과거 실행과 원문, idempotency 영수증은 보존해요.
- 서재·프리셋·모델·연결·이미지는 목록에서 삭제하고 참조 중인 과거 데이터는 유지해요. 현재 모델 선택 정리와 연결 권한 회수는 별도로 처리해요.
- 로컬 도구 입력 오류에는 제한된 교정 기회를 주고 권한 거절·불확실한 외부 실행은 재생하지 않아요.
- schema/archive v14에서 현재 작업본·숨김 상태를 검증해요. 필수 작업본 누락, 숨김 대상 위조, 변경한 작업본의 빈 DB 오인, 프롬프트 조합의 폐기된 참조 의존도 수정했어요.

## 검사 전수 점검과 운영 정리

사용자의 후속 요청으로 단위·통합 132파일, 브라우저 45파일, Node 도구 5파일(총 182파일)의 모든 검사 본문을 점검했어요. 중복 validator·구형 archive 진입·얕은 encoder 검사·브라우저 3개 흐름을 기존 계약에 흡수하고, 추가 화면 폭·정밀 배치·성공 PNG·반복 성능 측정을 선택 실행으로 분리했어요. 테스트만 수정하면 재빌드가 필요 없도록 앱/검증 지문을 분리했어요. [전수 판단과 실행 선택](../docs/TESTING-AUDIT.md)에 모든 파일과 흡수 위치가 있어요.

## 검증

- `npm run quality:full` PASS: 서식·lint·타입, 도구 **31 PASS**, 새 빌드, 단위·통합 **1,353 PASS / 1 opt-in skip**(132파일, 87.02초). 기록: `output/quality-full-audit.log`. 기존 `NR_CODEX_PREFLIGHT=1` 설치 확인은 실행하지 않았어요.
- 빌드: `output/build/build-2026-09-08T15-02-50-258Z-c39d48a1/summary.json`, 앱 sourceHash `3ead5d0eda85569ca30786b276173547091d3fea87e55c815961eb8d0a82863d`.
- 새 `verify:browser-smoke`: **3 PASS**, `output/playwright/browser-smoke-2026-09-08T15-04-54-573Z-5c9001e7/summary.json`.
- 선택 시각 경로: 서재·채팅 설정·dialog focus의 **3 PASS**, 추가 폭·정밀 배치와 필수 PNG 확인. `output/playwright/visual-audit-2026-09-08T15-10-08-543Z-3fda35da/summary.json`. 390px 서재와 1440px 설정 PNG도 직접 확인했어요. 전체 선택 시각 suite를 실행한 결과는 아니에요.
- `benchmark:story`: **1 PASS**, 4차원 × 5개 측정 표본을 `output/benchmarks/story-2026-09-08T15-08-46-197Z-a7dd6345/story-performance.json`에 보존했어요. 별도 브라우저 실행과 겹친 로컬 측정이며 속도 개선 주장에 사용하지 않아요.
- 브라우저 테스트 후속 수정 뒤 `npm run quality` PASS. 앱 소스는 바뀌지 않아 위 빌드를 재사용했어요.

최종 `npm run verify:redesign`은 **161 PASS / 0 FAIL / 0 SKIP**, 293.132초(약 4분 53초)예요. `output/playwright/redesign-2026-09-08T15-16-46-425Z-3ee32eef/summary.json`에 종료 시 앱/검사 동일성·cleanup·canary 검사가 모두 PASS로 기록됐어요. 앱 지문은 위 빌드와 같고 전체 검증 지문은 `459d3b0093dd8e9c26e0c157e0f6e479d843468c8211203e9acfc16177019e7c`예요. 테스트만 수정한 후 앱을 재빌드하지 않고 확인한 결과예요.

정리 후 첫 전체 브라우저는 **157 PASS / 4 FAIL**이었어요(`output/playwright/redesign-2026-09-08T15-05-15-679Z-4d65562c/summary.json`). PLR03/PUNI01/PUNI02의 폐기된 편집 진입 컨트롤과 긴 원문 검사의 번역 앵커 기대를 수정했어요. 후속 4개 실행에서 3개가 통과하고, 남은 PUNI02에서 6번/36번 메시지의 부분 문자열 충돌을 발견해 정확한 이름 선택으로 수정했어요. 해당 검사도 통과했으며 실패 결과를 PASS로 덮어쓰지 않았어요. 이전 단계의 실패·부분 증거는 `output/`에 보존해요.

## 범위와 제한

검사는 새 포트와 합성 SQLite DB, 합성 provider 및 loopback native transport를 사용했어요. 사용자 DB, 실제 모델·인증·과금 요청, 실제 창작 품질·거절 정확도, 휴대폰 실기기를 검증한 결과는 아니에요. 거절 판정 모델은 사용자 설정이 필요하며 자동으로 특정 공급자·모델을 선택하지 않아요. 운영 DB 초기화·이관·push·배포는 수행하지 않았어요.
