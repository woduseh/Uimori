# 저장 경로 성능

봇·페르소나·모듈의 저장 의미와 복구 계약을 유지하면서, 저장 버튼의 임계 경로와 반복 조회를 줄여요.

## 저장 완료와 목록 갱신

`ContentEditor.saveContent()`는 서버 저장 응답을 받은 뒤 저장된 항목을 편집기에 반영해요. 서재 목록 재조회는 완료를 기다리지 않아요. 목록 재조회 실패를 저장 실패로 돌리지 않고 저장 완료 문구에 별도 안내를 표시해요. 신규 자료의 분류 콜백은 계속 기다리지만, 분류 실패도 완료된 콘텐츠 저장을 취소하거나 다시 저장하게 만들지 않아요.

늦게 실패한 재조회가 다음 저장의 상태나 이미 닫힌 편집기를 갱신하지 않도록 저장 세대 번호를 확인해요. 실제 저장 실패와 미적용 초안은 기존 실패 경로를 유지해요. 서버 응답 전에 저장 성공을 표시하는 방식은 아니에요.

## 경량 revision 조회

`GET /api/edit-drafts/:id/revisions`는 `{ revision, targetRevision }`만 반환해요. 초안 revision은 `edit_drafts.revision`, 콘텐츠·프리셋의 저장본 revision은 `versions.revision`, 전역 프롬프트는 `prompt_workspace.body.revision`을 사용해요. 새 자료나 없어진 저장 대상의 `targetRevision`은 null이고, 초안 자체가 없으면 404예요.

초안이 바뀌면 기존 전체 조회를 수행해요. 저장본만 바뀐 깨끗한 초안은 기존 saved-target 조회와 revision CAS를 사용하는 pristine rebase로 갱신해요. 조회 결과를 적용하기 전마다 현재 초안 객체와 로컬 편집 상태를 다시 확인해요. 미적용 원문·충돌·미확인 쓰기·타이핑을 revision 응답으로 덮어쓰지 않아요.

## 단일 저장·되돌리기 HTTP 응답

`POST /api/edit-drafts/:id/save`와 `POST /api/edit-drafts/:id/undo`는 같은 `DraftSaveWire` 성공 응답을 반환해요. 사본 생성도 일반 `/save` 경로를 사용해요. `saved`와 중복인 `draft.model`·`draft.baseModel`은 전송하지 않아요. `changes`, operation ID와 초안 메타데이터는 응답에 포함해요.

응답 표현을 선택하는 쿼리 옵션, 형식 버전 태그, 구형 응답 폴백은 없어요. 서버와 클라이언트는 함께 갱신하고 기존 편집기 페이지도 새로고침해야 해요. `decodeDraftSaveResult()`는 현재 응답을 편집기 상태로 구성하는 함수예요. 저장 모델에서 편집 가능한 필드를 뽑고, 현재 편집본과 비교 기준본을 각각 독립적으로 복사해요. 전역 프롬프트에서는 main·translation만 편집 모델에 포함해요. 일반 저장, 콘텐츠/프리셋 사본 저장, undo와 브라우저 테스트의 응답 판독부가 이 계약을 사용해요.

서비스의 도메인 결과와 operation 기록은 전송 형식과 별개예요. 동일 operation ID를 재전송하면 중복 저장하지 않고 해당 작업의 성공 응답을 다시 반환해요. DB operation의 중복 본문이나 큰 배열 diff의 저장 구조는 이 HTTP 응답 정리의 변경 범위가 아니에요. 구형 판독기나 자동 마이그레이션은 추가하지 않아요.

`rebase`는 저장 영수증이 아니라 `EditDraft`를 반환하므로 save/undo의 인코딩을 적용하지 않아요.

## 편집기 계산과 투영 소유권

ContentEditor는 모델 참조가 바뀌지 않는 저장 상태·동기화 상태 렌더에서 편집 모델과 dirty 판정을 재계산하지 않아요. 공유 초안 hook도 같은 모델의 전체 JSON 문자열을 반복 생성하지 않아요. 실제 입력 변경은 새 모델 참조로 추적하고, 기존 로컬 복구 기록과 서버 동기화 타이밍은 유지해요. localStorage의 대용량 동기 기록을 제거한 변경은 아니에요.

서버에서는 입력 패키지를 먼저 분리한 뒤 새로 만든 네이티브 투영을 `assertRisuContent()`로 검사해요. 이미 소유한 투영 객체를 검증 직후 다시 복제하지 않아요. 입력 검증·최종 저장 검증은 유지하며 호출자가 넘긴 원본 패키지를 변경하지 않아요.

## 조회·알림 경계

이미지 참조 확인은 SQLite에서 hash와 MIME만 조회하고, 한 검사 안에서 같은 blobHash의 결과를 재사용해요. 별칭별 MIME 비교는 계속 수행해요. 업로드·가져오기 단계의 이미지 바이트 검증은 변경하지 않아요. JSON 내부 메타데이터 조회이므로 SQLite의 JSON 파싱 비용은 남아 있어요.

모듈 그래프의 최신 버전 확인은 콘텐츠 본문 대신 revision 열을 조회해요. 실제 패키지 조회와 검증, 순환 및 버전 충돌 검사는 유지해요.

콘텐츠·프리셋 저장 시 모든 기존 채팅에 보내던 profile.updated 이벤트는 같은 대상과 순서로 한 INSERT…SELECT에서 기록해요. 각 이벤트는 동일한 배치 시각을 사용하고 저장 트랜잭션과 함께 롤백돼요. 의존하는 채팅만 선별하도록 의미를 바꾸지는 않아요. 콘텐츠 저장은 프롬프트 작업공간 변경 이벤트를 별도로 발생시키지 않아요.

## 검증

`tests/edit-draft-save-wire.test.ts`는 응답 왕복·소유권 분리·전송 크기를, `tests/save-read-projections.test.ts`는 실제 SQLite의 revision 조회·이미지 오류·이벤트 순서와 롤백을 확인해요. `tests/content-save-api.test.ts`는 실제 Store와 HTTP 라우트의 단일 저장/undo 응답, 재전송, revision 충돌과 rebase를 확인해요. 기존 edit-draft-session 회귀 테스트에는 경량 조회와 늦은 revision 응답 중 타이핑 보존, 사본 저장의 유실 응답 재전송, undo의 편집본 복원 검사를 포함해요.

새 빌드에서 `npm run verify:library -- --grep SAVEPERF`는 봇과 페르소나 저장 뒤의 목록 요청을 의도적으로 지연·실패시키고, 저장 버튼과 저장 결과가 올바르게 유지되는지 확인해요. `npm run verify:library -- --grep "SAVEPERF|^ED0"`는 기존 초안 충돌·복구·검토 후 undo 시나리오도 함께 확인해요. 로컬 테스트와 실 운영 서버의 저장 지연 측정은 별개예요.
