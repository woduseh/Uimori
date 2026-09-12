import browserWidths from '../../fixtures/browser-viewports.json' with { type: 'json' };
const { mobile: MOBILE_WIDTH, desktop: DESKTOP_WIDTH } = browserWidths;
// One entry per screen or modal the gallery captures. `url` values starting with `$` are
// replaced from the seed result (see seed.mjs). Steps run after the page is ready; the step
// vocabulary is documented in steps.mjs. `principles` are identifiers from
// docs/UI-PRINCIPLES-AI-PRODUCTS.md.

export const viewports = {
  mobile: { width: MOBILE_WIDTH, height: 844, isMobile: true, hasTouch: true },
  desktop: { width: DESKTOP_WIDTH, height: 900, isMobile: false, hasTouch: false },
};
export const themes = ['light', 'dark'];
export const defaultMetrics = ['overflow', 'touch-44', 'min-font'];

const chat = { chat: '$chat.main' };
const inMenu = { css: 'details[open] .action-menu-body' };
const inHeader = { css: 'header.workspace-header' };

const chatSettings = (section, title, principles) => ({
  id: `chat-settings-${section}`,
  title: `채팅 설정 · ${title}`,
  principles,
  url: { ...chat, panel: 'story', section },
  ready: { role: 'dialog', name: '채팅 설정' },
});
const appSettings = (section, title, principles) => ({
  id: `settings-${section}`,
  title: `설정 · ${title}`,
  principles,
  url: { panel: 'settings', section },
  ready: { role: 'dialog', name: '설정' },
});
const library = (tab, title) => ({
  id: `library-${tab}`,
  title: `서재 · ${title}`,
  principles: ['P3', 'P4'],
  url: { destination: 'library', tab },
  ready: { testid: 'library-panel' },
});

export const screens = [
  {
    id: 'chat-reader',
    title: '채팅 리더 (장면 3개)',
    principles: ['P1', 'P3', 'F2', 'F3', 'F7'],
    url: chat,
    ready: { testid: 'source-text' },
    metrics: ['header-controls', 'composer-dock', 'body-share', ...defaultMetrics],
  },
  {
    id: 'chat-empty',
    title: '빈 채팅',
    principles: ['P1', 'F2'],
    url: { chat: '$chat.empty' },
    metrics: ['header-controls', 'composer-dock', ...defaultMetrics],
  },
  {
    id: 'chat-failed',
    title: '실패한 요청 카드',
    principles: ['P8'],
    url: { chat: '$chat.failed' },
    metrics: ['header-controls', 'composer-dock', ...defaultMetrics],
  },
  {
    id: 'chat-scene-menu',
    title: '장면 ⋯ 메뉴',
    principles: ['P1', 'F1'],
    url: chat,
    ready: { testid: 'source-text' },
    steps: [{ menu: 'scene', which: 'last' }],
    metrics: ['menu-in-viewport', ...defaultMetrics],
  },
  {
    id: 'chat-menu',
    title: '채팅 ⋯ 메뉴',
    principles: ['P1', 'F2', 'F6'],
    url: chat,
    ready: { testid: 'source-text' },
    steps: [{ menu: 'chat' }],
    metrics: ['menu-in-viewport', ...defaultMetrics],
  },
  {
    id: 'chat-earlier-scene',
    title: '이전 장면 읽기 (최신 장면으로 버튼)',
    principles: ['P1', 'P11', 'F7'],
    url: { ...chat, source: '$source.first' },
    ready: { role: 'button', name: '최신 장면으로' },
    metrics: ['header-controls', 'composer-dock', 'body-share', ...defaultMetrics],
  },
  {
    id: 'chat-request-actions',
    title: '이전 요청 탭 → 요청 편집 표시',
    principles: ['P3', 'F3'],
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
    principles: ['P1', 'F2'],
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
    principles: ['P2'],
    url: chat,
    ready: { testid: 'source-text' },
    steps: [
      { click: { label: '입력창 더보기' } },
      { visible: { role: 'group', name: '이번 요청 옵션' } },
    ],
  },
  chatSettings('characters', '봇·페르소나·모듈', ['P4', 'F8']),
  chatSettings('prompts', '프롬프트·창작 프리셋', ['P4', 'F8']),
  chatSettings('models', '이 채팅의 모델', ['P7', 'F5', 'F8']),
  chatSettings('story', '상태와 기억', ['F8']),
  chatSettings('images', '이미지', ['F8']),
  chatSettings('runtime', '자동 후속 작업', ['F8']),
  {
    id: 'new-chat',
    title: '새 채팅',
    principles: ['P4'],
    url: { panel: 'new' },
    ready: { role: 'dialog', name: '새 채팅' },
  },
  {
    id: 'tasks',
    title: '작업 현황',
    principles: ['P8'],
    url: { ...chat, panel: 'tasks' },
    ready: { role: 'dialog', name: '작업 현황' },
  },
  {
    id: 'branches',
    title: '보관된 전개',
    principles: ['P7', 'F6'],
    url: { ...chat, panel: 'branches' },
    ready: { role: 'dialog', name: '보관된 전개' },
  },
  {
    id: 'reading-settings',
    title: '읽기 설정',
    principles: ['P4'],
    url: { ...chat, panel: 'reading' },
    ready: { role: 'dialog', name: '읽기 설정' },
  },
  {
    id: 'outline',
    title: '계층형 구성',
    principles: ['P4'],
    url: { ...chat, panel: 'outline' },
    ready: { role: 'dialog', name: '계층형 구성' },
  },
  {
    id: 'navigation-drawer',
    title: '모바일 탐색 드로어',
    principles: ['P3', 'P4', 'F4'],
    url: { ...chat, panel: 'navigation' },
    ready: { role: 'dialog', name: '탐색' },
    viewports: ['mobile'],
  },
  {
    id: 'navigation-chat-menu',
    title: '모바일 탐색 드로어 · 채팅 행 ⋯',
    principles: ['P3', 'P4', 'F4'],
    url: { ...chat, panel: 'navigation' },
    ready: { role: 'dialog', name: '탐색' },
    steps: [{ menu: '$chat.main.title 채팅 메뉴' }],
    viewports: ['mobile'],
    metrics: ['menu-in-viewport', ...defaultMetrics],
  },
  {
    id: 'sidebar-chat-menu',
    title: '사이드바 · 채팅 행 ⋯',
    principles: ['P3', 'P4', 'F4'],
    url: chat,
    ready: { testid: 'source-text' },
    steps: [{ menu: '$chat.main.title 채팅 메뉴' }],
    viewports: ['desktop'],
    metrics: ['menu-in-viewport', ...defaultMetrics],
  },
  {
    id: 'sidebar-app-menu',
    title: '사이드바 앱 메뉴',
    principles: ['P4', 'F4'],
    url: chat,
    ready: { testid: 'source-text' },
    steps: [{ menu: 'app' }],
    viewports: ['desktop'],
    metrics: ['menu-in-viewport', ...defaultMetrics],
  },
  library('bot', '봇'),
  library('persona', '페르소나'),
  library('module', '모듈'),
  { ...library('prompts', '프롬프트'), ready: { testid: 'prompt-library' } },
  {
    id: 'library-detail',
    title: '서재 · 자료 상세',
    principles: ['P3', 'P4'],
    url: { destination: 'library', tab: 'bot' },
    ready: { testid: 'library-panel' },
    steps: [{ click: { role: 'button', name: '$bot.long.title 상세 보기' } }],
  },
  {
    id: 'library-item-menu',
    title: '서재 · 자료 행 ⋯',
    principles: ['P2', 'P3', 'P4'],
    url: { destination: 'library', tab: 'bot' },
    ready: { testid: 'library-panel' },
    steps: [{ menu: '$bot.main.title 메뉴' }],
    metrics: ['menu-in-viewport', ...defaultMetrics],
  },
  appSettings('general', '일반', ['P4']),
  appSettings('models', '역할별 모델', ['P7', 'F5']),
  appSettings('prompts', '현재 프롬프트', ['P4']),
  appSettings('connections', '프로바이더·모델', ['P7', 'F5']),
  appSettings('agents', '에이전트', ['P4']),
  appSettings('illustrations', '삽화', ['P4']),
  appSettings('data', '데이터 관리', ['P4']),
  appSettings('security', '접근 보안', ['P4']),
];
