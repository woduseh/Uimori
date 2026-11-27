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

const catalog = {
  MAINTENANCE_CLOSED: true,
  STORY_UI_STALE_SOURCE: true,
  STORY_UI_DISABLED: true,
  STORY_UI_INVALID_ACTION: true,
  INPUT_TRANSLATION_LANGUAGE_INVALID: true,
  INPUT_TRANSLATION_CANCELLED: true,
  INPUT_TRANSLATION_TIMEOUT: true,
  INPUT_TRANSLATION_REFUSED: true,
  INPUT_TRANSLATION_FAILED: true,
  INPUT_TRANSLATION_TOO_LONG: true,
  SELECTION_REVISION_RANGE_INVALID: true,
  SELECTION_REVISION_STALE: true,
  SELECTION_REVISION_TRANSLATION_STALE: true,
  SELECTION_REVISION_TIMEOUT: true,
  SELECTION_REVISION_CANCELLED: true,
  SELECTION_REVISION_REFUSED: true,
  SELECTION_REVISION_FAILED: true,
  SELECTION_REVISION_TOO_LONG: true,
} satisfies Record<AppErrorCode, true>;

export const APP_ERROR_CODES = Object.keys(catalog) as AppErrorCode[];

export const isAppErrorCode = (value: unknown): value is AppErrorCode =>
  typeof value === 'string' && Object.hasOwn(catalog, value);
