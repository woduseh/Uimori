// Historical approval and oracle covered failed chunks only. Do not reinterpret
// that approval as a whole-source request with current prompts and a classifier.
console.log(
  JSON.stringify({
    schema: 1,
    mode: process.argv.includes('--execute') ? 'execute' : 'preflight',
    status: 'BLOCKED',
    legacy: true,
    code: 'LIVE_RETRY_FAILED_CHUNK_CONTRACT_RETIRED',
    message:
      '이전 실패 구간 전용 검증기는 종료됐어요. 새 전체 원문 live 평가는 별도 계획이 필요해요.',
    preflight: {
      ready: false,
      sourceRead: false,
      databaseCopied: false,
      authenticationAttempted: false,
      networkRequests: 0,
    },
  })
);
process.exit(2);
