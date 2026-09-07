import { expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const browserUrl = new URL('../scripts/live-journey-browser.mjs', import.meta.url).href;
const resumeUrl = new URL('../scripts/resume-journey-browser.mjs', import.meta.url).href;
const { runLiveJourney } = await import(browserUrl);
const { runResumeJourney } = await import(resumeUrl);

test('retired browser entry points reject before inspecting options', async () => {
  const options = new Proxy(
    {},
    {
      get: () => {
        throw Error('OPTIONS_MUST_NOT_BE_USED');
      },
    }
  );
  await expect(runLiveJourney(options)).rejects.toThrow('LIVE_JOURNEY_LEGACY_CANDIDATE_UI_RETIRED');
  await expect(runResumeJourney(options)).rejects.toThrow(
    'LIVE_JOURNEY_LEGACY_CANDIDATE_UI_RETIRED'
  );
});

test('retired CLI preflight and execute stop before source validation, copying, authentication or provider work', () => {
  const script = fileURLToPath(new URL('../scripts/verify-live-journey.mjs', import.meta.url));
  for (const args of [[], ['--execute', '--source', 'THIS_SOURCE_MUST_NEVER_BE_OPENED']]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'BLOCKED',
      legacy: true,
      mode: args.length ? 'execute' : 'preflight',
      code: 'LIVE_JOURNEY_LEGACY_CANDIDATE_UI_RETIRED',
      preflight: {
        ready: false,
        sourceRead: false,
        databaseCopied: false,
        authenticationAttempted: false,
        networkRequests: 0,
      },
    });
  }
});

test('explicit execute cannot reactivate either retired browser path', async () => {
  const page = new Proxy(
    {},
    {
      get: () => {
        throw Error('PAGE_MUST_NOT_BE_USED');
      },
    }
  );
  await expect(runLiveJourney({ execute: true, page })).rejects.toThrow(
    'LIVE_JOURNEY_LEGACY_CANDIDATE_UI_RETIRED'
  );
  await expect(runLiveJourney({ execute: true, page, resumeChat: 'chat' })).rejects.toThrow(
    'LIVE_JOURNEY_LEGACY_CANDIDATE_UI_RETIRED'
  );
  await expect(runResumeJourney({ execute: true, page })).rejects.toThrow(
    'LIVE_JOURNEY_LEGACY_CANDIDATE_UI_RETIRED'
  );
});
