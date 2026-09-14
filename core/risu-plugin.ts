/** Static reading of a Risu plugin file. No plugin code runs at any point. */
export const RISU_PLUGIN_MAX_BYTES = 4 * 1024 * 1024;
export type RisuPluginArgument = { key: string; type: 'int' | 'string'; description: string };
export type RisuPluginApiSupport = 'mapped' | 'unimplemented' | 'out-of-scope';
export type RisuPluginApiUse = { name: string; support: RisuPluginApiSupport; note: string };
export type RisuPluginPreview = {
  name: string;
  displayName: string;
  apiVersion: string;
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
    ['getArgument', 'getArg', 'setArgument', 'setArg'],
    'mapped',
    '플러그인 인자는 자료 옵션과 같은 선언형 값으로 옮길 수 있어요.'
  ),
  ...group(
    ['pluginStorage', 'getLocalPluginStorage', 'safeLocalStorage'],
    'mapped',
    '플러그인 저장소는 분기 공유 변수 Host로 옮길 수 있어요.'
  ),
  ...group(
    ['addRisuReplacer', 'removeRisuReplacer', 'addRisuScriptHandler', 'removeRisuScriptHandler'],
    'mapped',
    '입력·출력·표시 텍스트 처리는 공통 텍스트 변환과 편집 훅 단계에 대응해요.'
  ),
  ...group(
    ['addRisuChatListener', 'removeRisuChatListener'],
    'mapped',
    '대화 이벤트는 생성 전·응답 후 자동 행동에 대응해요.'
  ),
  ...group(
    ['getCurrentLorebookEntries', 'getCharacter', 'getChar', 'getCharacterFromIndex'],
    'mapped',
    '자기 자료 읽기 Host API로 대응하며 다른 자료 읽기는 포함하지 않아요.'
  ),
  ...group(
    ['getChatFromIndex', 'getCurrentChatIndex', 'getCurrentCharacterIndex'],
    'mapped',
    '현재 분기 대화 읽기 Host API로 대응하며 허용이 필요해요.'
  ),
  ...group(['runLLMModel'], 'mapped', '추가 모델 호출 capability와 채팅별 허용으로 대응해요.'),
  ...group(['parseRisuChat'], 'mapped', '지원하는 CBS 읽기는 가져오기에서 공통 AST로 변환해요.'),
  ...group(
    ['log', 'apiVersion', 'apiVersionCompatibleWith', 'getRuntimeInfo', 'onUnload'],
    'mapped',
    '실행 수명과 진단은 공통 실행기·영수증이 소유해요.'
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
      'requestPluginPermission',
    ],
    'unimplemented',
    '플러그인 설치·상호 통신 관리는 아직 구현하지 않았어요.'
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
      'getDatabase',
      'checkCharOrder',
    ],
    'out-of-scope',
    '앱 DB와 저장 대화를 직접 바꾸는 경로는 원문 보존 결정에 따라 제공하지 않아요.'
  ),
  ...group(
    ['getRootDocument', 'createMutationObserver', 'unwarpSafeArray'],
    'out-of-scope',
    '주 앱 DOM 접근은 도입하지 않기로 결정했어요.'
  ),
  ...group(
    ['showContainer', 'hideContainer', 'registerButton', 'registerSetting', 'unregisterUIPart'],
    'out-of-scope',
    '주 앱 화면에 요소를 등록하는 대신 격리된 커스텀 패널 경계를 사용해요.'
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
