/** Static reading of a Risu plugin file. No plugin code runs at any point. */
export const RISU_PLUGIN_MAX_BYTES = 4 * 1024 * 1024;
export type RisuPluginArgument = { key: string; type: 'int' | 'string'; description: string };
export type RisuPluginApiSupport = 'mapped' | 'unimplemented' | 'out-of-scope';
export type RisuPluginApiUse = { name: string; support: RisuPluginApiSupport; note: string };
export type RisuPluginPreview = {
  name: string;
  displayName: string;
  apiVersion: string;
  /** The plugin's own `//@version`, which Risu keeps apart from the API version. */
  pluginVersion: string;
  /** The `//@update-url` the file declares; empty unless it is an https URL. */
  updateUrl: string;
  /** The plugin channels `//@allowed-ipc` declares. Uimori implements no such channel. */
  allowedIpc: string[];
  links: { url: string; hoverText?: string }[];
  arguments: RisuPluginArgument[];
  /** Every `risuai.*` member the file mentions, judged against the current Uimori contracts. */
  apis: RisuPluginApiUse[];
  unknownApis: string[];
  findings: { code: string; level: 'info' | 'warning' | 'unsupported'; message: string }[];
  bytes: number;
  sha256: string;
};

/** Each entry states where the member lands today; nothing here promises future support. */
export const RISU_PLUGIN_API_SUPPORT: Record<
  string,
  { support: RisuPluginApiSupport; note: string }
> = {
  ...group(
    ['getArgument', 'getArg'],
    'mapped',
    '플러그인 인자 읽기는 자료 옵션과 같은 선언형 값으로 옮길 수 있어요.'
  ),
  ...group(
    ['addRisuReplacer', 'removeRisuReplacer', 'addRisuScriptHandler', 'removeRisuScriptHandler'],
    'mapped',
    '입력·출력·표시 텍스트 처리는 공통 텍스트 변환과 편집 훅 단계에 대응해요. 편집 훅은 메시지 수와 역할을 그대로 유지해야 해요.'
  ),
  ...group(
    ['addRisuChatListener', 'removeRisuChatListener'],
    'mapped',
    '대화 이벤트는 생성 전·응답 후 자동 행동에 대응해요.'
  ),
  ...group(
    ['getCurrentLorebookEntries', 'getCharacter', 'getChar'],
    'mapped',
    '자기 자료 읽기 Host API로 대응하며 다른 자료 읽기는 포함하지 않아요.'
  ),
  ...group(['runLLMModel'], 'mapped', '추가 모델 호출 capability와 채팅별 허용으로 대응해요.'),
  ...group(
    ['apiVersion', 'apiVersionCompatibleWith', 'getRuntimeInfo'],
    'mapped',
    '실행 환경과 버전 정보는 공통 실행기가 소유해요.'
  ),
  ...group(
    ['setArgument', 'setArg'],
    'unimplemented',
    '플러그인 인자를 저장하는 곳이 아직 없어요. 인자 읽기는 나중에 꾸러미 옵션으로 옮길 수 있어요.'
  ),
  ...group(
    ['pluginStorage', 'getLocalPluginStorage', 'safeLocalStorage'],
    'unimplemented',
    '앱 전역 JSON 저장소는 사용자 허용을 받는 분기 범위 문자열 변수와 달라서 아직 대응하지 않아요.'
  ),
  ...group(
    ['parseRisuChat'],
    'unimplemented',
    'CBS 변환은 가져오기 시점 작업이라 실행 중에 부르는 경로는 아직 없어요.'
  ),
  ...group(['onUnload'], 'unimplemented', '상주 인스턴스가 없어서 해제 훅을 아직 제공하지 않아요.'),
  ...group(
    ['log'],
    'unimplemented',
    '플러그인이 직접 기록을 남기는 Host 메서드가 아직 없어요. 진단은 실행 영수증이 소유해요.'
  ),
  ...group(
    ['risuFetch'],
    'unimplemented',
    '일반 HTTP 호출은 아직 구현하지 않았어요. 원문에서도 nativeFetch로 대체된 옛 이름이에요.'
  ),
  ...group(
    ['nativeFetch', 'getFetchLogs', 'saveSecretHeader'],
    'unimplemented',
    '일반 HTTP 호출과 비밀 헤더 보관은 아직 구현하지 않았어요.'
  ),
  ...group(
    [
      'addProvider',
      'registerMCP',
      'unregisterMCP',
      'registerBodyIntercepter',
      'unregisterBodyIntercepter',
    ],
    'unimplemented',
    '제공자·MCP 어댑터와 요청 본문 가로채기는 아직 구현하지 않았어요.'
  ),
  ...group(
    ['addTTSPreprocessor', 'addTTSPostprocessor'],
    'unimplemented',
    '음성 합성 연결은 아직 구현하지 않았어요.'
  ),
  ...group(
    ['readImage', 'readInlay', 'saveAsset'],
    'unimplemented',
    '플러그인이 직접 에셋을 읽고 저장하는 경로는 아직 없어요.'
  ),
  ...group(
    ['getTranslationCache', 'searchTranslationCache'],
    'unimplemented',
    '번역 캐시 조회 API는 아직 없어요.'
  ),
  ...group(
    [
      'addPluginChannelListener',
      'postPluginChannelMessage',
      'loadPlugins',
      'installPlugin',
      'requestPluginPermission',
    ],
    'unimplemented',
    '플러그인 설치·상호 통신 관리는 아직 구현하지 않았어요.'
  ),
  ...group(
    [
      'getChatFromIndex',
      'getCurrentChatIndex',
      'getCurrentCharacterIndex',
      'getCharacterFromIndex',
    ],
    'out-of-scope',
    '번호로 대화 분기나 다른 자료를 고르는 주소 공간을 두지 않아요. 대화 Host API는 현재 대화만, 자료 Host API는 자기 꾸러미만 읽어요.'
  ),
  ...group(
    [
      'setCharacter',
      'setChar',
      'setCharacterToIndex',
      'setChatToIndex',
      'sendChat',
      'setDatabase',
      'setDatabaseLite',
    ],
    'out-of-scope',
    '앱 DB와 저장 대화를 직접 바꾸는 경로는 원문 보존 결정에 따라 제공하지 않아요.'
  ),
  ...group(
    ['getDatabase', 'checkCharOrder'],
    'out-of-scope',
    '원문에서도 쓰기가 아닌 읽기 전용 허용 목록 프록시지만, 앱 전체 설정과 다른 자료까지 드러나서 제공하지 않아요.'
  ),
  ...group(
    ['getRootDocument', 'createMutationObserver', 'unwarpSafeArray'],
    'out-of-scope',
    '주 앱 DOM 접근은 도입하지 않기로 결정했어요.'
  ),
  // One rule for every main-app UI entry point: registering a part, drawing into the chat screen
  // and opening an app dialog all need the main app's own surface, so none of them is provided.
  ...group(
    [
      'showContainer',
      'hideContainer',
      'registerButton',
      'registerSetting',
      'unregisterUIPart',
      'setChatPanel',
      'alert',
      'alertConfirm',
      'alertError',
    ],
    'out-of-scope',
    '주 앱 화면에 요소를 올리거나 주 앱 대화 상자를 여는 UI는 격리된 커스텀 패널 경계로 대신해요.'
  ),
  ...group(
    [
      'changeColorScheme',
      'setColorScheme',
      'getColorScheme',
      'changeTextTheme',
      'getTextTheme',
      'setCustomTextTheme',
    ],
    'out-of-scope',
    '앱 테마 변경은 사용자 설정이 소유해요.'
  ),
};

function group(
  names: string[],
  support: RisuPluginApiSupport,
  note: string
): Record<string, { support: RisuPluginApiSupport; note: string }> {
  return Object.fromEntries(names.map((name) => [name, { support, note }]));
}
