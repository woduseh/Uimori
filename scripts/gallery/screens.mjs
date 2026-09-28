import browserWidths from '../../fixtures/browser-viewports.json' with { type: 'json' };
const { mobile: MOBILE_WIDTH, desktop: DESKTOP_WIDTH } = browserWidths;
// One entry per screen or modal the gallery captures. `url` values starting with `$` are
// replaced from the seed result (see seed.mjs). Entry steps open the screen, then readiness
// is checked; regular steps run afterward. The step vocabulary is documented in steps.mjs;
// measurements are documented in docs/UI-GALLERY.md#metrics.

export const viewports = {
  mobile: { width: MOBILE_WIDTH, height: 844, isMobile: true, hasTouch: true },
  desktop: { width: DESKTOP_WIDTH, height: 900, isMobile: false, hasTouch: false },
};
export const themes = ['light', 'dark'];
export const defaultMetrics = ['overflow', 'touch-44', 'min-font'];

const chat = { chat: '$chat.main' };
const inMenu = { css: 'details[open] .action-menu-body' };
const inHeader = { css: 'header.workspace-header' };
const drawer = { role: 'dialog', name: '탐색' };
const appDialog = { role: 'dialog', name: '설정' };
const chatDialog = { role: 'dialog', name: '채팅 설정' };
const libraryTabs = { role: 'tablist', name: '서재 분류' };
const openLibrary = [
  { click: { label: '탐색 메뉴' }, when: 'compact' },
  { click: { role: 'button', name: '서재', within: drawer }, when: 'compact' },
  { click: { role: 'button', name: '서재', within: { testid: 'bot-navigation' } }, when: 'wide' },
];
const openPrompts = [
  { click: { label: '탐색 메뉴' }, when: 'compact' },
  { click: { role: 'button', name: '프롬프트', within: drawer }, when: 'compact' },
  {
    click: { role: 'button', name: '프롬프트', within: { testid: 'bot-navigation' } },
    when: 'wide',
  },
];
const appLabels = {
  general: '일반',
  themes: '테마·색상',
  models: '역할별 모델',
  prompts: '현재 프롬프트',
  connections: '프로바이더·모델',
  agents: 'Codex 연결',
  illustrations: '삽화',
  data: '데이터 관리',
  security: '접근 보안',
};
const chatLabels = {
  characters: '대화 구성',
  prompts: '프롬프트·모델',
  models: '프롬프트·모델',
  story: '기억·로어',
  images: '이미지',
  runtime: '자동 작업',
};

const chatSettings = (section, title) => ({
  id: `chat-settings-${section}`,
  title: `채팅 설정 · ${title}`,
  url: chat,
  enter: [
    { menu: 'chat', when: 'compact' },
    { click: { role: 'button', name: '채팅 설정', within: inMenu }, when: 'compact' },
    { click: { label: '채팅 설정' }, when: 'wide' },
    { click: { role: 'button', name: chatLabels[section], within: chatDialog }, when: 'compact' },
    { click: { role: 'tab', name: chatLabels[section], within: chatDialog }, when: 'wide' },
  ],
  ready: { role: 'dialog', name: '채팅 설정' },
});
const appSettings = (section, title) => ({
  id: `settings-${section}`,
  title: `설정 · ${title}`,
  url: {},
  enter: [
    { click: { label: '탐색 메뉴' }, when: 'compact' },
    { click: { role: 'button', name: '설정', within: drawer }, when: 'compact' },
    { click: { role: 'button', name: '설정', within: { testid: 'bot-navigation' } }, when: 'wide' },
    { click: { role: 'button', name: appLabels[section], within: appDialog }, when: 'compact' },
    { click: { role: 'tab', name: appLabels[section], within: appDialog }, when: 'wide' },
  ],
  ready: { role: 'dialog', name: '설정' },
});
const library = (tab, title) => ({
  id: `library-${tab}`,
  title: `서재 · ${title}`,
  url: {},
  enter: [...openLibrary, { click: { role: 'tab', name: title, within: libraryTabs } }],
  ready: { testid: 'library-panel' },
});

export const screens = [
  {
    id: 'chat-reader',
    title: '채팅 리더 (장면 3개)',
    url: chat,
    ready: { testid: 'source-text' },
    metrics: ['header-controls', 'composer-dock', 'body-share', ...defaultMetrics],
  },
  {
    id: 'chat-empty',
    title: '빈 채팅',
    url: { chat: '$chat.empty' },
    metrics: ['header-controls', 'composer-dock', ...defaultMetrics],
  },
  {
    id: 'chat-failed',
    title: '실패한 요청 카드',
    url: { chat: '$chat.failed' },
    metrics: ['header-controls', 'composer-dock', ...defaultMetrics],
  },
  {
    id: 'chat-scene-menu',
    title: '장면 ⋯ 메뉴',
    url: chat,
    ready: { testid: 'source-text' },
    steps: [{ menu: 'scene', which: 'last' }],
    metrics: ['menu-in-viewport', ...defaultMetrics],
  },
  {
    id: 'chat-menu',
    title: '채팅 ⋯ 메뉴',
    url: chat,
    ready: { testid: 'source-text' },
    steps: [{ menu: 'chat' }],
    metrics: ['menu-in-viewport', ...defaultMetrics],
  },
  {
    id: 'chat-earlier-scene',
    title: '이전 장면 링크로 읽기',
    url: { ...chat, source: '$source.first' },
    ready: { testid: 'source-text' },
    metrics: ['header-controls', 'composer-dock', 'body-share', ...defaultMetrics],
  },
  {
    id: 'chat-request-actions',
    title: '이전 요청 탭 → 요청 편집 표시',
    url: chat,
    ready: { testid: 'source-text' },
    steps: [
      { click: { testid: 'source-request' } },
      { visible: { role: 'button', name: '요청 편집' } },
    ],
    viewports: ['mobile'],
  },
  {
    id: 'chat-helper',
    title: '도우미 패널',
    url: chat,
    ready: { testid: 'source-text' },
    steps: [
      { menu: 'chat', when: 'compact' },
      { click: { role: 'button', name: '도우미 열기', within: inMenu }, when: 'compact' },
      { click: { role: 'button', name: '도우미 열기', within: inHeader }, when: 'wide' },
      { visible: { css: '#helper-panel' } },
    ],
  },
  {
    id: 'composer-more',
    title: '입력창 더보기',
    url: chat,
    ready: { testid: 'source-text' },
    steps: [
      { click: { label: '입력창 더보기' } },
      { visible: { role: 'group', name: '이번 요청 옵션' } },
    ],
  },
  chatSettings('characters', '봇·페르소나·모듈'),
  chatSettings('prompts', '프롬프트·창작 프리셋'),
  chatSettings('models', '이 채팅의 모델'),
  chatSettings('story', '상태와 기억'),
  chatSettings('images', '이미지'),
  chatSettings('runtime', '자동 후속 작업'),
  {
    id: 'new-chat',
    title: '새 채팅',
    url: {},
    enter: [...openLibrary, { click: { role: 'button', name: '$bot.main.title 새 채팅' } }],
    ready: { role: 'dialog', name: '새 채팅' },
  },
  {
    id: 'tasks',
    title: '작업 현황',
    url: chat,
    enter: [{ menu: 'chat' }, { click: { role: 'button', name: '작업 현황', within: inMenu } }],
    ready: { role: 'dialog', name: '작업 현황' },
  },
  {
    id: 'reading-settings',
    title: '읽기 설정',
    url: chat,
    enter: [{ menu: 'chat' }, { click: { role: 'button', name: '읽기 설정', within: inMenu } }],
    ready: { role: 'dialog', name: '읽기 설정' },
  },
  {
    id: 'outline',
    title: '계층형 구성',
    url: chat,
    enter: [{ menu: 'chat' }, { click: { role: 'button', name: '계층형 구성', within: inMenu } }],
    ready: { css: 'section.outline-panel' },
  },
  {
    id: 'navigation-drawer',
    title: '모바일 탐색 드로어',
    url: chat,
    enter: [{ click: { label: '탐색 메뉴' } }],
    ready: { role: 'dialog', name: '탐색' },
    viewports: ['mobile'],
  },
  {
    id: 'navigation-chat-menu',
    title: '모바일 탐색 드로어 · 채팅 행 ⋯',
    url: chat,
    enter: [{ click: { label: '탐색 메뉴' } }],
    ready: { role: 'dialog', name: '탐색' },
    steps: [{ menu: '$chat.main.title 채팅 메뉴' }],
    viewports: ['mobile'],
    metrics: ['menu-in-viewport', ...defaultMetrics],
  },
  {
    id: 'sidebar-chat-menu',
    title: '사이드바 · 채팅 행 ⋯',
    url: chat,
    ready: { testid: 'source-text' },
    steps: [{ menu: '$chat.main.title 채팅 메뉴' }],
    viewports: ['desktop'],
    metrics: ['menu-in-viewport', ...defaultMetrics],
  },
  library('bot', '봇'),
  library('persona', '페르소나'),
  library('module', '모듈'),
  {
    id: 'library-prompts',
    title: '서재 · 프롬프트',
    url: {},
    enter: openPrompts,
    ready: { testid: 'prompt-library' },
  },
  {
    id: 'library-detail',
    title: '서재 · 자료 상세',
    url: {},
    enter: openLibrary,
    ready: { testid: 'library-panel' },
    steps: [{ click: { role: 'button', name: '$bot.long.title 상세 보기' } }],
  },
  {
    id: 'library-item-menu',
    title: '서재 · 자료 행 ⋯',
    url: {},
    enter: openLibrary,
    ready: { testid: 'library-panel' },
    steps: [{ menu: '$bot.main.title 메뉴' }],
    metrics: ['menu-in-viewport', ...defaultMetrics],
  },
  appSettings('general', '일반'),
  appSettings('models', '역할별 모델'),
  appSettings('prompts', '현재 프롬프트'),
  appSettings('connections', '프로바이더·모델'),
  appSettings('agents', '에이전트'),
  appSettings('illustrations', '삽화'),
  appSettings('data', '데이터 관리'),
  appSettings('security', '접근 보안'),
];
