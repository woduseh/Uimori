export const LIVE_JOURNEY_RETIRED = 'LIVE_JOURNEY_LEGACY_CANDIDATE_UI_RETIRED';
export const liveJourneyRetirement = mode => ({
  schema: 1, mode, status: 'BLOCKED', legacy: true, code: LIVE_JOURNEY_RETIRED,
  message: '이전 후보 UI용 검증기는 종료됐어요. 기존 증거는 보존하며 새 유료 여정은 실행하지 않아요.',
  preflight: { ready: false, sourceRead: false, databaseCopied: false, authenticationAttempted: false, networkRequests: 0 },
});
export function rejectRetiredLiveJourney() {
  throw Object.assign(new Error(LIVE_JOURNEY_RETIRED), { code: LIVE_JOURNEY_RETIRED });
}
