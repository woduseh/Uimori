# 2026-09-09 운영 v14 복사본의 v15 이관

사용자가 두 세션의 변경 커밋·푸시·배포와 운영 저장값 이관을 명시적으로 요청한 건을 위한 일회성 도구예요. 앱 시작이나 JSON 가져오기에 연결하지 않아요. 일반적인 구버전 호환·자동 이관 기능이 아니에요.

저장소 루트에서 검증한 v15 빌드와 **읽기 전용 SQLite backup**을 사용해요. 목적지 세 개는 서로 다르고 존재하지 않아야 해요.

```powershell
node scripts/maintenance/migrate-v14-v15.mjs SOURCE.sqlite TARGET.sqlite VALIDATION.sqlite REPORT.json
```

도구는 검토한 앱 buildId와 원본 전체 테이블의 논리 해시를 고정해요. 다른 원본이면 새 backup의 데이터·변환 영향 검토 없이 이 guard를 바꾸지 않아요. 추출 기억·상태 작업·패키지 실행 상태·압축 문맥·진행 중 작업이 없는 이번 데이터에만 적용해요.

- 채팅 2개, 원문 2개, 완료 Run 2개, 요청 attempt 15개, 번역 job 14개와 결과·자료·설정·연결 인증 참조를 보존해요.
- typed 프롬프트 `memory` 슬롯은 `notes`로, 기존 한 개의 기억 모델 선택은 전역 `contextModel`로 이어줘요. 새 `helperModel`은 미선택이며 자동 기억 추출 설정은 제거해요.
- 폐기된 내부 `capabilityRevision`과 파생 Run 문맥 메타데이터를 정리해요. 변환 전후 실제 프롬프트 메시지와 원문 이력의 동일성을 검사하며 실제 전송 요청·응답·원문·사용량은 수정하지 않아요. 원래 v14 snapshot도 보존해요.
- FK·무결성·전체 행·역사 데이터 해시와 별도 DB의 v15 JSON 내보내기/복원을 검사해요. 복원 검사는 인증 정보를 정규화하므로 **VALIDATION.sqlite를 운영에 사용하지 않아요**.
- 공급자나 백그라운드 worker를 실행하지 않아요. 실패한 대상도 보존하므로 재시도에는 새 목적지 경로를 사용해요.

운영 전환에서는 앱만 정상 종료한 뒤 기존 볼륨을 읽기 전용으로 마운트해 최종 논리 해시를 다시 비교해요. 달라졌으면 예전 복사본으로 전환하지 말고 기존 서비스를 복구한 뒤 새 backup을 검토해요. 새 이름의 볼륨에 TARGET.sqlite와 기존 credential/Codex 디렉터리를 복사하고 소유권·해시를 확인해요. `.env.self-host`의 `UIMORI_IMAGE_TAG`와 `UIMORI_DATA_VOLUME`을 한 번에 바꿔요. 두 compose 파일의 기본 볼륨명은 기존 `uimori_data`예요.

실패 복구는 이전 checkout·이미지·볼륨의 조합으로 돌아가요. v14 볼륨과 backup, 기존 비밀 설정·외부 URL·PocketRisu·Tailscale 경로를 보존해요. 이미지 교체 뒤 건강 상태, 실제 schema/FK, 데이터와 비밀 파일 보존, HTTPS 읽기 전용 화면을 확인하고 개별 배포 manifest를 `output/`에 남겨요.
