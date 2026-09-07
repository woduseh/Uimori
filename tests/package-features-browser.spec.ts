import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import type { ContentPackage } from '../core/content-package.js';
import type { Content } from '../core/product.js';
import type { ChatDetail } from '../core/types.js';

async function seed(
  request: APIRequestContext,
  kind: 'bot' | 'persona' | 'module',
  title: string,
  part: Partial<ContentPackage> = {}
) {
  const pkg: ContentPackage = {
    version: 1,
    id: 'synthetic_features',
    revision: 1,
    title,
    description: 'Synthetic only',
    body: 'Synthetic shared package',
    lore: [],
    instructions: [],
    controls: [],
    transforms: [],
    ...part,
  };
  const response = await request.post('/api/content', {
    data: {
      kind,
      title,
      description: pkg.description,
      text: pkg.body,
      loading: 'pinned',
      relatedIds: [],
      package: pkg,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<Content>;
}
async function openEditor(page: Page, content: Content) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page
    .getByRole('navigation', { name: '자료 탐색', exact: true })
    .getByRole('button', { name: '봇', exact: true })
    .click();
  const library = page.getByTestId('library-panel');
  if (content.kind !== 'bot')
    await library
      .getByRole('tab', { name: content.kind === 'module' ? '모듈' : '페르소나', exact: true })
      .click();
  await library.getByRole('button', { name: `${content.title} 자료 편집`, exact: true }).click();
  return { library, fields: library.getByRole('region', { name: '패키지 구성', exact: true }) };
}
async function saveEditor(page: Page, library: Locator, id: string): Promise<Content> {
  const pending = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/content/${id}`) && response.request().method() === 'PUT'
  );
  await library.getByRole('button', { name: '새 revision 저장', exact: true }).click();
  const response = await pending;
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function evidence(page: Page, target: Locator, info: TestInfo, name: string) {
  for (const [suffix, width, height] of [
    ['desktop', 1440, 1000],
    ['mobile', 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await target.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    const dialog = page.getByRole('dialog').filter({ visible: true });
    if (await dialog.count())
      expect(
        await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
      ).toBe(true);
    await page.screenshot({ path: info.outputPath(`${name}-${suffix}.png`) });
  }
}
async function detail(request: APIRequestContext, id: string): Promise<ChatDetail> {
  const response = await request.get(`/api/chats/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

test('PFUI01 option drafts survive tabs and validated authoring preserves templates until explicit static conversion', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const original = await seed(request, 'bot', `합성 옵션 제작 ${Date.now()}`, {
    controls: [{ id: 'gate', label: '고급 설정', type: 'boolean', default: false }],
    instructions: [
      {
        id: 'guide',
        target: 'main',
        text: '보관용 본문',
        template: [{ kind: 'text', text: '실행 템플릿 원문' }],
      },
    ],
  });
  const { library, fields } = await openEditor(page, original),
    save = library.getByRole('button', { name: '새 revision 저장', exact: true });
  await fields.getByRole('button', { name: '옵션', exact: true }).click();
  await fields.getByRole('button', { name: '옵션 추가', exact: true }).click();
  await fields.getByLabel('옵션 2 이름', { exact: true }).fill('마법 계열');
  await fields.getByLabel('옵션 2 종류', { exact: true }).selectOption('select');
  await fields.getByLabel('옵션 2 기능 그룹', { exact: true }).fill('마법');
  await fields.getByLabel('옵션 2 선택지 1 이름', { exact: true }).fill('불꽃');
  await fields.getByLabel('옵션 2 선택지 1 값', { exact: true }).fill('fire');
  await fields.getByRole('button', { name: '선택지 추가', exact: true }).click();
  await fields.getByLabel('옵션 2 선택지 2 이름', { exact: true }).fill('서리');
  await fields.getByLabel('옵션 2 선택지 2 값', { exact: true }).fill('ice');
  await fields.getByLabel('옵션 2 기본 선택', { exact: true }).selectOption('1');
  await fields.getByRole('button', { name: '옵션 추가', exact: true }).click();
  await fields.getByLabel('옵션 3 이름', { exact: true }).fill('힘');
  await fields.getByLabel('옵션 3 종류', { exact: true }).selectOption('number');
  await fields.getByLabel('옵션 3 기능 그룹', { exact: true }).fill('마법');
  await fields.getByLabel('옵션 3 기본값', { exact: true }).fill('4');
  await fields.getByLabel('옵션 3 최솟값', { exact: true }).fill('1');
  await fields.getByLabel('옵션 3 최댓값', { exact: true }).fill('9');
  const third = fields.getByRole('group', { name: '옵션 3', exact: true });
  await third.getByText('옵션 ID와 표시 조건', { exact: true }).click();
  await fields.getByLabel('옵션 3 ID', { exact: true }).fill('power');
  const condition = fields.getByLabel('옵션 3 표시 조건 JSON', { exact: true });
  await condition.fill('{broken');
  await fields.getByRole('button', { name: '옵션 검증 후 적용', exact: true }).click();
  await expect(third.getByLabel('옵션 3 표시 조건 JSON', { exact: true })).toHaveValue('{broken');
  await expect(save).toBeDisabled();
  await fields.getByRole('button', { name: '지침', exact: true }).click();
  await fields.getByRole('button', { name: '옵션', exact: true }).click();
  await expect(condition).toHaveValue('{broken');
  await condition.fill('{"control":"missing"}');
  await fields.getByRole('button', { name: '옵션 검증 후 적용', exact: true }).click();
  await expect(fields.getByRole('alert')).toContainText('PROMPT_UNKNOWN_CONTROL');
  await expect(save).toBeDisabled();
  await condition.fill('{"control":"gate"}');
  await fields.getByRole('button', { name: '옵션 검증 후 적용', exact: true }).click();
  await expect(save).toBeEnabled();
  await fields.getByText('채팅 옵션 미리보기', { exact: true }).click();
  const preview = fields.locator('.package-control-values');
  await expect(preview.getByRole('group', { name: '마법', exact: true })).toBeVisible();
  await expect(preview.getByLabel('힘', { exact: true })).toHaveCount(0);
  await preview.getByLabel('고급 설정', { exact: true }).check();
  await expect(preview.getByLabel('힘', { exact: true })).toHaveValue('4');
  await preview.getByLabel('힘', { exact: true }).fill('7');
  await preview.getByLabel('고급 설정', { exact: true }).uncheck();
  await preview.getByLabel('고급 설정', { exact: true }).check();
  await expect(preview.getByLabel('힘', { exact: true })).toHaveValue('7');
  await evidence(page, preview, info, 'package-options');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fields.getByRole('button', { name: '지침', exact: true }).click();
  await fields.getByLabel('지침 1 본문', { exact: true }).fill('수정한 보관용 본문');
  await expect(save).toBeDisabled();
  await expect(fields.getByLabel('지침 1 조건 템플릿', { exact: true })).toHaveValue(
    JSON.stringify(original.package!.instructions[0].template, null, 2)
  );
  await fields.getByRole('button', { name: '지침 검증 후 적용', exact: true }).click();
  const preserved = await saveEditor(page, library, original.id);
  expect(preserved.package!.instructions[0]).toMatchObject({
    text: '수정한 보관용 본문',
    template: original.package!.instructions[0].template,
  });
  expect(preserved.package!.controls[1]).toMatchObject({
    type: 'select',
    default: 'ice',
    group: '마법',
    options: [
      { label: '불꽃', value: 'fire' },
      { label: '서리', value: 'ice' },
    ],
  });
  expect(preserved.package!.controls[2]).toMatchObject({
    id: 'power',
    type: 'number',
    default: 4,
    min: 1,
    max: 9,
    visibleWhen: { control: 'gate' },
  });
  await fields.getByLabel('지침 1 실행 본문 방식', { exact: true }).selectOption('text');
  await expect(save).toBeDisabled();
  await fields.getByRole('button', { name: '지침 검증 후 적용', exact: true }).click();
  const plain = await saveEditor(page, library, original.id);
  expect(plain.package!.instructions[0].template).toBeUndefined();
  expect(plain.package!.instructions[0].text).toBe('수정한 보관용 본문');
  expect(
    (await (await request.get(`/api/revisions/content/${original.id}/1`)).json()).package
  ).toEqual(original.package);
  expect(errors).toEqual([]);
});

test('PFUI02 required module appears once and keeps chat options after another requiring root is removed', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  const stamp = Date.now(),
    errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const magic = await seed(request, 'module', `합성 마법 ${stamp}`, {
    controls: [
      { id: 'mana', label: '마나', type: 'number', default: 7, min: 0, max: 100, group: '마법' },
    ],
  });
  const modules = [{ id: magic.id, revision: magic.revision }],
    bot = await seed(request, 'bot', `합성 마법사 ${stamp}`, { modules }),
    persona = await seed(request, 'persona', `합성 제자 ${stamp}`, { modules });
  const made = await request.post('/api/chats', {
    data: { title: `필수 모듈 합성 ${stamp}`, botId: bot.id },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const chat = await made.json();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/?chat=${chat.id}`);
  await page.getByRole('button', { name: '채팅 설정', exact: true }).click();
  const editor = page.getByTestId('profile-editor'),
    panel = editor.getByRole('region', { name: '장착 패키지', exact: true });
  const magicRow = panel
    .locator('.package-attachment')
    .filter({ has: page.getByRole('heading', { name: magic.title, exact: true }) });
  await expect(magicRow).toHaveCount(1);
  await expect(magicRow.getByText('필수 모듈 · 자동 연결', { exact: true })).toBeVisible();
  await expect(magicRow.getByRole('button', { name: '해제', exact: true })).toHaveCount(0);
  await magicRow.getByLabel(`${magic.title} 마나`, { exact: true }).fill('42');
  await panel
    .getByLabel('추가할 패키지', { exact: true })
    .selectOption(`${persona.id}@${persona.revision}`);
  await panel.getByLabel('패키지 장착 역할', { exact: true }).selectOption('persona');
  await panel.getByRole('button', { name: '패키지 장착', exact: true }).click();
  const personaRow = panel
    .locator('.package-attachment')
    .filter({ has: page.getByRole('heading', { name: persona.title, exact: true }) });
  await expect(personaRow).toBeVisible();
  await expect(magicRow).toHaveCount(1);
  await expect(magicRow.getByLabel(`${magic.title} 마나`, { exact: true })).toHaveValue('42');
  const pending = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/chats/${chat.id}/profile`) &&
      response.request().method() === 'PUT'
  );
  await editor.getByRole('button', { name: '콘텐츠와 제어 저장', exact: true }).click();
  expect((await pending).ok()).toBe(true);
  const shared = await detail(request, chat.id),
    scope = `${magic.id}@${magic.revision}:module`;
  expect(shared.profile!.packageAttachments).toEqual([
    { id: bot.id, revision: bot.revision, role: 'bot' },
    { id: persona.id, revision: persona.revision, role: 'persona' },
  ]);
  expect(shared.profile!.packageValues?.[scope]).toEqual({ mana: 42 });
  await evidence(page, magicRow, info, 'required-module');
  await personaRow.getByRole('button', { name: '해제', exact: true }).click();
  await expect(personaRow).toHaveCount(0);
  await expect(magicRow).toHaveCount(1);
  await expect(magicRow.getByLabel(`${magic.title} 마나`, { exact: true })).toHaveValue('42');
  const removed = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/chats/${chat.id}/profile`) &&
      response.request().method() === 'PUT'
  );
  await editor.getByRole('button', { name: '콘텐츠와 제어 저장', exact: true }).click();
  expect((await removed).ok()).toBe(true);
  const after = await detail(request, chat.id);
  expect(after.profile!.packageAttachments).toEqual([
    { id: bot.id, revision: bot.revision, role: 'bot' },
  ]);
  expect(after.profile!.packageValues?.[scope]).toEqual({ mana: 42 });
  expect(after.runs).toHaveLength(0);
  expect(after.attempts).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('PFUI03 generic source segment drafts validate before save and keep authored controls across detach and restore', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  const stamp = Date.now();
  const content = await seed(request, 'module', `합성 본문 구간 ${stamp}`, {
      controls: [
        { id: 'tone', label: '작성 분위기', type: 'text', default: 'quiet', group: '직접 작성' },
      ],
    }),
    { library, fields } = await openEditor(page, content);
  await fields.getByRole('button', { name: '연결과 기능', exact: true }).click();
  const features = fields.getByLabel('패키지 모듈과 기능 편집', { exact: true });
  await features.getByRole('button', { name: '구간 추가', exact: true }).click();
  await features.getByLabel('구간 이름', { exact: true }).fill('다른 관찰자의 기록');
  await features.getByLabel('시작 표식', { exact: true }).fill('[[record]]');
  await features.getByLabel('끝 표식', { exact: true }).fill('[[record]]');
  await features.getByRole('button', { name: '구간 설정을 초안에 적용', exact: true }).click();
  await expect(features.getByRole('alert')).toContainText('SEGMENT_DELIMITER_CONFLICT');
  await expect(features.getByLabel('끝 표식', { exact: true })).toHaveValue('[[record]]');
  await expect(
    library.getByRole('button', { name: '새 revision 저장', exact: true })
  ).toBeDisabled();
  expect(
    (await (await request.get(`/api/revisions/content/${content.id}/${content.revision}`)).json())
      .package
  ).toEqual(content.package);
  await features.getByLabel('끝 표식', { exact: true }).fill('[[/record]]');
  await features.getByLabel('처음부터 펼쳐 표시', { exact: true }).check();
  await features.getByLabel('다음 요청에서 제외', { exact: true }).check();
  await features.getByRole('button', { name: '구간 설정을 초안에 적용', exact: true }).click();
  const linked = await saveEditor(page, library, content.id);
  expect(linked.package!.sourceSegments!.rules).toEqual([
    expect.objectContaining({
      id: 'aside-1',
      open: '[[record]]',
      close: '[[/record]]',
      label: '다른 관찰자의 기록',
      exclude: true,
      expanded: true,
    }),
  ]);
  expect(linked.package!.controls).toEqual(content.package!.controls);
  await evidence(
    page,
    features.getByRole('heading', { name: '별도 본문 구간', exact: true }),
    info,
    'package-source-segments'
  );
  await features.getByRole('button', { name: '구간 제거', exact: true }).click();
  await features.getByRole('button', { name: '구간 설정을 초안에 적용', exact: true }).click();
  const detached = await saveEditor(page, library, content.id);
  expect(detached.package!.sourceSegments).toBeUndefined();
  expect(detached.package!.controls).toEqual(content.package!.controls);
  await features.getByRole('button', { name: '구간 추가', exact: true }).click();
  await features.getByLabel('구간 이름', { exact: true }).fill('다른 관찰자의 기록');
  await features.getByLabel('시작 표식', { exact: true }).fill('[[record]]');
  await features.getByLabel('끝 표식', { exact: true }).fill('[[/record]]');
  await features.getByLabel('처음부터 펼쳐 표시', { exact: true }).check();
  await features.getByLabel('다음 요청에서 제외', { exact: true }).check();
  await features.getByRole('button', { name: '구간 설정을 초안에 적용', exact: true }).click();
  const reconnected = await saveEditor(page, library, content.id);
  expect(reconnected.package!.controls).toEqual(content.package!.controls);
  expect(reconnected.package!.sourceSegments).toEqual(linked.package!.sourceSegments);
  expect(
    (await (await request.get(`/api/revisions/content/${content.id}/${linked.revision}`)).json())
      .package
  ).toEqual(linked.package);
});
