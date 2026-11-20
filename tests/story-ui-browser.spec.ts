import { expect, type Locator, test } from '@playwright/test';
import { startFixtureVite, type FixtureVite } from './fixtures/fixture-vite.js';
import { visualReview } from './fixtures/visual-review.js';
let vite: FixtureVite;
let origin: string;
test.beforeAll(async () => {
  vite = await startFixtureVite([
    'react',
    'react-dom/client',
    'dompurify',
    'markdown-it',
    '@a2ui/react',
    '@a2ui/web_core',
    '@a2ui/web_core/catalogs/basic/v1',
    'zod',
    'intl-messageformat',
  ]);
  origin = vite.origin;
});
test.afterAll(async () => {
  await vite?.close();
});
test('renders bound image lists and icons without fetching edited external URLs', async ({
  page,
}, info) => {
  const { normalizeStoryUiOutput } = await import('../server/story-ui.js');
  const source = normalizeStoryUiOutput(
    `<a2ui>
$/people = [{name: "미라", portrait: "{{img::미라_미소}}", icon: "person"}, {name: "솔", portrait: "/api/assets/sol", icon: "home"}]
$/portrait = "/api/assets/selected"
item = Row([Image($portrait, description=$name, variant="avatar"), Icon($icon), Text($name)])
root = Column([List(_template($/people, item)), TextField("첫 아이콘", $/people/0/icon), TextField("초상화 경로", $/portrait), Image($/portrait, description="선택한 초상화", fit="scaleDown"), Image("https://outside.invalid/literal.png", description="밖의 그림"), Text("끝")])
</a2ui>`,
    (name) => (name === '미라_미소' ? '/api/package-image-blobs/mira' : undefined)
  );
  const remoteRequests: string[] = [];
  await page.route('**/api/{assets,package-image-blobs}/*', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#507ba8"/></svg>',
    })
  );
  await page.route('https://outside.invalid/**', (route) => {
    remoteRequests.push(route.request().url());
    return route.abort();
  });
  await page.goto(origin);
  await page.evaluate(async (text) => {
    const path = '/tests/fixtures/story-ui-images.tsx';
    (await import(path)).mountImages(document.getElementById('mount'), text);
  }, source);
  await expect(page.getByRole('img', { name: '미라', exact: true })).toHaveAttribute(
    'src',
    '/api/package-image-blobs/mira'
  );
  await expect(page.getByRole('img', { name: '미라', exact: true })).toHaveJSProperty(
    'naturalWidth',
    40
  );
  await expect(page.getByRole('img', { name: '솔', exact: true })).toHaveAttribute(
    'src',
    '/api/assets/sol'
  );
  await expect(page.getByText('끝', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: '밖의 그림' })).toHaveCount(0);
  await expect(page.getByText('밖의 그림')).toHaveCount(0);
  await expect(page.locator('svg.lucide')).toHaveCount(2);
  await expect(page.locator('svg.lucide-user-round')).toBeVisible();
  await expect(page.locator('svg.lucide-house')).toBeVisible();
  await expect(page.getByText('person', { exact: true })).toHaveCount(0);
  await page.getByLabel('첫 아이콘').fill('warning');
  await expect(page.locator('svg.lucide-triangle-alert')).toBeVisible();
  await expect(page.locator('svg.lucide-user-round')).toHaveCount(0);
  const selected = page.getByRole('img', { name: '선택한 초상화', exact: true });
  await expect(selected).toHaveCSS('object-fit', 'scale-down');
  await page.getByLabel('초상화 경로').fill('https://outside.invalid/portrait.png');
  await expect(selected).toHaveCount(0);
  await page.getByLabel('초상화 경로').fill('/api/package-image-blobs/changed');
  await expect(selected).toHaveAttribute('src', '/api/package-image-blobs/changed');
  expect(remoteRequests).toEqual([]);
  if (visualReview) await page.screenshot({ path: info.outputPath('story-ui-bound-images.png') });
});

test('reader submits its authored event through the real action route', async ({ page }) => {
  const { createApp } = await import('../server/app.js');
  const { importChatTranscript } = await import('../server/chat-transcript.js');
  const { fixtureBotInput } = await import('./fixtures/chat.js');
  const { normalizeStoryUiOutput } = await import('../server/story-ui.js');
  const { randomUUID } = await import('node:crypto');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'uimori-story-ui-browser-'));
  const app = await createApp({
    dbPath: join(directory, 'app.sqlite'),
    buildId: 'story-ui-browser',
    testMode: true,
    codex: { enabled: false },
  });
  try {
    const bot = app.store.product.content(fixtureBotInput());
    const text = normalizeStoryUiOutput(
      '문이 열린다.\n\n<a2ui>root = Column([TextField("쪽지", $/note), Button(Text("보내기"), action=Event("send", {note: $/note}))])</a2ui>\n\n복도는 조용하다.'
    );
    const imported = importChatTranscript(app.store, {
      idempotencyKey: randomUUID(),
      transcript: {
        format: 'uimori-chat-transcript',
        version: 2,
        exportedAt: new Date().toISOString(),
        title: '편지',
        packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
        notes: [],
        entries: [{ request: '문을 연다', text, translation: null }],
      },
    }).chat;
    const chat = app.store.settings(imported.id, imported.settingsRevision, {
      ...imported.settings,
      storyUi: true,
    });
    const source = app.store.source(chat.headRevision!);
    app.controls.hold('run');
    let responseStatus = 0;
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const response = await app.inject({
        method: request.method() as 'GET' | 'POST',
        url: url.pathname + url.search,
        payload: request.postData() ?? undefined,
        headers: request.postData() ? { 'content-type': 'application/json' } : undefined,
      });
      if (url.pathname.endsWith('/story-ui/actions')) responseStatus = response.statusCode;
      await route.fulfill({
        status: response.statusCode,
        body: response.body,
        contentType: 'application/json',
      });
    });
    await page.goto(origin);
    await page.evaluate(async (value) => {
      const path = '/tests/fixtures/story-ui.tsx';
      const fixture = await import(path);
      await fixture.mountReader(document.getElementById('mount'), value);
    }, source);
    await expect(page.getByText('문이 열린다.')).toBeVisible();
    await expect(page.getByText('복도는 조용하다.')).toBeVisible();
    await page.getByLabel('쪽지').fill('안녕');
    await page.getByRole('button', { name: '보내기' }).first().click();
    await page.getByRole('button', { name: '보내기' }).last().click();
    await expect.poll(() => responseStatus).toBe(200);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('charts show positive and negative values on their proper sides', async ({ page }) => {
  await page.goto(origin);
  await page.evaluate(async () => {
    const path = '/tests/fixtures/story-ui.tsx';
    (await import(path)).mountCharts(document.getElementById('mount'));
  });
  const line = page.getByRole('img', { name: '밤: -10, 낮: 20' });
  await expect(line.locator('polyline')).toHaveAttribute('points', '0,90 100,10');
  const tracks = page.locator('.story-ui-bar-track');
  const negative = await tracks
    .nth(0)
    .locator('.story-ui-bar')
    .evaluate((bar) => ({
      left: (bar as HTMLElement).style.left,
      width: (bar as HTMLElement).style.width,
    }));
  const positive = await tracks
    .nth(1)
    .locator('.story-ui-bar')
    .evaluate((bar) => ({
      left: (bar as HTMLElement).style.left,
      width: (bar as HTMLElement).style.width,
    }));
  expect(Number.parseFloat(negative.left)).toBe(0);
  expect(Number.parseFloat(negative.width)).toBeCloseTo(100 / 3);
  expect(Number.parseFloat(positive.left)).toBeCloseTo(100 / 3);
  expect(Number.parseFloat(positive.width)).toBeCloseTo(200 / 3);
});

test('completed streamed UI remains visible as subsequent prose arrives', async ({ page }) => {
  const { normalizeStoryUiOutput } = await import('../server/story-ui.js');
  const block = '<a2ui>root = Text("상태 표시")</a2ui>';
  const opening = 'Before the quiet harbor opened. '.repeat(700);
  const continuation = `${'After the fishing ship returned. '.repeat(700)}The harbor is quiet again.`;
  let requests = 0;
  await page.route('**/api/story-ui/preview', async (route) => {
    requests++;
    expect(route.request().postDataJSON()).toEqual({ text: block, runId: 'streaming-run' });
    await route.fulfill({ json: { text: normalizeStoryUiOutput(block) } });
  });
  await page.goto(origin);
  await page.evaluate(async (value) => {
    const path = '/tests/fixtures/story-ui.tsx';
    (window as any).showStream = await (await import(path)).mountStreaming(
      document.getElementById('mount'),
      value,
      'modern',
      'streaming-run'
    );
  }, `${opening}\n\n${block}`);
  await expect(page.getByText('상태 표시')).toBeVisible();
  await expect(page.locator('.story-ui')).toHaveAttribute('data-story-ui-style', 'modern');
  await page.evaluate(
    (value) => (window as any).showStream(value),
    `${opening}\n\n${block}\n\n${continuation}`
  );
  await expect(page.getByText('상태 표시')).toBeVisible();
  await expect(page.getByText('The harbor is quiet again.')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('<a2ui>');
  expect(requests).toBe(1);
});

test('switches original and translated UI when both start at the same offset', async ({ page }) => {
  const { normalizeStoryUiOutput } = await import('../server/story-ui.js');
  const { parseStoryUi, encodeStoryUi } = await import('../core/story-ui.js');
  const original = normalizeStoryUiOutput(
    '<a2ui>root = Column([Text("Original"), TextField("Draft", $/draft)])</a2ui>'
  );
  const part = parseStoryUi(original).find((item) => item.kind === 'ui');
  if (!part || part.kind !== 'ui') throw new Error('invalid fixture');
  const messages = structuredClone(part.messages);
  const message = messages[0] as any;
  message.createSurface.components.find(
    (component: { component: string }) => component.component === 'Text'
  ).text = '번역 문구';
  const translated = encodeStoryUi(part.expression, messages);
  const source = {
    id: 'translation-source',
    chatId: 'chat',
    parentRevision: null,
    runId: 'run',
    text: original,
    hash: 'hash',
  };
  const jobs = [
    {
      id: 'translation-job',
      chatId: 'chat',
      sourceRevision: source.id,
      sourceHash: source.hash,
      kind: 'translation',
      status: 'completed',
      attempt: 1,
      error: null,
      result: { mock: false, text: translated, sourceRevision: source.id, sourceHash: source.hash },
    },
  ];
  await page.goto(origin);
  await page.evaluate(
    async (values) => {
      localStorage.setItem('uimori:reading-language', 'original');
      const path = '/tests/fixtures/story-ui.tsx';
      await (await import(path)).mountReader(
        document.getElementById('mount'),
        values.source,
        values.jobs
      );
    },
    { source, jobs }
  );
  await expect(page.getByText('Original', { exact: true })).toBeVisible();
  await page.getByLabel('Draft', { exact: true }).fill('아직 보내지 않은 답장');
  await page.getByRole('button', { name: '번역 보기' }).click();
  await expect(page.getByText('번역 문구', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Draft', { exact: true })).toHaveValue('아직 보내지 않은 답장');
  await page.getByRole('button', { name: '원문 보기' }).click();
  await expect(page.getByText('Original', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Draft', { exact: true })).toHaveValue('아직 보내지 않은 답장');
});

const gallery = [
  `<a2ui>
root = Frame(page, "아르카 위키", "문서 · 은빛 서고", kind="page", accent="teal")
page = Column([
  Row([Avatar("은빛 서고", size="large"), Column([Text("은빛 서고", variant="headline"), Row([Badge("유적"), Badge("출입 제한", tone="danger"), Badge("3등급", tone="caution")])], weight=1)]),
  Text("왕도 북쪽 절벽에 자리한 **지하 서고**. 건국 이전의 기록을 보관한다고 전해진다.", variant="body"),
  KeyValue([{label: "위치", value: "왕도 북부 3구역"}, {label: "관리", value: "왕립 기록원"}, {label: "최초 발견", value: "성력 412년"}], "개요"),
  Tabs([{title: "출입 기록", child: log}, {title: "소장 자료", child: table}]),
  Details("전해지는 이야기", Text("밤마다 서가 사이에서 종이 넘기는 소리가 난다고 한다.", variant="quote"))
])
log = Timeline([{title: "1차 조사단 진입", time: "412.03", state: "done"}, {title: "하층 봉인 해제", time: "412.07", state: "failed", text: "조사단 2명 실종"}, {title: "2차 조사단 편성", state: "current"}, {title: "하층 재진입", state: "pending"}])
table = DataTable("소장 자료", ["분류", "권수", "상태"], [["연대기", "1,204", "양호"], ["마도서", "87", "봉인"], ["지도", "312", "일부 훼손"]])
</a2ui>`,
  `<a2ui>
$/_uimori/style = "modern"
root = Frame(board, "길드 재무 보고", "제3분기", accent="indigo")
board = Column([
  Grid([Stat("총수입", "48,200 G", "+12% 전 분기 대비", tone="positive"), Stat("지출", "31,750 G", tone="danger"), Stat("의뢰 완료", 37), Stat("길드원", 24, "신입 3명")], columns=4),
  Row([BarChart("부문별 수지", [{label: "토벌", value: 18400}, {label: "호위", value: 9200}, {label: "채집", value: -2100}], unit=" G"), PieChart("의뢰 유형", [{label: "토벌", value: 14}, {label: "호위", value: 9}, {label: "채집", value: 8}, {label: "조사", value: 6}], unit="건")]),
  Row([LineChart("월별 평판", [{label: "7월", value: 62}, {label: "8월", value: 58}, {label: "9월", value: 71}, {label: "10월", value: 84}]), RadarChart("길드 역량", [{label: "전투", value: 8}, {label: "정보", value: 5}, {label: "교섭", value: 6}, {label: "보급", value: 4}, {label: "마법", value: 7}], max=10)])
])
</a2ui>`,
  `<a2ui>
root = Frame(log, "relay-07", "보안 콘솔", kind="terminal")
log = Column([
  Text("[02:14:07] 외부 접속 감지 — 포트 4471\n[02:14:09] 인증 실패 (3/3)\n[02:14:10] 격리 프로토콜 가동", variant="mono"),
  Notice("제3격벽이 12초 뒤 폐쇄됩니다.", "경고", tone="caution", icon="warning"),
  Gauge("격벽 전력", 38, 0, 100, "%", tone="caution")
])
</a2ui>`,
  `<a2ui>
root = Frame(memo, "냉장고 위 메모", kind="note")
memo = Column([Text("저녁은 데워 먹어. 늦을 거야.\n\n**창문은 꼭 잠그고.**", variant="body"), Text("— 엄마", variant="caption", align="end")])
</a2ui>`,
  `<a2ui>
$/form = {name: "", route: ["north"], pace: 3, torch: true}
root = Column([
  Text("원정 계획", variant="label"),
  Text("출발 전에 정해 둘 것", variant="title"),
  TextField("원정대 이름", $/form/name, "예: 새벽의 발자국"),
  ChoicePicker("진입로", "mutuallyExclusive", [{label: "북쪽 능선", value: "north"}, {label: "지하 수로", value: "sewer"}, {label: "정문", value: "gate"}], $/form/route, "chips"),
  Slider("행군 속도", 1, 5, $/form/pace, 4),
  CheckBox("횃불을 챙긴다", $/form/torch),
  Row([Button(Text("계획 확정"), "primary", Event("confirm_plan", {name: $/form/name, route: $/form/route})), Button(Text("나중에"), "borderless", Event("postpone"))])
])
</a2ui>`,
  `<a2ui>
root = Frame(body, "제7구역 관제", "접근 제한", kind="system", accent="teal", surface="glow", ornament="corners", backdrop="/api/assets/city")
body = Column([
  Hero("제7구역", "허가 없이 들어온 자는 기록에서 지워진다", "/api/assets/city", "LOCATION", Row([Badge("봉쇄", tone="danger"), Badge("야간")]), size="large"),
  Dialogue("여기서부턴 **혼자** 가야 해. 돌아보지 마.", "레이", "/api/assets/ray", "낮은 목소리로", accent="pink"),
  Dialogue("…알았어.", "나", side="right"),
  Row([Ring("동기화", 72, 0, 100, "%", tone="info"), Ring("실드", 30, 0, 100, tone="danger"), Ring("잔여 시간", 8, 0, 60, "분", tone="caution", size="small")], justify="spaceAround"),
  Carousel([
    Card(Column([Text("EMP 수류탄", variant="title"), Text("반경 5m 전자기기 정지", variant="caption")]), surface="gradient", accent="violet"),
    Card(Column([Text("위조 출입증", variant="title"), Text("3등급 구역까지 통과", variant="caption")]), surface="tint", accent="amber"),
    Card(Column([Text("진통제", variant="title"), Text("체력 20 회복", variant="caption")]), surface="outline", accent="green"),
    Card(Column([Text("낡은 무전기", variant="title"), Text("주파수 미상", variant="caption")]), surface="glow", accent="red")
  ], itemWidth="narrow"),
  Stack([Image("/api/assets/city", variant="header"), Card(Text("CAM-04 · 신호 약함", variant="mono"), surface="glass"), Badge("LIVE", tone="danger")], align="bottomStart")
])
</a2ui>`,
  `<a2ui>
root = Frame(body, "경고", kind="panel", accent="amber", ornament="stripes", surface="tint")
body = Column([Text("격리 구역", variant="display", tone="caution", align="center"), Text("이 문 너머의 일은 보고되지 않습니다.", variant="body", align="center")])
</a2ui>`,
  `<a2ui>
root = Frame(body, "왕립 서고 열람증", kind="paper", accent="red", ornament="ribbon")
body = Row([Card(Text("제 412 호", variant="title"), surface="gradient", accent="red"), Frame(Text("열람 기한: 성력 413년 봄", variant="body"), ornament="inset", surface="outline", accent="indigo", weight=1)])
</a2ui>`,
  `<a2ui>
root = Frame(body, "하츠보시 프로덕션", "프로듀서 수첩", kind="page", accent="pink")
body = Column([
  Profile("하나미 사키", "1학년 · 보컬 담당", "/api/assets/ray", "무대에 서면 **표정이 달라지는** 연습 벌레.", [{label: "나이", value: "15"}, {label: "키", value: "152cm"}, {label: "특기", value: "고음"}, {label: "컨디션", value: "양호"}], Row([Badge("센터 후보", tone="accent"), Badge("체력 주의", tone="caution")])),
  Schedule(["월", "화", "수", "목", "금"], [{day: 0, title: "보컬 레슨", time: "16:00", tone: "info"}, {day: 1, title: "댄스 레슨", time: "16:00"}, {day: 1, title: "잡지 촬영", time: "19:00", text: "스튜디오 B", tone: "accent"}, {day: 3, title: "중간 심사", time: "17:30", tone: "danger"}, {day: 4, title: "휴식", tone: "positive"}], "이번 주 일정", current=1),
  Row([Rank("A+", "중간 심사", "센터 자격 충분", stars=4.5, tone="accent"), Rank("S", "보컬", stars=5, tone="positive"), Rank("C", "체력", "보강 필요", stars=2, tone="caution")]),
])
</a2ui>`,
  `<a2ui>
root = Frame(body, "하츠보시 프로덕션", "레슨 기록", kind="page", accent="pink")
body = Column([
  Compare([{label: "사키", value: 152, text: "보컬"}, {label: "프로듀서", value: 178}, {label: "무대 세트", value: 620, text: "메인 타워"}], "키 비교", "cm"),
  Compare([{label: "보컬", value: 86}, {label: "댄스", value: 54}, {label: "비주얼", value: 71}], "이번 주 성장", shape="bar"),
  Divider(),
  Grid([Slot("응원봉", value=12, rarity="common", icon="star"), Slot("무대 의상", rarity="epic", state="equipped", image="/api/assets/city"), Slot("행운의 부적", value="Lv.3", rarity="legendary"), Slot("비타민", value=3, rarity="uncommon"), Slot("비밀 악보", rarity="rare", state="locked"), Slot("빈 칸", state="empty")], columns=4),
  Route([{title: "기숙사", time: "07:30", state: "done"}, {title: "학원", time: "08:10", state: "done"}, {title: "레슨실", state: "current", text: "보컬 레슨 중"}, {title: "스튜디오 B", time: "19:00", state: "pending"}, {title: "기숙사", state: "pending"}], "오늘의 동선")
])
</a2ui>`,
  `<a2ui>
root = Frame(body, "전투", "3턴 · 폐허의 예배당", kind="system", accent="red")
body = Column([
  Row([
    Column([
      Combatant("아리엘", [{label: "HP", value: 412, max: 520}, {label: "MP", value: 86, max: 140}], "Lv.24 성기사", "/api/assets/ray", [{label: "수호", tone: "info"}], state="active"),
      Combatant("테오", [{label: "HP", value: 141, max: 380}, {label: "MP", value: 12, max: 90}], "Lv.22 도적", effects=[{label: "중독", tone: "danger"}, {label: "가속", tone: "positive"}]),
      Combatant("미라", [{label: "HP", value: 0, max: 260}, {label: "MP", value: 190, max: 310}], "Lv.23 마법사", state="down")
    ], weight=1),
    Column([
      Combatant("타락한 사제", [{label: "HP", value: 2380, max: 6000}, {label: "분노", value: 70, max: 100, tone: "caution"}], "보스", side="enemy", effects=[{label: "광폭화", tone: "danger"}]),
      Combatant("망령", [{label: "HP", value: 90, max: 600}], side="enemy", state="guard")
    ], weight=1)
  ]),
  Row([Button(Text("공격"), "primary", Event("attack")), Button(Text("스킬"), action=Event("skill")), Button(Text("방어"), action=Event("guard")), Button(Text("도주 (판정)"), "borderless", Event("roll", {sides: 20, count: 1}))])
])
</a2ui>`,
  `<a2ui>
root = Frame(chart, "2학년 3반 관계도", "문화제 2주 전", kind="note", accent="pink")
chart = Graph([
  {id: "me", label: "나", text: "전학생", state: "current"},
  {id: "yun", label: "한서윤", text: "소꿉친구 · 반장", image: "/api/assets/ray", tone: "accent"},
  {id: "jae", label: "윤재희", text: "밴드부 보컬"},
  {id: "do", label: "강도현", text: "학생회장", tone: "info"},
  {id: "min", label: "서민아", text: "도서부"},
  {id: "x", label: "익명 편지", state: "unknown"}
], [
  {from: "yun", to: "me", label: "짝사랑", tone: "danger"},
  {from: "me", to: "yun", label: "소꿉친구"},
  {from: "jae", to: "me", label: "관심"},
  {from: "do", to: "yun", label: "라이벌", arrow: "both", tone: "caution"},
  {from: "min", to: "jae", label: "동경", line: "dashed"},
  {from: "x", to: "me", label: "매일 아침", line: "dashed"}
], center="me")
</a2ui>`,
  `<a2ui>
root = Frame(body, "작전 상황판", "제3구역 · 야간 침투", kind="system", accent="green")
body = Column([
  Map(8, 6, [
    {x: 0, y: 0, w: 3, h: 2, label: "격납고"},
    {x: 3, y: 0, w: 1, h: 4, terrain: "wall"},
    {x: 5, y: 3, w: 3, h: 3, label: "미탐색", terrain: "hidden"},
    {x: 0, y: 4, w: 3, h: 2, label: "배수로", terrain: "water"},
    {x: 4, y: 0, w: 4, h: 2, label: "관제탑", tone: "danger"}
  ], [
    {x: 1, y: 1, label: "알파 1", mark: "A1", tone: "info", state: "current", text: "돌입 대기"},
    {x: 2, y: 1, label: "알파 2", mark: "A2", tone: "info"},
    {x: 1, y: 3, label: "저격조", icon: "visibility", tone: "positive"},
    {x: 5, y: 1, label: "경비병", mark: "적", tone: "danger"},
    {x: 6, y: 1, label: "경비병", mark: "적", tone: "danger"},
    {x: 4, y: 2, label: "정찰 드론", mark: "D", state: "down", text: "격추"}
  ], "침투 경로", coords=true),
  Graph([
    {id: "base", label: "기초 사격"},
    {id: "burst", label: "점사", text: "Lv.2"},
    {id: "cover", label: "엄폐 사격", text: "Lv.1", state: "current"},
    {id: "snipe", label: "원거리 저격", state: "locked"},
    {id: "suppress", label: "제압 사격", state: "locked"}
  ], [
    {from: "base", to: "burst"},
    {from: "base", to: "cover"},
    {from: "burst", to: "snipe"},
    {from: "cover", to: "suppress"},
    {from: "burst", to: "suppress", line: "dashed"}
  ], "사격 기술", layout="tree")
])
</a2ui>`,
  `<a2ui>
root = Frame(body, "하츠보시 프로덕션", "사키의 12월", kind="page", accent="pink")
body = Calendar("2026년 12월", [
  {date: 3, title: "보컬 레슨", time: "16:00", tone: "info"},
  {date: 10, title: "보컬 레슨", tone: "info"},
  {date: 12, title: "잡지 촬영", time: "13:00", text: "스튜디오 B", tone: "accent"},
  {date: 19, title: "중간 심사", time: "17:30", tone: "danger"},
  {date: 24, title: "크리스마스 공연", time: "19:00", text: "시민회관 대극장 · 첫 센터", tone: "accent"},
  {date: 24, title: "팬 사인회"},
  {date: 31, title: "휴가", tone: "positive"}
], month="2026-12", current=19)
</a2ui>`,
  `<a2ui>
$/_uimori/css = r"""
& { --story-paper: #0a0714; --story-surface: #1a1230; --story-ink: #f3e9ff; --story-muted: #b7a6d9; --story-border: #4b2f7a; --story-accent: #ff3df2; --story-accent-ink: #14041a; --story-accent-text: #ff7df7; --story-radius: 2px; color-scheme: dark; background: radial-gradient(120% 90% at 50% 0%, #2a0f4d, #0a0714 70%); border-color: #ff3df2; }
.look-marquee { background: linear-gradient(90deg, #ff3df2, #3df2ff, #ff3df2); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: slide 4s linear infinite; text-shadow: none; }
.look-scan { position: relative; clip-path: polygon(0 0, calc(100% - 1em) 0, 100% 1em, 100% 100%, 1em 100%, 0 calc(100% - 1em)); border: 1px solid #3df2ff !important; background-image: url("https://outside.invalid/track.png"); }
.look-scan::after { content: ""; position: absolute; inset: 0; background: repeating-linear-gradient(0deg, #ffffff10 0 1px, transparent 1px 4px); pointer-events: none; }
.story-ui-button { text-transform: uppercase; letter-spacing: .12em; border-color: #3df2ff; box-shadow: 0 0 10px #3df2ff66; }
.look-escape { position: fixed; inset: -200px; opacity: 0; pointer-events: none; }
@keyframes slide { to { background-position: 200% 0; } }
@font-face { font-family: Evil; src: url("https://outside.invalid/font.woff2"); }
@import url("https://outside.invalid/sheet.css");
"""
root = Column([
  Text("NEON ARCADE", variant="display", align="center", look="marquee"),
  Card(Column([Text("INSERT COIN", variant="label"), Text("최고 점수 1,204,800 — 플레이어 REI", variant="mono")]), look="scan"),
  Row([Button(Text("게임 시작"), "primary", Event("start_game")), Button(Text("랭킹 보기"), action=Event("show_ranking"))]),
  Column([], look="escape")
])
</a2ui>`,
  `<a2ui>
root = Calendar("휴가 계획", [{date: 1, title: "출발"}, {date: 2, title: "해변"}, {date: 4, title: "귀가"}], length=5)
</a2ui>`,
];

const labelOverlaps = (graph: Locator) =>
  graph.evaluate((figure) => {
    const boxes = [
      ...figure.querySelectorAll('.story-ui-graph-relation, .story-ui-graph-caption'),
    ].map((element) => ({ text: element.textContent, box: element.getBoundingClientRect() }));
    return boxes.flatMap((a, index) =>
      boxes
        .slice(index + 1)
        .filter(
          (b) =>
            a.box.left < b.box.right - 1 &&
            b.box.left < a.box.right - 1 &&
            a.box.top < b.box.bottom - 1 &&
            b.box.top < a.box.bottom - 1
        )
        .map((b) => `${a.text} / ${b.text}`)
    );
  });

test('composed media render with their own shells in both schemes', async ({ page }, info) => {
  const { normalizeStoryUiOutput, storyUiPrompt } = await import('../server/story-ui.js');
  const { parseStoryUi } = await import('../core/story-ui.js');
  const prompt = storyUiPrompt();
  const taught = parseStoryUi(normalizeStoryUiOutput(prompt.slice(prompt.indexOf('## Examples'))))
    .filter((part) => part.kind === 'ui')
    .map((part) => normalizeStoryUiOutput(part.expression));
  const sources = [...taught, ...gallery.map((entry) => normalizeStoryUiOutput(entry))];
  const remoteRequests: string[] = [];
  await page.route('**/api/assets/*', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d3557"/><stop offset=".55" stop-color="#7b2cbf"/><stop offset="1" stop-color="#ff6b6b"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><circle cx="470" cy="110" r="60" fill="#ffd166" opacity=".85"/></svg>',
    })
  );
  await page.route('https://outside.invalid/**', (route) => {
    remoteRequests.push(route.request().url());
    return route.abort();
  });
  await page.setViewportSize({ width: 960, height: 900 });
  await page.goto(origin);
  await page.evaluate(async (value) => {
    const path = '/tests/fixtures/story-ui.tsx';
    await (await import(path)).mountGallery(document.getElementById('mount'), value);
  }, sources);
  const blocks = page.locator('.story-ui');
  await expect(blocks).toHaveCount(sources.length);
  await expect(page.locator('.story-ui > [role="status"]')).toHaveCount(0);
  await expect(blocks.first()).toHaveAttribute('data-story-ui-kind', 'app');
  const theirs = await page.getByText('어디야', { exact: true }).boundingBox();
  const mine = await page.getByText('집 앞인데 왜', { exact: true }).boundingBox();
  expect(mine!.x + mine!.width).toBeGreaterThan(theirs!.x + theirs!.width);
  await expect(page.getByRole('meter', { name: '체력' })).toHaveAttribute('aria-valuenow', '64');
  await page.getByRole('tab', { name: '소장 자료' }).click();
  await expect(page.getByRole('cell', { name: '1,204' })).toBeVisible();
  await page.getByRole('button', { name: '지하 수로' }).click();
  await expect(page.getByRole('button', { name: '지하 수로' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.getByRole('meter', { name: '동기화' })).toHaveAttribute('aria-valuenow', '72');
  await expect(page.getByRole('img', { name: '레이', exact: true })).toHaveAttribute(
    'src',
    '/api/assets/ray'
  );
  const overlay = await page.getByText('CAM-04 · 신호 약함').boundingBox();
  const base = await page.locator('.story-ui-stack img').boundingBox();
  expect(overlay!.y).toBeGreaterThan(base!.y);
  expect(overlay!.y + overlay!.height).toBeLessThanOrEqual(base!.y + base!.height);
  const figures = page.locator('.story-ui-compare[data-shape="figure"] svg');
  const small = await figures.nth(0).boundingBox();
  const tall = await figures.nth(2).boundingBox();
  expect(tall!.height / small!.height).toBeCloseTo(620 / 152, 1);
  expect(small!.y + small!.height).toBeCloseTo(tall!.y + tall!.height, 0);
  await expect(page.getByRole('img', { name: '4.5 / 5' })).toBeVisible();
  await expect(page.locator('.story-ui-schedule-days > section[data-current] > h5')).toHaveText(
    '화'
  );
  await expect(page.locator('.story-ui-slot[data-state="equipped"]')).toContainText('장착');
  const bar = (name: string) => page.getByRole('meter', { name, exact: true }).locator('xpath=..');
  await expect(bar('아리엘 HP')).toHaveAttribute('data-tone', 'positive');
  await expect(bar('테오 HP')).toHaveAttribute('data-tone', 'caution');
  await expect(bar('망령 HP')).toHaveAttribute('data-tone', 'danger');
  await expect(bar('테오 MP')).toHaveAttribute('data-tone', 'info');
  await expect(bar('타락한 사제 분노')).toHaveAttribute('data-tone', 'caution');
  await expect(page.locator('.story-ui-combatant[data-state="down"]')).toContainText('전투 불능');
  const ring = page.locator('.story-ui-graph[data-layout="ring"]');
  const canvas = (await ring.locator('.story-ui-graph-canvas').boundingBox())!;
  const me = (await ring
    .locator('.story-ui-graph-node[data-state="current"] .story-ui-avatar')
    .boundingBox())!;
  expect(me.x + me.width / 2).toBeCloseTo(canvas.x + canvas.width / 2, 0);
  await expect(ring.locator('.story-ui-graph-edge')).toHaveCount(6);
  await expect(
    ring.locator('.story-ui-graph-node[data-state="unknown"] .story-ui-avatar')
  ).toHaveText('?');
  await expect(ring.locator('.story-ui-graph-node').nth(1).locator('img')).toBeVisible();
  await expect(ring.locator('.sr-only')).toContainText('한서윤 → 나: 짝사랑');
  expect(await labelOverlaps(ring)).toEqual([]);
  const tree = page.locator('.story-ui-graph[data-layout="tree"]');
  const top = (name: string) =>
    tree
      .locator('.story-ui-graph-node', { hasText: name })
      .boundingBox()
      .then((box) => box!.y);
  expect(await top('점사')).toBeGreaterThan(await top('기초 사격'));
  expect(await top('원거리 저격')).toBeGreaterThan(await top('점사'));
  const board = page.locator('.story-ui-map-board');
  const ground = (await board.locator('.story-ui-map-ground').boundingBox())!;
  expect(ground.width / ground.height).toBeCloseTo(8 / 6, 1);
  const hangar = (await board.locator('.story-ui-map-area', { hasText: '격납고' }).boundingBox())!;
  expect(hangar.width / ground.width).toBeCloseTo(3 / 8, 1);
  const alpha = (await board.locator('.story-ui-map-token', { hasText: 'A1' }).boundingBox())!;
  expect(alpha.x + alpha.width / 2).toBeCloseTo(ground.x + (ground.width * 1.5) / 8, -1);
  await expect(page.locator('.story-ui-map-legend')).toContainText('A1');
  await expect(page.locator('.story-ui-map-legend-at').first()).toHaveText('B2');
  const calendar = page.locator('.story-ui-calendar', { hasText: '2026년 12월' });
  await expect(calendar.locator('.story-ui-calendar-grid > .story-ui-calendar-blank')).toHaveCount(
    2 + 2
  );
  await expect(calendar.locator('.story-ui-calendar-date')).toHaveCount(31);
  await expect(calendar.locator('.story-ui-calendar-date[data-current]')).toContainText('19');
  await expect(calendar.locator('.story-ui-calendar-date').nth(23).locator('li')).toHaveCount(2);
  await expect(calendar.locator('.story-ui-calendar-date').nth(5)).toHaveAttribute(
    'data-weekend',
    'sunday'
  );
  const brief = page.locator('.story-ui-calendar', { hasText: '휴가 계획' });
  await expect(brief.locator('.story-ui-calendar-agenda')).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(brief.locator('.story-ui-calendar-agenda')).toHaveCSS('display', 'grid');
  await page.setViewportSize({ width: 960, height: 900 });
  const authored = page.locator('.story-ui[data-story-ui-authored]');
  await expect(authored).toHaveCount(1);
  await expect(authored).toHaveCSS('color', 'rgb(243, 233, 255)');
  await expect(blocks.first()).not.toHaveCSS('color', 'rgb(243, 233, 255)');
  const marquee = authored.locator('.look-marquee');
  await expect(marquee).toHaveText('NEON ARCADE');
  expect(await marquee.evaluate((node) => getComputedStyle(node).animationName)).toMatch(
    /^story-ui-.+-slide$/
  );
  const sheet = await authored.locator('style').textContent();
  expect(sheet).not.toMatch(/outside\.invalid|important|@font-face|@import/);
  await expect(authored.locator('.look-scan')).toHaveCSS('background-image', 'none');
  await expect(page.locator('.story-ui-block[data-authored]')).toHaveCSS('overflow-x', 'clip');
  const escaped = await authored.locator('.look-escape').boundingBox();
  const host = await page.locator('.story-ui-block[data-authored]').boundingBox();
  expect(escaped!.width).toBeLessThanOrEqual(host!.width + 400);
  expect(escaped!.x).toBeGreaterThanOrEqual(host!.x - 200);
  expect(remoteRequests).toEqual([]);
  if (!visualReview) return;
  test.setTimeout(180_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const capture = async (name: string) => {
    for (let index = 0; index < sources.length; index++)
      await blocks
        .nth(index)
        .screenshot({ path: info.outputPath(`story-ui-gallery-${name}-${index}.png`) });
  };
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await capture(theme);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await capture('mobile');
  await page.setViewportSize({ width: 960, height: 900 });
  const first = taught.length;
  const sample = [
    sources[0],
    sources[2],
    sources[4],
    sources[first + 4],
    sources[first + 5],
    sources[first + 8],
    sources[first + 9],
    sources[first + 10],
    sources[first + 11],
    sources[first + 12],
    sources[first + 13],
    sources[first],
  ];
  const { storyUiStyles } = await import('../core/story-ui-style.js');
  for (const style of storyUiStyles.filter((name) => name !== 'default')) {
    await page.evaluate(
      async ([value, name]) => {
        const path = '/tests/fixtures/story-ui.tsx';
        document.getElementById('preset')?.remove();
        const host = document.body.appendChild(document.createElement('div'));
        host.id = 'preset';
        await (await import(path)).mountGallery(host, value, name);
      },
      [sample, style] as const
    );
    const preset = page.locator('#preset');
    await expect(preset.locator('.story-ui')).toHaveCount(sample.length);
    expect(
      await labelOverlaps(preset.locator('.story-ui-graph[data-layout="ring"]')),
      style
    ).toEqual([]);
    await expect(
      preset.locator('.story-ui-map-board .story-ui-map-token[data-state="down"]'),
      style
    ).toHaveCSS('border-top-style', 'dashed');
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      for (let index = 0; index < sample.length; index++)
        await preset
          .locator('.story-ui')
          .nth(index)
          .screenshot({ path: info.outputPath(`story-ui-preset-${style}-${theme}-${index}.png`) });
    }
  }
});
