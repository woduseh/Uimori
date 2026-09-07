import { rejectRetiredLiveJourney } from './retired-live-journey.mjs';

// Retained only to reject historical entry points before any browser, file or network work.
export async function runLiveJourney() {
  rejectRetiredLiveJourney();
}
