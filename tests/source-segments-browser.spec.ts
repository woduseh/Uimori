import { MOBILE_WIDTH, DESKTOP_WIDTH } from './fixtures/browser-viewports.js';
import { navigationAction } from './ui-navigation.js';
import { waitForContentDraftSave } from './fixtures/edit-draft-save.js';
import { visualReview } from './fixtures/visual-review.js';
import { editLibraryContent, selectPackageSection } from './ui-navigation.js';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { fixtureBotInput } from './fixtures/chat.js';
import { createSourceSegmentFixture } from './fixtures/source-segments.js';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import type { Content } from '../core/product.js';

async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}
async function chat(request: APIRequestContext, title: string): Promise<Chat> {
  const input = fixtureBotInput(`${title} owner`);
  const owner = await request.post('/api/content', {
    data: { ...input, package: { ...input.package, sourceSegments: createSourceSegmentFixture() } },
  });
  expect(owner.ok(), await owner.text()).toBe(true);
  const response = await request.post('/api/chats', {
    data: { title, botId: (await owner.json()).id },
  });
  expect(response.ok()).toBe(true);
  return response.json();
}
async function generate(request: APIRequestContext, id: string) {
  const before = await detail(request, id);
  const response = await request.post(`/api/chats/${id}/runs`, {
    data: {
      request: 'Synthetic harbor scene.',
      expectedRevision: before.chat.headRevision,
      expectedSettingsRevision: before.chat.settingsRevision,
      expectedProfileRevision: before.profile!.revision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(response.ok()).toBe(true);
  const run = (await response.json()) as Run;
  await expect
    .poll(async () => (await detail(request, id)).runs.find((r) => r.id === run.id)?.status)
    .toBe('completed');
}
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true
  );
  const dialog = page.getByRole('dialog').filter({ visible: true });
  if (await dialog.count())
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
}
test('SEGMENTUI01 package-defined source reader expands without writes and displays the current translated source', async ({
  page,
  request,
}, info) => {
  const c = await chat(request, 'Synthetic source segment reader UI');
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  await generate(request, c.id);
  const source = (await detail(request, c.id)).sources[0];
  const text =
    'Main harbor arrival.\n\n@hsTitle: Quiet Tower\n⟦Tower @ Dawn @ Mira⟧\nMira recalls a blue bell.\n@hs\n\nMain crossing.\n\n@hsTitle: Old Letter\nAnother traveler remembers winter.\n@hs\n\nMain departure.';
  const edited = await request.put(`/api/sources/${source.id}/text`, {
    data: { text, expectedRevision: source.editRevision ?? 0 },
  });
  expect(edited.ok()).toBe(true);
  const before = await detail(request, c.id);
  await page.goto(`/?chat=${c.id}`);
  const reader = page.locator('.source-segments-reader');
  await expect(reader).toBeVisible();
  const sections = reader.locator(
    ':scope > .source-main-segment, :scope > details.source-aside-segment'
  );
  expect(
    await sections.evaluateAll((elements) =>
      elements.map((el) => (el.tagName === 'DETAILS' ? 'hidden' : 'main'))
    )
  ).toEqual(['main', 'hidden', 'main', 'hidden', 'main']);
  const hidden = reader.locator('details.source-aside-segment');
  await expect(hidden).toHaveCount(2);
  expect(await hidden.first().getAttribute('open')).toBeNull();
  await hidden.first().locator('summary').click();
  await expect(hidden.first()).toHaveAttribute('open', '');
  await expect(hidden.first()).toContainText('Mira recalls a blue bell.');
  await expect(hidden.first().getByRole('list', { name: '이 장면의 장소와 시점' })).toHaveCount(0);
  await expect(hidden.first().locator('dl')).toContainText('Tower');
  await expect(reader).not.toContainText('등장인물');
  await fits(page);
  if (visualReview)
    await page.screenshot({ path: info.outputPath('source-segments-reader-mobile.png') });
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
  await fits(page);
  if (visualReview)
    await page.screenshot({ path: info.outputPath('source-segments-reader-desktop.png') });
  await hidden.first().locator('summary').click();
  const after = await detail(request, c.id);
  expect(after.sources).toEqual(before.sources);
  expect(after.runs).toEqual(before.runs);
  expect(after.attempts).toEqual(before.attempts);
  expect(after.profile).toEqual(before.profile);
  expect(after.sources[0].hash).toBe(createHash('sha256').update(text).digest('hex'));
  await page.getByRole('button', { name: '번역 보기', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await detail(request, c.id)).jobs.find(
          (job) => job.kind === 'translation' && job.sourceRevision === source.id
        )?.status
    )
    .toBe('completed');
  const translatedBaseline = await detail(request, c.id);
  const translatedJob = translatedBaseline.jobs.find(
    (job) => job.kind === 'translation' && job.sourceRevision === source.id
  )!;
  expect(translatedJob.sourceHash).toBe(before.sources[0].hash);
  expect(translatedJob.result).toMatchObject({
    sourceRevision: source.id,
    sourceHash: before.sources[0].hash,
    mock: true,
    text,
  });
  await expect(page.getByRole('button', { name: '번역 보기', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.getByRole('button', { name: '원문 보기', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false'
  );
  // Whole-source translations display independently from original segment syntax.
  await expect(page.getByTestId('source-text')).toHaveCount(0);
  const translatedBody = page.getByTestId('translation-text');
  await expect(translatedBody).toBeVisible();
  await expect(translatedBody.locator('.source-segments-reader')).toHaveCount(0);
  await expect(translatedBody).toContainText('Mira recalls a blue bell.');
  for (const [name, width, height] of [
    ['desktop', DESKTOP_WIDTH, 1000],
    ['mobile', MOBILE_WIDTH, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await translatedBody.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await fits(page);
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`source-segments-translation-${name}.png`) });
  }
  const translated = await detail(request, c.id);
  expect(translatedJob.revision).toBe((before.sources[0].translationRevision ?? 0) + 1);
  expect(translated.sources).toEqual(
    before.sources.map((item) =>
      item.id === source.id ? { ...item, translationRevision: translatedJob.revision } : item
    )
  );
  expect(translated.runs).toEqual(before.runs);
  expect(translated.profile).toEqual(before.profile);
  expect(translated.jobs.filter((job) => job.kind === 'translation')).toHaveLength(1);
  const priorAttemptIds = new Set(before.attempts!.map((attempt) => attempt.id));
  expect(translatedBaseline.attempts!.filter((attempt) => priorAttemptIds.has(attempt.id))).toEqual(
    before.attempts
  );
  const translationAttempts = translatedBaseline.attempts!.filter(
    (attempt) => !priorAttemptIds.has(attempt.id)
  );
  expect(translationAttempts).toHaveLength(1);
  expect(translationAttempts[0]).toMatchObject({
    role: 'translation',
    jobId: translatedJob.id,
    status: 'mock',
    connectionId: 'local-scripted',
  });
  expect(translated.sources).toEqual(translatedBaseline.sources);
  expect(translated.jobs).toEqual(translatedBaseline.jobs);
  expect(translated.attempts).toEqual(translatedBaseline.attempts);
  const changedMarkers = text
    .replaceAll('@hsTitle:', 'Translated aside:')
    .replaceAll('@hs', 'End aside.');
  const manual = await request.put(`/api/sources/${source.id}/translation`, {
    data: {
      text: changedMarkers,
      expectedRevision: translatedJob.revision,
      expectedSourceHash: before.sources[0].hash,
    },
  });
  expect(manual.ok(), await manual.text()).toBe(true);
  await expect(translatedBody).toContainText('Translated aside:');
  await expect(page.getByTestId('source-text')).toHaveCount(0);
  await expect(translatedBody.locator('.source-segments-reader')).toHaveCount(0);
  await expect(page.getByText('번역의 구간 경계를 확인할 수 없어', { exact: false })).toHaveCount(
    0
  );
  const manuallyTranslated = await detail(request, c.id);
  expect(manuallyTranslated.attempts).toEqual(translatedBaseline.attempts);
  expect(manuallyTranslated.sources[0].text).toBe(text);
});

test('SEGMENTUI02 current modules preserve unapplied segment drafts and existing Run snapshots', async ({
  page,
  request,
}, info) => {
  const stamp = Date.now(),
    input = fixtureBotInput(`Synthetic shared module ${stamp}`);
  const moduleResponse = await request.post('/api/content', { data: { ...input, kind: 'module' } });
  expect(moduleResponse.ok(), await moduleResponse.text()).toBe(true);
  const module = (await moduleResponse.json()) as Content;
  const ownerInput = fixtureBotInput(`Synthetic segment authoring ${stamp}`);
  const ownerResponse = await request.post('/api/content', {
    data: {
      ...ownerInput,
      package: {
        ...ownerInput.package,
        modules: [{ id: module.id, revision: module.revision }],
        sourceSegments: { version: 1, rules: createSourceSegmentFixture().rules.slice(0, 1) },
      },
    },
  });
  expect(ownerResponse.ok(), await ownerResponse.text()).toBe(true);
  const owner = (await ownerResponse.json()) as Content;
  const seededResponse = await request.post('/api/chats', {
    data: { title: 'Synthetic preserved module run', botId: owner.id },
  });
  expect(seededResponse.ok()).toBe(true);
  const seededChat = (await seededResponse.json()) as Chat;
  await generate(request, seededChat.id);
  const beforeRuns = (await detail(request, seededChat.id)).runs;
  expect(beforeRuns[0].snapshot.profile?.packageAttachments).toContainEqual({
    id: module.id,
    revision: module.revision,
    role: 'module',
  });
  const revisionResponse = await request.put(`/api/content/${module.id}`, {
    data: {
      ...input,
      kind: 'module',
      title: `${input.title} revised`,
      package: module.package,
      expectedRevision: module.revision,
    },
  });
  expect(revisionResponse.ok(), await revisionResponse.text()).toBe(true);
  const revised = (await revisionResponse.json()) as Content;

  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
  await page.goto('/');
  await navigationAction(page, '서재');
  const library = page.getByTestId('library-panel');
  await editLibraryContent(page, `${owner.title}`);
  const fields = library.getByRole('region', { name: '패키지 구성', exact: true });
  await selectPackageSection(page, '연결과 기능');
  const features = fields.getByLabel('패키지 모듈과 기능 편집', { exact: true });
  const name = features.getByLabel('구간 이름', { exact: true });
  const save = library.getByRole('button', { name: '변경사항 저장', exact: true });
  await name.fill('UNAPPLIED_SEGMENT_DRAFT');
  await features.getByRole('button', { name: '자료와 기능 목록 새로고침', exact: true }).click();
  await expect(features.getByText(revised.title, { exact: true }).first()).toBeVisible();
  await expect(features.getByLabel(`${module.id} 고정 버전`, { exact: true })).toHaveCount(0);
  await expect(name).toHaveValue('UNAPPLIED_SEGMENT_DRAFT');
  await expect(save).toBeDisabled();
  await features.getByRole('button', { name: '구간 설정을 초안에 적용', exact: true }).click();
  await expect(save).toBeEnabled();
  await name.fill('SECOND_UNAPPLIED_DRAFT');
  await features.getByRole('button', { name: '구간 초안 되돌리기', exact: true }).click();
  await expect(name).toHaveValue('UNAPPLIED_SEGMENT_DRAFT');
  await expect(save).toBeEnabled();
  const savedResponse = waitForContentDraftSave(page, owner.id);
  await save.click();
  const saved = await savedResponse;
  expect(saved.package!.modules).toEqual(owner.package!.modules);
  expect(saved.package!.sourceSegments!.rules[0].label).toBe('UNAPPLIED_SEGMENT_DRAFT');
  expect((await detail(request, seededChat.id)).runs).toEqual(beforeRuns);
  await generate(request, seededChat.id);
  const afterRuns = (await detail(request, seededChat.id)).runs;
  const nextRun = afterRuns.find((run) => !beforeRuns.some((previous) => previous.id === run.id))!;
  expect(nextRun.snapshot.profile?.packageAttachments).toContainEqual({
    id: module.id,
    revision: revised.revision,
    role: 'module',
  });
  for (const previous of beforeRuns)
    expect(afterRuns.find((run) => run.id === previous.id)).toEqual(previous);

  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  await name.scrollIntoViewIfNeeded();
  await fits(page);
  if (visualReview)
    await page.screenshot({
      path: info.outputPath('source-segments-draft-preservation-mobile.png'),
    });
});
