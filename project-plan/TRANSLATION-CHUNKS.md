# 번역 구간 설정 구현·검증 (2026-09-08)

채팅 설정에 `translationChunkChars`(100–24,000 정수/null 무제한, 미지정 기본 3,000)를 추가했어요. 문단과 fence를 보존하고 기준 초과 문단을 자르지 않아요. 새 예약은 현재 값을 input에 고정하고 claim에서 유지해요. 사용자가 재시도하면 현재 모델·프롬프트·구간 기준으로 전체 장면을 새로 번역하며 기존 plan/완료 구간을 교체해요. 작업 내부 자동 재시도는 같은 예약을 유지해요. `TranslationPlan.maxChunkChars`와 실제 grouping을 검증해요. archive 설정 및 job input/plan 일치, fork 보존도 검증해요. 구형 plan을 위한 이관은 추가하지 않았어요.

기존 retranslate API에 연결하는 **현재 설정으로 새 번역**과 **현재 설정으로 번역 재시도**를 연결했어요. 기존 번역·완료 구간을 교체한다는 확인 후 같은 원문에 현재 모델·프롬프트·구간 기준을 적용해요. 원문 및 기존 Run snapshot은 유지해요. 기존 진단의 시간·호출·토큰·공급자 비용 표시를 재사용하고 보조 작업에 적용 기준/실제 구간 수를 표시해요. 입력 한도·timeout·부분 응답은 자동 재분할 없이 이유를 안내해요.

## 최초 구현 검증 (아래 재시도 계약 변경 전)

- `npm run quality:full`: PASS, 118 test files / 1,255 tests 통과, 기존 1개 skip. 타입·Biome·빌드 통과.
- 최초 sandbox 실행은 Vite spawn EPERM, 초기 전체 검사는 dist/server/index.js 미생성으로 1건 실패했어요. 승인된 실행 및 선행 빌드 후 위 결과를 확인했어요.
- `npm run verify:redesign`: PASS, 121 browser tests. 새 fixture DB/port, 소스·빌드 identity 확인. `output/playwright/redesign-2026-09-08T00-58-17-684Z-68af037b/summary.json`.
- 위 전체 검사 이후 390px screenshot에서 버튼 줄바꿈을 발견해 버튼을 별도 줄로 이동했어요. 이 표시 변경 후 quality/build PASS, 같은 원문 100자 2구간 → 무제한 1구간의 관련 브라우저 테스트 1개 PASS 및 screenshot 육안 확인. 전체 회귀를 반복하지 않았어요.
- 최종 관련 증거: `output/playwright/translation-chunks-2026-09-08T01-02-14-492Z-9a92f3c8/summary.json`. 최종 build identity `277d009256c3fdfbd24802d161a786608670d24a196704182178b05000b2403d`.
- 단위/통합: 문단 경계·초과 문단·24,000자 초과 fence, 무제한, 범위/grouping 변조, 예약 이후 설정 변경, partial 재시도 완료 구간 보존, archive/fork 보존·변조 거부.
- 빌드는 기존 500kB 초과 client chunk 경고가 남아요.

## 재시도 계약 변경

후속 요청에 따라 명시 재시도는 현재 설정으로 전체 장면을 새 번역해요. 구간 한정 재시도 UI/API는 제거했어요. 신규 설정 검증이 실패하면 기존 실패/부분 작업을 트랜잭션으로 보존하고, 이미 대기·실행 중인 작업에 중복 요청하면 재예약하지 않아요. 완료 작업은 기존처럼 재시도 요청만으로 다시 실행하지 않으며, 명시 새 번역을 사용해요.

- `npm run quality:full`: PASS, 1,255 tests/118 files 통과, 기존 1개 skip. 현재 모델/프롬프트 적용, 부분 완료 구간 교체, 검증 실패 rollback, 대기 중 중복 재시도 불변, 구간 한정 요청 400을 포함해요.
- 과거 실패 구간 전용 `verify-live-retry.mjs`는 그 승인과 oracle이 전체 장면 재번역을 포함하지 않아 `LIVE_RETRY_FAILED_CHUNK_CONTRACT_RETIRED`로 차단했어요. 가상 경로를 사용한 preflight에서 인증 시도 false/네트워크 요청 0/BLOCKED를 확인했어요. `output/live/live-retry-2026-09-08T01-09-13-583Z-ea22e550/summary.json`. 유료 execute는 실행하지 않았어요.
- `verify:redesign`: 120 PASS/1 FAIL. 실패는 F05 테스트가 재시도 전후 translationRevision까지 동일하다고 기대한 오래된 oracle이었어요. 원문 전체는 동일하고 translationRevision만 1 증가함을 확인하도록 테스트만 수정했어요. 원래 실패 증거는 `output/playwright/redesign-2026-09-08T01-10-54-592Z-a8fb4049/summary.json`에 보존해요.
- 수정 후 quality/build PASS 및 F05/UI05/구간설정 모바일 관련 브라우저 4개 PASS. 실패·취소 후 현재 100자/무제한으로 재시도, 확인 취소·수락, revision 증가, 새 구간 첫 attempt, 원문/hash 보존을 검증했어요. `output/playwright/translation-chunks-2026-09-08T01-14-20-096Z-dd8040a3/summary.json`. 전체 회귀는 다시 반복하지 않았어요.
- 최종 build identity: `fa1be1869c7bb7fd509b44dfd8967860abe2865d74c8104fcf8469f334117492`.

## 통합 주의와 한계

격리 작업트리에서만 수정했으며 commit/push하지 않았어요. 별도 표시 상태 모델 복구 작업은 수행하지 않았어요. 메인 세션의 번역 실패 진단과 `web/SourceReader.tsx` attention/JobCard 영역이 겹칠 수 있어요. 여기 추가한 입력 한도·timeout·부분 응답 안내와 구간 요약을 보존해 통합해 주세요. `server/store.ts` claim 입력 보존, `server/app.ts` 설정 검증, `server/source-editing.ts` 새 번역 예약도 병행 변경 여부를 확인해 주세요.

실제 Gemini 등 유료 모델 호출·번역 의미 품질·실제 속도/사용량/비용 비교·외부 배포는 수행하지 않았어요. 합성 결과는 모델 성능 증거가 아니에요. 비용 미보고는 기존 미확인을 유지해요. 새 번역은 기존 한 슬롯을 교체하므로 비교 전 진단 값을 기록해야 해요.
