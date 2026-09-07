import { liveJourneyRetirement } from './retired-live-journey.mjs';

// Historical candidate UI verification remains retired in both modes.
// Exit before source reads, output creation, build checks or authentication.
console.log(
  JSON.stringify(
    liveJourneyRetirement(process.argv.includes('--execute') ? 'execute' : 'preflight')
  )
);
process.exit(2);
