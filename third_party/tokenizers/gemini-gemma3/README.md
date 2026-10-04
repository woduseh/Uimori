# Gemma 3 자산 재생성

`convert.py`는 개발용 오프라인 변환 도구예요. 원본 모델 URL·SHA256과 필요한
Python 패키지 버전은 `SOURCE.json`에 있어요. 패키지가 준비된 개발 환경에서 실행하세요.
스크립트는 네트워크 요청이나 패키지 설치를 하지 않아요.

```sh
python -X utf8 convert.py path/to/original.spiece.model path/to/output-directory
```

원본 SHA256과 패키지 버전을 확인하고, 원본 SentencePiece와 `reference-vectors.json`을
대조한 다음 두 gzip 파일을 생성해요. JSON 및 gzip SHA256이 `SOURCE.json`의 현재 자산과
같아야 성공해요. Python은 이 재생성 단계에서만 사용하고, 운영 계수는 Node에서 수행해요.
