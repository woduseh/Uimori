# 자료 파일 이동 v1

`uimori-native-transfer` v1은 저장한 봇·페르소나·모듈·프롬프트 프리셋을 다른 설치에 새 사본으로 옮기는 교환 형식이에요. DB schema 17, 전체 보관 archive 15, 채팅 전체 백업 v1과 버전을 공유하지 않아요. Risu `.charx`·`.risum`·`.risup` 컨테이너 해석이나 원본 스크립트 실행은 이 기능의 범위가 아니에요.

서재 또는 프롬프트 목록 상단의 **자료 파일 가져오기·내보내기**에서 열어요. 내보내기는 저장된 자료를 골라 다운로드하고, 가져오기는 파일의 항목·연결 자료를 확인한 뒤 **새 사본으로 가져오기**를 눌러요. 보조 모델 연결이 필요한 프롬프트는 이 설치의 모델 또는 본문 모델 사용을 명시적으로 선택해요. 저장 응답이 불확실하면 같은 파일·선택·요청 키를 유지해 재확인하며, 후속 재시도의 일시적 거절도 최초 적용 여부를 확정하는 근거로 삼지 않아요.

## 자료와 참조

- `roots`는 사용자가 선택한 자료·프리셋의 `{kind,key}` 목록이에요. `contents`와 `prompts`의 key는 파일 안에서만 유효해요. 원본 ID·이름·내용 hash로 목적지 자료와 자동 병합하지 않아요.
- 콘텐츠 항목은 `{key,source,modules,origin?}`예요. `source`에 원래 `Content`와 패키지 정의를 보존해요. `modules`는 선언 순서대로 실제 사용한 모듈 항목 key를 기록해요. 내보내기는 기존 live 연결처럼 최신 모듈 개정을 캡처하므로, 원본 패키지에 적힌 이전 모듈 개정과 이 배열이 가리키는 실제 개정이 다를 수 있어요. 대상 모듈의 원본 ID는 선언된 ID와 같아야 해요.
- 공유·중첩 모듈은 한 번만 저장해요. 실행 순서는 기존 루트 우선 DFS와 모듈 선언 순서를 유지해요. 저장 순서만 자식 우선으로 계산해요. 역할별 장착 중복 제거, 순환·개정 충돌·깊이 20·장착 100개 한도도 기존 `resolvePackageGraph`를 사용해요.
- 패키지 안 로어·폴더·시작·제어·행동·정규식·이미지 항목 ID와 본문의 문자열은 바꾸지 않아요. 자료 ID, 패키지 ID/개정, 모듈 참조, 포함된 콘텐츠 간 `relatedIds`, 옵션 조합 소유권만 구조적으로 remap해요. 파일에 없는 외부 `relatedIds`는 prepare에서 안내하고 원본 영수증에 보존하며 목적지의 같은 ID에 연결하지 않아요. 패키지 로어의 `relatedIds`는 패키지 내부 참조라 그대로 유지해요.
- 프롬프트 항목은 `{key,source,combinations,origin?}`예요. 소유 프리셋이 명확한 옵션 조합만 내보내며 각 조합의 원래 `controls`와 `values`를 유지해요. 현재 프롬프트와 옵션 정의가 다른 조합은 보존하되 기존 일치 검사에 따라 적용 대상에서 제외하고 prepare에 안내해요. 전역 작업본이나 전역 작업본 소유 조합은 이 내보내기 대상이 아니에요.

## 준비와 적용

1. `POST /api/native-transfers/export`는 `{items:[{kind:'content'|'prompt-preset',id}]}`를 받아 선택 항목과 의존 모듈·이미지·프리셋 소유 조합을 함께 내보내요. 삭제된 루트는 내보낼 수 없어요. 이미 연결된 의존 모듈의 조회는 기존 live 연결 계약을 따라요.
2. `POST /api/native-transfers/prepare`는 `{file}`을 받아 `digest/summary/entries/modelRequirements/warnings`를 반환해요. DB 접근·이미지 저장·자료 등록·모델 호출이 없어요. 파일을 다시 반환하지 않으므로 UI는 선택한 원본 file을 초안으로 유지해요.
3. `POST /api/native-transfers/apply`는 `{file,digest,modelBindings,idempotencyKey}`를 받아 서버에서 다시 검증해요. 한 transaction에서 이미지, 자식 모듈, 루트, 프리셋, 조합, 영수증을 등록해요. 하나라도 실패하면 새 이미지·자료·분류·영수증이 모두 롤백돼요.
4. 결과는 `{id,created,digest,importedAt,summary,items}`이고 각 item은 원래 key와 새 ID/revision 1을 포함해요. 같은 요청 키·같은 파일/매핑은 재시작 후에도 같은 결과(`created:false`)를 반환해요. 같은 키의 다른 내용은 충돌이며, 새 키는 서로 독립적인 새 사본이에요. 이름은 겹칠 수 있어요.

자료·이미지 등록만 수행하며 기존 전역 모델/연결/프롬프트 작업본, 채팅 설정·장착·옵션, 기존 자료의 내용·분류·숨김은 변경하지 않아요. 행동 초기화·난수 생성·시작문 저장·작업 예약도 하지 않아요.

## 외부 모델 요구 사항

협업자의 명시적 `agent.model`은 원본 모델 ID를 가진 requirement로 나타나요. 모델 정의·endpoint·credential 설정을 파일에 수록하거나 목적지의 같은 ID·이름으로 자동 연결하지 않아요. 각 requirement에는 `{requirementKey,mode:'local',model:{id}}` 또는 `{requirementKey,mode:'inherit-main'}`의 명시 선택이 필요해요. 원래 `model:null`인 협업자는 본문 모델 상속을 그대로 유지해요.

적용 transaction에서 목적지 모델·연결의 존재·삭제·활성 상태를 다시 검사해요. 협업이 꺼져 있어도 명시 모델은 같은 검사를 받아요. 미연결 상태는 초안으로 남으며 원본 ID를 조용히 null로 치환하거나 저장 완료로 표시하지 않아요. `inherit-main`을 선택한 변경과 원래 모델 ID는 영수증에 보존해요.

## 이미지와 운영 한도

단일 교환 파일은 현재 64 MiB, 자료·프리셋 합계 1,000개, 옵션 조합 합계 1,000개, 이미지 blob 합계 10,000개를 넘지 않아요. 각 패키지와 프롬프트에는 기존 개별 스키마 한도도 적용돼요. 이 값은 구현의 운영 한도이며 대형 Risu 컨테이너의 동등 지원을 뜻하지 않아요.

이미지는 기존 PNG/JPEG/WebP MIME, 정규 base64, 2,000,000 decoded bytes/이미지 한도와 바이트 서명·SHA-256 검사를 사용해요. 파일의 이미지 집합과 전체 패키지 참조가 정확히 일치해야 하며 누락·중복·불필요한 blob·MIME 불일치를 거절해요. 이미 존재하는 hash의 bytes/MIME도 일치해야 재사용해요. 실제 이미지의 완전한 디코딩·픽셀 크기 검사는 현재 계약에 없어요. 대용량 스트리밍·압축 컨테이너·이미지 변환은 별도 범위예요.

## 원본과 보관

schema 17의 `native_transfer_receipts`가 요청 키의 전체 UNIQUE 제약과 원본 연결 정보를 보관해요. 15→16 migration은 그대로 유지하고 16→17에서 이 표만 추가해요. 영수증에 본문·AST·이미지 bytes를 다시 복사하지 않아요. 가져온 불변 revision 1과 원래 ID/개정, module/related/model 참조, 옵션 값의 존재 여부, 새 ID 매핑을 사용해 `GET /api/native-transfers/:id/original`에서 원래 파일 데이터를 재구성해요. JSON 필드 순서나 공백은 원본 보존 대상이 아니며 작성된 문자열과 데이터는 보존해요.

나중에 수정하거나 서재에서 삭제해도 원래 개정은 유지되므로 원본을 재구성할 수 있어요. 재내보내기 `origin`에는 이전 가져오기 digest·entry key·원래 ID/개정을 담고 현재 자료와 출처를 구분해요. archive 15는 이 영수증 collection을 선택적으로 포함하며 이전 archive의 누락은 빈 목록으로 처리해요. 복원 시 출처 재구성, 실제 새 자료/프리셋/조합의 ID·참조·모델 매핑, digest, 영수증 간 신규 ID의 중복 소유를 검증하고 실패하면 전체 복원을 롤백해요. 채팅 백업 v1은 채팅에 필요한 library version을 보존하지만 별도 자료 가져오기 영수증은 운반하지 않아요. SQLite 백업은 전체 영수증을 보존해요.

## 구현과 검증

타입: `core/native-transfer.ts`. 순수 검증: `core/native-transfer-validation.ts`, `core/package-graph.ts`. 저장·라우트: `server/native-transfer.ts`. 집중 검사는 `tests/native-transfer.test.ts`, migration은 `tests/schema-migrations.test.ts`예요. 모든 fixture는 합성이고 외부 모델 호출·Risu 스크립트 실행·실제 작품 내용은 포함하지 않아요. 합성 계약 검사와 실제 대형 자료·브라우저·의미 품질 검증을 구분해요.
