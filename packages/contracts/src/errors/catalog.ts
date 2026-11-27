export type AppErrorParams = {
  MAINTENANCE_CLOSED: undefined;
  STORY_UI_STALE_SOURCE: undefined;
  STORY_UI_DISABLED: undefined;
  STORY_UI_INVALID_ACTION: undefined;
  INPUT_TRANSLATION_LANGUAGE_INVALID: undefined;
  INPUT_TRANSLATION_CANCELLED: undefined;
  INPUT_TRANSLATION_TIMEOUT: undefined;
  INPUT_TRANSLATION_REFUSED: undefined;
  INPUT_TRANSLATION_FAILED: undefined;
  INPUT_TRANSLATION_TOO_LONG: { limit: number };
  SELECTION_REVISION_RANGE_INVALID: undefined;
  SELECTION_REVISION_STALE: undefined;
  SELECTION_REVISION_TRANSLATION_STALE: undefined;
  SELECTION_REVISION_TIMEOUT: undefined;
  SELECTION_REVISION_CANCELLED: undefined;
  SELECTION_REVISION_REFUSED: undefined;
  SELECTION_REVISION_FAILED: undefined;
  SELECTION_REVISION_TOO_LONG: undefined;
};

export type AppErrorCode = keyof AppErrorParams;

export type AppErrorParamsArgument<C extends AppErrorCode> = AppErrorParams[C] extends undefined
  ? []
  : [params: AppErrorParams[C]];

const takesParams = {
  MAINTENANCE_CLOSED: false,
  STORY_UI_STALE_SOURCE: false,
  STORY_UI_DISABLED: false,
  STORY_UI_INVALID_ACTION: false,
  INPUT_TRANSLATION_LANGUAGE_INVALID: false,
  INPUT_TRANSLATION_CANCELLED: false,
  INPUT_TRANSLATION_TIMEOUT: false,
  INPUT_TRANSLATION_REFUSED: false,
  INPUT_TRANSLATION_FAILED: false,
  INPUT_TRANSLATION_TOO_LONG: true,
  SELECTION_REVISION_RANGE_INVALID: false,
  SELECTION_REVISION_STALE: false,
  SELECTION_REVISION_TRANSLATION_STALE: false,
  SELECTION_REVISION_TIMEOUT: false,
  SELECTION_REVISION_CANCELLED: false,
  SELECTION_REVISION_REFUSED: false,
  SELECTION_REVISION_FAILED: false,
  SELECTION_REVISION_TOO_LONG: false,
} satisfies { [C in AppErrorCode]: AppErrorParams[C] extends undefined ? false : true };

export const APP_ERROR_CODES = Object.keys(takesParams) as AppErrorCode[];

export const isAppErrorCode = (value: unknown): value is AppErrorCode =>
  typeof value === 'string' && Object.hasOwn(takesParams, value);

export const appErrorTakesParams = (code: AppErrorCode): boolean => takesParams[code];
