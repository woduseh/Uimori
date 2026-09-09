# 통합 검증·오류 수정·안정화

검사 대상은 `main`의 `09f34e8b1225571adc28f28705b8c2bbff4ce51b`(tree `e0ba533afb0f69ac08e14259f8b18a6bf96a4899`)와 이 감사에서 적용한 미커밋 변경이에요. 의뢰 문서는 `Uimori-Integrated-Audit-Brief.v2.ko.md`이며, 최신 요청의 **검증 및 오류 수정·안정화**에 따라 제품 수정까지 진행했어요. 최초 checkout은 변경 없이 깨끗했고 Node **24.14.0**, Windows, Asia/Seoul에서 실행했어요. 실제 계정·원고·운영 DB·배포는 사용하지 않았어요.

네 기능의 일반 진입점과 실행·저장·복원 경계를 조사하고, 재현된 권한 확대·불확실 원격 재전송·백업 복원·구성 재시도 문제를 수정했어요. 전체 파일을 전수 감사했다는 판정은 아니에요. 합성 공급자가 지시한 도구를 호출하는 검사는 실제 모델의 자발적인 기억 회수·작문 품질을 증명하지 않아요.

**판정: 요청한 감사와 주요 오류 수정·로컬 검증을 완료했어요.** 전체 단위·통합 **1,697 PASS**, 전체 합성 브라우저 **208 PASS**이며, 아래 P2 두 항목과 실제 서비스 인수는 남아 있어요. 운영 준비 완료로 확대하지 않아요. 커밋·푸시·배포는 수행하지 않았어요.

## 판정과 실행 기록

최종 실행 상태와 산출물은 이 절의 검사 결과로 판단해요. 과거 작성자 보고와 이번 재현을 합산하지 않아요.

| 실행 | 결과와 해석 | 직접 증거 |
| --- | --- | --- |
| 기준 `quality:full` | 정적 검사 PASS, tooling 27 PASS 뒤 build의 하위 프로세스 `spawn EPERM`으로 BLOCKED. 뒤 Vitest는 이 실행에서 미실행 | `output/integrated-audit-2026-09-09/baseline-quality-full.log` |
| 기준 build 재실행 | 샌드박스 밖 로컬 빌드 PASS. 이전 실패 산출물을 보존한 뒤 실행 | 같은 폴더 `baseline-build.log` |
| 기준 전체 Vitest | **1,635 PASS / 0 FAIL / opt-in 1 미실행**. 과거 23 FAIL은 이 환경에서 재현되지 않았어요 | `baseline-vitest.json`, `baseline-vitest.log` |
| 기준 전체 브라우저 | **202 PASS / 2 FAIL**, 약 7.1분. RACOM01의 삽화 메뉴 누락 기대값과 SCUI01의 설정 7개 기대값. 과거 ACTUI08·CSUI04는 이번에 PASS | `output/playwright/redesign-2026-09-09T12-52-52-829Z-86ed8e64/summary.json`, `playwright.json` |
| 삽화 집중 수정 검사 | **58 PASS**, 실제 loopback HTTP·임시 SQLite 포함. 추가 Codex stdio 검사는 별도 | `illustration-green-final.json` |
| 구성 Store 집중 검사 | **26 PASS**. 원본에서 실패한 감사 회귀 6건 포함 | `outline/green-tests.log`, `outline/red-tests.log` |
| 최종 정적·tooling·build·전체 Vitest | **PASS**, tooling 27 PASS, 단위·통합 **1,697 PASS / 0 FAIL / opt-in 1 미실행**, 161파일 PASS + 선택 파일 1 미실행, Vitest 124.97초 | `final-quality-full.log` |
| 최종 구성 집중 브라우저 | **8 PASS**, OUTUI01–04 × 390/1440px, 약 15초. 닫힌 패널의 늦은 응답과 새 요청 경합·pin 중 초안·저장 유실·GET 실패·CAS·reload 포함 | `output/playwright/outline-2026-09-09T13-36-12-780Z-b43fcadf/summary.json` |
| 최종 통합 브라우저 | **208 PASS / 0 FAIL / 0 SKIP**, 약 8분 4초. identity·cleanup PASS, 잔여 live PID 없음 | `output/playwright/redesign-2026-09-09T13-37-12-941Z-7472fe8d/summary.json`, `playwright.json`, `final-browser.log` |

실행 명령은 `npm run quality:full`, `node node_modules/vitest/vitest.mjs run --reporter=json --outputFile=<결과>`, `npm run verify:redesign`예요. 집중 검사는 같은 Vitest 명령에 아래 테스트 파일을 전달했어요. 첫 EPERM을 PASS로 바꾸지 않았으며 정상 권한으로 재실행한 결과를 따로 기록했어요. 실제 설치 Codex opt-in, 실제 모델/원격 ComfyUI/물리 휴대폰은 **NOT RUN**이에요.

최종 빌드 ID/source hash는 `607f8c1ef66c4e40b0b165c7f9436968e13bcfff21e7ab6a455ae026dfc2a9b2`, dist hash는 `5b86be66a8315cb97425f2bca2397cb8f26eb1a093087d2956e7ea93a058c3fc`예요. 브라우저 실행기는 시작·종료 때 소스/빌드와 테스트 지문 일치를 검사했고 **2026-09-09T13:45:16Z**에 최종 일치를 확인했어요. 진행 중 제품·테스트는 수정하지 않았어요. 합성 비밀 canary 검사도 PASS이며, 이것은 실제 비밀을 전수 검색했다는 의미가 아니에요.

## 요구사항 → 실행 → 다음 소비

| 사용자 능력 | 일반 진입점·실행·저장·다음 소비 | 상태와 근거 |
| --- | --- | --- |
| 즉흥 집필·기존 번역/상태/이미지 | 본문 입력 → main-request/model-runner → Run·source → reader/useStory, 번역 보기를 명시한 때 jobs → 최신 번역 | 기존 기능 유지. 기준 전체 단위·브라우저 및 최종 회귀로 확인. 구성·삽화·메모 opt-in이 OFF일 때 필수 단계로 추가하지 않음 |
| 메모 작성·읽기·창 전환 | 모델 프리셋 contextTools → context.read/write/new·story.list → context-tools/context-store → model-runner 세그먼트 경계 → 다음 실제 provider body | 로컬 구조 검증. context-model-driven-integration·context-tools·context-native·context-lore-integration. 원문 이력 보존과 전송 projection 축소를 구분 |
| 사용자 메모·요약 교정 | 이야기 상태/도우미 → story-notes/context-store의 revision CAS → 활성 checkpoint → 다음 snapshot/context planning | 늦은 자동 결과·stale 정정 보호는 기존 경합 검사 유지. 실제 모델이 누락 정보를 스스로 찾는지는 미검증 |
| 우이의 자료 읽기·초안·저장 | 우이 패널/자료 편집기의 도움 → helper-runtime → scope/grant/operation receipt → 공통 edit-drafts 저장 → 자료 편집기 및 이후 Run | 로컬 구조 검증. 읽기·설명·추천은 쓰기 허가와 분리. 직접 저장·미저장 JSON 충돌·화면 이동 대상 고정 검사 유지 |
| 구성만 작성·변경 | 채팅 메뉴 또는 outline.read/write → outline-routes/helper-workspace → 동일 OutlineStore, user/model 권한 구분 → outline_nodes + outline_batches → 재열기/다음 집필 | 구현·수정 검증. 5계층, 최대 200 연산, 분기 소유, 원자적 batch, payload/authority/branch 멱등·CAS |
| 지정 단위 집필 | OutlinePanel → scene-command → 기존 scene-command run → freezeOutline → RunSnapshot.outline → slot 또는 host context → 원문 → 실제 command 결과로 진행도 계산 | 회차/작은 사건만 한 번에 집필. 배치·두 단계 응답 유실 후 동일 요청 확인. 미래 계획·형제 계획과 이미 실현한 원문 분리 |
| Codex 삽화 | 장면 메뉴/자동 예약 → frozen input → Codex 전용 image 턴 → durable attempt → 이미지 bytes·caption → source/hash에 붙은 카드 | 합성 stdio 경로 검증. 경로 이탈·MIME/bytes·크기·첨부 hash 보완. 실제 설치 이벤트·인증·참조 충실도 미검증 |
| 원격 ComfyUI 삽화 | 동일 메뉴 → 텍스트 prompt 모델 → 실제 HTTP /prompt → /history → /view → 이미지 저장 → reader/event → 결과 확인 | 인증·deadline·접수 단계·취소·회수 로컬 검증. 다른 PC의 실제 배포망·버전·workflow는 사용자 인수 대상 |
| 포크·백업·재접속 | chat-fork/product export/import → outline/context/helper/illustration 관계 검사 → 새 DB reader·다음 예약 | 실제 provider attempt를 포함한 삽화와 포크 왕복, 신규 v15 표 초기화·원자적 위조 거절. 복원 후 외부 권한 자동 재활성화 없음 |

## 확인한 결함과 최소 수정

아래 우선순위는 로컬 재현의 사용자 영향 기준이에요. 재현 테스트 개수를 결함 개수로 세지 않아요. 코드 위치는 파일의 명시한 함수가 기준이며, 이번 변경의 줄 번호는 최종 diff에서 확인할 수 있어요.

| 우선순위 / 브리프 항목 | 기준 동작·영향·근본 원인 | 적용한 수정 / 통과 기준 |
| --- | --- | --- |
| P1 F02 인증 ComfyUI | 앱의 provider credential resolver는 Connection 객체를 요구하지만 ComfyUI는 env 이름만 전달. 연결 확인과 실제 생성 경계 불일치 | app의 Comfy env resolver를 명시 분리하고 생성·조회·취소까지 전달. 인증된 loopback에서 실제 prompt 모델 → render → 저장 |
| P1 F04/F05 원격 불확실성 | poll 사이 시간 확인만으로 헤더/body 정체를 끝내지 못함. 접수 뒤 5xx/연결 실패를 새 렌더 재요청으로 바꿀 수 있음 | 전체 AbortSignal deadline과 제한 길이 body reader. 전송 직전 `uncertain`, 접수 후 prompt ID 보관. POST 5xx·body 유실은 자동 재전송 없음. 접수 후 실패는 결과 회수만 제공 |
| P1 F03/F10 archive | illustration role/owner가 일반 attempt validator에서 빠져 실제 호출 기록이 있는 백업 복원이 실패. 포크가 같은 attempt 소유 목록 복제. Comfy 인증 참조 유지·위조 이미지 통과 | 별도 illustration graph 검사와 공통 attempt 단일 소유 합산. 포크는 copiedFrom 출처만 보존. 실제 attempt·이미지·원문 귀속·hash/MIME/16MB 검증, import transaction rollback. 복원 시 인증 참조 제거·외부 기능 비활성화 |
| P1 F06 우이 권한 | ‘장면의 구성만 만들어줘’에 가정 장면 생성 허가까지 생김. 설명·인용·부정과 저장 요청이 섞이면 허가 오판 | 인용 제거, 문장별 명시 요청과 행동별 금지, 구성과 artifact 권한 분리. 실제 전송 경로에서 outline 저장은 성공하고 자발적으로 붙인 artifact 도구는 거절 |
| P1 F08 제외 원문 | 공개 main이 없거나 구간 파싱 실패 시 전체 원문 fallback으로 숨긴 글이 삽화 모델에 전송될 수 있음 | main만 추출. main 없음·구문 오류는 모델/Comfy 호출 0회로 실패. 정상 공개 부분만 wire로 전달 |
| P1 F09 공유 원격 취소 | queue에서 내 ID를 확인한 뒤 전역 interrupt를 보내는 사이 다른 작업이 시작할 수 있음. shutdown도 원격 취소로 이어질 수 있음 | 대상별 atomic cancel API, 구버전은 해당 ID dequeue만. 전역 interrupt 제거. 사용자 취소·서버 종료·timeout 구분, 늦은 저장은 generation으로 거절 |
| P1 F10 Codex 파일 | lexical 하위 경로 검사로 junction/symlink 이탈 가능. 파일 크기를 읽은 뒤 확인. inline 결과와 별도 savedPath를 함께 처리하면 다른 파일 삭제 가능 | realpath confinement, descriptor stat 전 크기 검사, 제한 읽기, MIME과 bytes 일치. 유효 inline 결과가 있으면 별도 savedPath를 읽거나 삭제하지 않음. 실제 bytes로 첨부 hash 기록 |
| P1 E13 구성 권한·멱등 | create별 request_key만으로 전체 batch replay를 처리. 같은 키 다른 내용/분기, update 재전송 실패, 상위 move로 fixed/written 하위 보호 우회 | transaction 안의 전체 batch receipt. branch/authority/정규화 operations 일치 후 성공 재확인. 중복 ref 거절, move의 하위 전체 guard. 다른 항목의 성공으로 바꾸지 않음 |
| P2 E13/E15 구성 UI | 저장 후 GET 실패를 성공처럼 처리하거나, 응답 유실 재시도에 새 키 사용. 집필 키만 보관해 reload 후 새 CAS body로 같은 키 재전송 | POST 결과 직접 반영. 완전한 요청·CAS 값을 sessionStorage에 보관하고 ‘요청 결과 확인’으로 재전송. 미저장 편집은 기존 revision과 함께 유지하고 충돌은 모달 안에 표시 |
| P2 F07 삽화 슬롯 | retry/reconcile이 최초 예약의 장면당 한도·동시 1개 검사를 우회 | 세 경로 모두 현재 slot 검사. 한도를 올리거나 기존 결과 삭제 후 회수 가능. 개수는 이미지 장수가 아니라 작업 수라는 현행 계약 명시 |
| P2 F12 background rejection | `void promise.finally(...)`의 새 자식 Promise가 reject. 작업 종료 저장까지 실패하면 unhandled rejection 발생 | success/rejection 두 경로에서 관찰·정리하고 안전한 코드만 로그. 실제 built App에 종료 저장 실패를 주입, 재시작 상태 interrupted·자동 재생 없음 확인 |
| P2 구성 성능 | create마다 전체 branch 노드·진행도 조회. 200 연산에 full scan 201회 | parent 단건 조회, 최종 detail 때만 전체 조회. 동일 fixture에서 201→1회, 아래 측정 참조 |

**자연어 허가의 한계:** 시험한 한국어·영어 명시 요청, 인용·설명·금지·혼합 예문에서 회귀를 확인했어요. 임의 자연어의 의도를 완전히 판별하는 보안 증명은 아니에요. 모델의 도구 요청은 이후에도 고정 scope·개별 grant·동일 저장 서비스의 revision/소유/고정 항목 검사를 통과해야 해요.

**잔여 P2:** Reader의 전체 Run 메타데이터/요청문 응답 비용은 아래처럼 측정했고 이번에는 API 계약을 바꾸지 않았어요. 또한 scene-command 생성 후 다른 탭에서 계획을 바꾼 경우 command의 요청문은 생성 당시, outline snapshot은 Run 예약 당시예요. UI의 불확실 요청 중 추가 변경은 막지만 독립 탭의 두 시점 차이는 남아요. 사용자 지정 command 본문과 멱등 재전송을 보존하면서 이 충돌을 알릴 별도 계약이 후속 개선 대상이에요.

수정 위치: `server/app.ts:231`(track), `:477`(Comfy resolver), `server/comfyui-client.ts:262`(cancelComfyUIPrompt)·`:366`(generateWithComfyUI), `server/illustration-runner.ts:103`(publicSceneText)·`:175`(runIllustrationJob), `server/illustration-archive.ts:15`(validateIllustrationArchive), `server/illustrations.ts:584`(completeIllustration)·`:675`(retryIllustration)·`:713`(claimIllustrationForReconcile), `server/helper-workspace.ts:53`(directHelperGrants), `server/codex-runtime.ts:666`(generateImage)·`:783`(decodeGeneratedImage), `server/outline-store.ts:271`(apply)·`:427`(sceneCommand)·`:579`(validateOutlineArchive), `web/OutlinePanel.tsx:397`(remember)·`:408`(send)예요. 모두 현재 미커밋 최종 소스 기준이에요.

## 과거 후보 재분류와 교차 시나리오

| 항목 | 이번 판정 |
| --- | --- |
| F01 / D01 전송 Connection DTO | `transportConnection()`이 이미 반영되어 있었어요. helper/title와 기존 main·auxiliary·story·context·advisor·connection-test 호출 경계를 대조했으며 같은 DTO를 다시 만들지 않았어요. 실제 validator/encoder를 유지한 fetch-only 회귀로 보완 |
| F02–F10 | 위 표의 재현·수정·회귀로 추적. 이미지 저장 fixture만으로 실제 attempt 복원이 검증된 것으로 보던 공백을 실제 HTTP 경로로 보완 |
| F11 Reader | 확정된 선형 비용, P2 후속. 측정값을 새 paging 설계의 완료나 속도 개선으로 표현하지 않음 |
| F12 | built App 원본에서 unhandled rejection 재현 후 관찰 경로 수정 |
| D02 도구 schema/handler 제한 | context 도구의 100 / 16,384 / 512 및 outline batch 200 제한을 현재 정의와 handler에서 대조. 확인 범위에 새 불일치 없음. 공통 상수 추가를 감축 목표로 삼지 않음 |
| 로어 fixture / 과거 전체 실패 | Node24 기준 전체 검사는 녹색. 예전 23건의 원인을 Node 차이라고 단정하지 않음. 자동 압축 경계 여유 assertion과 LRU/요약 분리 의미는 유지 |
| RACOM01 / SCUI01 | 실제 삽화 action과 설정 항목을 확인 후 기대값 보완. 버튼 label·메뉴 행동·탭 개폐·아이콘 유일성 검출을 유지하고 timeout/skip으로 숨기지 않음 |

| 브리프 시나리오 | 확인 경로와 한계 |
| --- | --- |
| E01–E02 | helper/title 실제 transport 회귀, 기존 모델·본문·번역·상태·이미지 API/브라우저. OFF 흐름은 추가 작업을 강제하지 않음 |
| E03–E04 | context-model-driven-integration·context-tools·context-lore-integration·context-store·story-notes. 실제 본문 전송과 원문 회수·요약/메모 CAS, 창 전환. 자발적 기억 품질은 NOT RUN |
| E05 | helper-workspace·edit-drafts 및 helper 브라우저. 공통 초안/저장·미저장 JSON 충돌·scope/권한·재접속 |
| E06–E07, E15 | outline.test·OUTUI01/02, slot 유무 × context.new 후 최종 wire/snapshot 검사. 계획이 사실이 아니라는 host 계약 유지; 실제 모델의 스포일러 억제는 미검증 |
| E08 | comfyui-client·illustration-runner. 실제 HTTP 접수 후 history 오류·header/body 정체·POST 응답 유실. POST 수와 기록된 prompt ID, reconcile 관찰 |
| E09–E10 | illustration-store/runner/api, 삽화 브라우저, background-work. source/hash·owner/generation, 취소 뒤 늦은 완료, startup interrupted 및 회수. 실제 원격 서버 종료·휴대폰은 미검증 |
| E11 | outline/context/story/illustration fork 검사. 원문 계보 밖 완료 binding 제거, 과거 snapshot과 신규 source remap 구분 |
| E12 | 실제 Comfy prompt provider attempt + fork 이미지 archive, context/outline/helper 실행 기록과 합성 삽화가 공존하는 archive 왕복. 실제 원격 작업을 복원 뒤 재생하지 않음 |
| E13 | outline Store 원자성·권한·receipt replay·위조 archive, OUTUI03/04의 저장/집필 응답 유실·reload·충돌·초안 보호 |
| E14 | v15 누락 표를 가진 실제 SQLite 재열기와 archive restore. schema 번호를 올리지 않고 원문·설정을 보존. 구형 schema migration을 추가하지 않음 |

## 재현 증거와 성능

증거 루트는 `output/integrated-audit-2026-09-09/`예요. ignored 산출물이므로 공유 시 아래 로그·JSON과 원본 brief 사본도 함께 전달해야 해요. 테스트는 제품 모듈을 import하고 합성 HTTP/stdio·임시 DB를 사용해요. 원문을 복사한 발췌 함수 검증으로 대체하지 않았어요.

- `baseline-environment.json`: 기준 SHA/tree/Node/초기 변경 상태.
- `outline/red-tests.log` → `outline/green-tests.log`: 원본 6 FAIL → 보완 회귀 포함 26 PASS. 최종 테스트는 `tests/outline.test.ts`.
- `helper-context/permissions-baseline-control-red.json`: 교정된 동일 fixture로 원본 **16 PASS / 10 FAIL**, 수정본은 `final-focused-green.json` **86 PASS**. `control-restoration.json`은 대조 후 수정본 SHA256 복원이 동일함을 보존해요. 초기 URL/필수 intent fixture 오류는 제품 결함 수에 포함하지 않아요.
- `illustration/store-red-valid.json`: 원본의 백업/권한/한도/이미지 저장 8개 실패. 실제 실행 test와 저장소 경계 test를 분리해서 읽어요.
- `illustration/codex-red.json`, `codex-cleanup-red.json`: 원본 stdio 이벤트에서 경로 이탈·참조/결과 MIME·크기·첨부 hash·잘못된 파일 삭제 재현.
- `illustration/codex-final.json`: Codex 이미지/기존 텍스트 실행기 **33 PASS**, 실제 Codex 실행·인증은 사용하지 않아요.
- `track-red.log`, `background-work-red.log`, `tests/background-work.test.ts`: 예외를 삼키는 대체 worker가 아니라 실제 App 생성·Run 예약·종료 저장 실패·DB 재열기를 검증해요.
- `tests/fixtures/comfyui-server.ts`: 헤더/JSON/image body 정체, 접수 후 5xx/연결 유실, 대상별 취소·구버전 fallback을 실제 socket으로 제공해요. 설치 ComfyUI의 버전·사용자 workflow를 모사했다는 뜻은 아니에요.
- `visual-review.md`: 390px 구성/삽화 설정, 1440px 구성 집필 후/삽화 카드 PNG를 직접 열어 가로 잘림·상태·행동 배치를 확인했어요. 1px 합성 이미지라 실제 삽화의 표시 품질까지 주장하지 않아요.

| 측정 | 조건 | 결과 |
| --- | --- | --- |
| 구성 batch 전/후 | Node24, 1,003개 노드에 200 create, 매 회 새 합성 DB, 각 3표본 중앙값 | **502.95 → 20.02ms**, 약 25.1배. branch scan **201→1**, prepare 804→606. 외부 모델 호출 0회 |
| Reader 10 / 100 / 1,000 원문 | 요청문 2,000자, 페이지 5개, warmup 1+측정 5회, reader 생성+JSON 직렬화 | idle delta 중앙값 **1.28 / 4.30 / 46.53ms**, **34,994 / 287,186 / 2,724,388 bytes**. 1,000개 initial 2,747,875 bytes, 45.88ms |

구성 측정 코드는 `outline/performance.test.ts`, 결과는 `performance-before.json`·`performance-after.json`이에요. Reader 측정은 `measure-reader.mjs`, `reader-measurements/reader-1788958686943.json`과 보존한 합성 DB를 사용해요. Reader fixture는 큰 frozen history를 생략했으며 네트워크·브라우저 렌더링·실사용 분포를 재현하지 않아요. 병렬 검사 부하가 있는 로컬 소수 표본으로 보편적인 성능 SLA나 실제 사용자 개선률을 주장하지 않아요.

호출 비용은 모델·이미지 생성기의 서로 다른 단위를 유지해요. 구성 create/edit는 모델 호출 0회, Comfy 성공은 prompt 모델 1회 + `/prompt` 1회, 접수 후 재조회는 새 모델·렌더 POST 0회예요. 자동 생략은 판단 모델 1회 뒤 렌더 0회, 생성 OFF는 신규 삽화 작업 0개예요. Codex의 내부 이미지 모델 호출 수와 실제 billing은 공개 usage가 없으면 `null`로 보존해요. 로컬 합성 실행은 실제 과금·창작 품질의 증거가 아니에요.

## 구조·테스트 정리 판단

- **적용:** 실제 역할별 전송 DTO 공통화를 재사용했어요. 이미지 bytes/MIME/크기 경계는 core 공통 함수로 모으고 archive graph는 별도 모듈에서 관계를 검증해요. UI와 우이 구성 변경은 계속 같은 OutlineStore를 사용해요. 멱등 receipt는 개별 노드가 아닌 transaction 전체의 의미를 보관해요.
- **유지:** OutlineStore의 권한·저장·진행도·예약은 한 transaction에 결합돼요. 파일 길이만을 이유로 범용 TreeService/GenericRunner를 만들지 않았어요. Codex 이미지와 Comfy 제출/조회/회수는 다른 프로토콜 의미를 유지해요. 전송 전 재인가와 예약 snapshot은 별개 경계예요.
- **제거한 위험 경로:** 전체 원문 fallback, 공유 ComfyUI 전역 interrupt, 관찰되지 않는 finally 자식 Promise. 각각 공개 구간/no-main 검사, 대상별 취소 경합 검사, 실제 background 실패 재현이 대체 검출점이에요.
- **죽은 코드 판정:** 기존 이미지 배치, opt-in context tools·advisor, 일반 요약 복구, archive validation은 실제 등록/예약/소비 경로가 있어 삭제하지 않았어요. Reader의 전체 detail API도 Inspector·과거 Run 조회 소비자가 있어 이번 성능 개선을 이유로 제거하지 않았어요.
- **검사 유지비:** 기존 `docs/TESTING-AUDIT.md`의 통폐합을 다시 하지 않았어요. 단순 상태 mock은 유지하고 실제 전송 경계·fault/소유/복원만 보강했어요. 새 회귀마다 별도 browser runner를 만들지 않고 기존 outline/redesign에 연결했어요. 정밀 픽셀·전폭 반복 성능을 필수 빠른 gate에 넣지 않았어요.
- **후속 P2:** Reader 초기 메타데이터와 delta를 나누거나 변경 이벤트 기반 projection을 설계할 때, 페이지 밖 탐색·pending admission·현재 branch와 과거 run 조회 소비자를 먼저 고정해야 해요. 같은 측정과 `verify:loading`으로 비교하고 bytes/지연 기준은 실제 자료 크기에 맞춰 합의해요.

## 실서비스 인수서

담당은 의뢰자예요. 이 작업은 실제 공급자에 요청을 보내지 않았어요. 준비한 합성 결과를 실제 서비스 PASS로 바꾸지 않아요. 설치 버전·계정·보낼 합성 작품/이미지·허용 호출 횟수와 비용을 정한 뒤 아래 순서로 확인해요.

1. **인증·기본 흐름:** 현재 앱 build identity를 기록하고 봇/페르소나/본문·도우미·제목 모델을 지정해요. 비공개 원고 대신 짧은 합성 장면을 한 번 생성해요. 본문·우이 질문·자동 제목 각각 실제 응답과 attempt 상태를 확인해요. 제목 실패가 원문 실패로 바뀌면 불합격이에요.
2. **기억·계획 의미:** 같은 모델/작품 지침으로 즉흥 집필과 지정 단위 집필을 비교해요. 상위 계획에는 비밀 결말, 초반 원문에는 나중에 필요한 세부를 넣고 현재 메모에는 그 세부를 생략해요. 창 전환 후 자발적으로 원문을 찾아 반영하는지, 현재 요청·문체·인물 동기·미래 사건의 공개 시점을 지키는지 원문과 actual input을 대조해요. 구조 PASS와 의미 품질 판정은 별도예요.
3. **Codex:** 설치/인증 상태·선택 모델·사용량 여유를 기록하고 삽화 한 번만 요청해요. 실제 `imageGeneration` 이벤트에서 이미지가 저장되고 원래 source/hash 아래 보이는지 확인해요. 캐릭터/화풍 참조는 서로 다른 이미지를 지정해 각각 충실도를 평가해요. 로그인·사용량 한도·지원하지 않는 기능은 실패 코드로 분류해요. 불확실 실패를 연속 클릭으로 재전송하지 않아요.
4. **원격 ComfyUI:** Uimori 서버가 접근할 수 있는 주소와 인증 env, 설치 버전, API workflow·모델 파일을 기록해요. 연결 확인 후 한 번 생성하고 `/prompt` ID→history→이미지 저장을 대조해요. 응답을 지연시켜 timeout 뒤 결과 확인이 같은 ID만 읽는지 확인해요. 대상별 cancel 지원 서버와 구버전의 대기 삭제를 구분하고 다른 사용자의 렌더가 중단되면 불합격이에요.
5. **자료 보존·복구:** 검사 전용 DB에서 원문 편집 중 삽화 완료, 브라우저 재접속, 명시 취소·서버 재시작을 각각 실행해요. 원문/hash 귀속·stale 표시·중복 POST/이미지 없음·백업 복원 뒤 모델 미실행을 확인해요. 실제 운영 DB의 보존·폐기는 별도 승인 없이 바꾸지 않아요.
6. **기기·품질·비용:** 물리 휴대폰과 Windows 한국어 IME에서 모달 입력, 닫기/재열기 초안, 스크롤·포커스·취소·오류를 확인해요. 호출 수·토큰·실제 billing·wall time을 따로 적고, 모델 간 의미 품질 비교는 조건과 허용 퇴행을 먼저 정해요.

실서비스 합격은 시험한 설치·모델·workflow에만 적용해요. NovelAI·Comfy 참조 업로드·자동 재계획·여러 회차 연속 집필·공유 구성은 이번 필수 범위 밖이에요. 고정 다섯 계층은 UI/API와 현행 승인 범위에 맞춰 문서를 정정했으며 가변 깊이 기능을 추가하지 않았어요.

## 외부 소스 채택

ComfyUI 대상별 취소는 2026-09-09 조회한 공식 [Comfy-Org/ComfyUI server.py](https://github.com/Comfy-Org/ComfyUI/blob/master/server.py)의 `/api/jobs/{job_id}/cancel`과 `interrupt_if_running` 의미를 확인했어요. 코드를 복사하지 않고 클라이언트 프로토콜만 적용했어요. 설치된 원격 버전 지원 여부는 미검증이고 404/405일 때는 대상 ID의 queue 삭제만 사용해요. 조회 후 전역 interrupt를 보내는 방식은 경쟁 상태 때문에 채택하지 않았어요.
