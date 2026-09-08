# 최신 설정 중심 단순화 계획 (2026-09-08)

## 목표

사용자가 자료/프롬프트의 개정 번호를 선택하지 않아도 저장한 최신 내용을 다음 실행에서 사용해요. 기존 번역 구간/현재설정 재시도 변경을 보존하며 격리 작업트리에서 구현해요.

## 구현 계약

1. **현재 선택과 실행 기록 분리**: 자료/프롬프트/공유 모듈 연결은 ID로 최신 내용에 따라가요. 내부 ContentRef revision은 실행 snapshot의 정확한 출처와 보관 검증에 남아요. 이미 예약한 실행과 과거 Run의 본문/프롬프트/모델/자료 그래프는 불변이에요. 현재 선택 조회는 자료 수정에 따라 최신 revision을 투영하고 새 예약에서 이를 고정해요.
2. **옵션 호환성**: 프롬프트 문구 변경만으로 조합이 사라지지 않아요. 같은 control ID의 유효한 값은 유지하고, 삭제/타입/범위 변경으로 무효인 값은 최신 기본값으로 조정해 안내해요. snapshot 내 옵션은 당시 정의로 엄격 검증해요.
3. **패키지 상태**: 상태 동작 정의가 같은 자료 본문 개정은 상태/추첨을 유지해요. 동작/parser/schema/initialState 변경은 기존 명시 reset을 요구해요. GET/preview는 상태를 쓰거나 추첨하지 않아요. 과거 journal은 당시 정의로 검증해요.
4. **사용 화면**: 새 revision 저장/수동 버전번호/보관된 버전 선택을 제거하고 저장하면 다음 실행부터 적용된다고 안내해요. 이전 조건 보존은 별도 이름으로 저장/복제를 이용해요. CAS와 충돌 시 초안 보존은 유지해요.
5. **내부 설정 저장**: story_configs 및 registration-run의 중간 전체복사본 누적을 현재 한 벌과 자체 실행 snapshot으로 정리해요. FK/보관 검증을 함께 조정하며 이전 형식 이관은 추가하지 않아요.

## 유지 결정

원문 수정 이력/hash, 전개 분기/포크, Run/작업snapshot, owner/generation/CAS/idempotency, 상태/정사/기억 checkpoint, 요약/로어 의존성, 형식 버전은 유지해요. candidate API는 같은 조건 후보 비교라는 별도 목적을 유지하며 일반적인 현재설정 재시도로 사용하지 않아요. 과거 실행/이미지/상태 journal이 참조하는 자료 개정은 내부 증거이므로 무조건 삭제하지 않아요. 실제 보관량 측정 없이 모든 과거 자료를 삭제하는 작업은 포함하지 않아요.

## 검증 및 완료 조건

현재 자료/프롬프트 수정 후 기존 채팅의 새 Run에 최신 내용이 반영되고 기존 Run/보조작업은 바뀌지 않는지 확인해요. 옵션의 호환/삭제/타입변경, 상태 본문개정 유지/정의변경차단/reset, 공유모듈 순환/중복, archive/fork, CAS/동시실행을 검증해요. `quality:full`과 새 fixture DB/port의 `verify:redesign` 및 390px 화면을 확인해요. 유료 모델/사용자 DB/외부배포/push는 수행하지 않아요.

## 구현 결과

- `ProductStore.profile()`은 현재 선택을 최신 자료/프롬프트로 투영하고, `snapshot()`은 당시 실제 내용과 전체 모듈 그래프를 고정해요. 내부 자료 개정과 `/revisions` 조회는 원문·Run·이미지·상태 journal 출처 검증에 남겨요. 저장한 모듈 선언을 GET에서 고치지 않으며, 새 실행이 모듈 ID로 최신 내용을 해석해요.
- 채팅/새채팅/빠른 선택/프롬프트 편집의 전역 옵션 조합은 같은 프롬프트 ID에서 재사용해요. 유효값은 유지하고 타입·범위·삭제 변경은 기본값으로 조정해요. 조정 안내는 조회용 필드이며 실행 증거에는 넣지 않아요. 편집 중 외부 저장 충돌은 초안을 보존해요.
- 같은 동작 정의의 본문 개정은 상태·추첨을 유지해요. 정의 변경은 기존 값을 보여 주고 명시 reset을 요구해요. reset journal의 `previousScope`로 이전 schema의 상태까지 검증해요.
- schema/archive는 **v13**이에요. `story_configs`와 등록 도우미 기록은 최신 1행이며 과거 설정·target·attempt·검토안·적용 결과는 각 실행 snapshot에 보존해요. 포크 대상 ancestry 밖에서 활성화된 현재 서사 설정은 포크에서 제외하고, 과거 작업은 자체 snapshot으로 보존해요. 옛 상태 모델이 삭제되어도 과거 모델 snapshot으로 archive를 검증해요.
- 참조 중인 프롬프트의 역할 변경과 자료의 패키지 구조 제거/전환은 저장 전에 409로 거부해요. 최신 참조가 깨져 채팅 조회·복구가 불가능해지는 경우를 막아요. 별도 항목 저장은 가능해요.

## 검증 기록

- `npm run quality:full`: 단위·통합 **1,260 PASS, opt-in 1 skip**, 타입·빌드 PASS. 로그 `output/current-settings-quality-full.log`.
- 초기 `npm test`는 sandbox `spawn EPERM`으로 실행되지 않았고, 승인 실행으로 실제 검사를 확인했어요. 초기 공유모듈 테스트의 개정1 기대를 최신2 및 과거1/새2/archive3 분리 검증으로 바꿨어요.
- 첫 전체 브라우저 `redesign-2026-09-08T01-40-44-445Z-e08710a9`: **116 PASS / 6 FAIL / 0 skip**. 실패는 CURRENTUI01 select JSON 인코딩, LIMG04/05 최신 이미지 기대, PRUI01 같은 ID 조합 유지, SEGMENTUI02 저장 선언과 실행 해석 분리, UI03 재시도 후 최신 선택 기대였어요. 초기 reporter/trace/화면과 cleanup PASS 기록을 그대로 보존해요.
- 검토에서 찾은 프롬프트 역할/패키지 구조 보호 보강 후 관련 단위 **37/37 PASS**, `quality` PASS. 최종 브라우저 재검증 결과는 아래에 추가해요.
- 최종 `npm run quality:full`: **1,260 PASS, opt-in 1 skip**, 서식·lint·타입·빌드 PASS. 로그 `output/current-settings-quality-final.log`.
- 최종 `npm run verify:redesign`: **122/122 PASS, 0 fail/skip**. [summary](../output/playwright/redesign-2026-09-08T01-49-47-675Z-b1906a48/summary.json), 같은 폴더의 reporter·trace·화면·evidence-db를 보존해요. source/build `55e0866706d30f0caa4978aa856d2d79931197332f2e8c1b53ea86d658eba38e` 일치, cleanup PASS(잔여 owned PID 없음), 합성 canary 검사 PASS예요.
- 390px 창작 옵션과 구간 편집 초안 화면을 직접 확인했어요. 최신 옵션값·기본값 조정 결과가 표시되고, 입력·적용 버튼 및 편집 초안의 가독성과 가로 넘침을 확인했어요. 실제 휴대폰/IME 검증은 아니에요.

계획의 구현·로컬 검증을 완료했어요. 기존 번역 구간/현재설정 재시도 변경과 사용자 소유 변경을 보존했으며 커밋·push·실제 모델 호출·사용자 DB 변경은 수행하지 않았어요. 구형 DB/archive 이관과 참조되지 않는 과거 자료 개정의 보관량 최적화는 이번 범위가 아니에요.
