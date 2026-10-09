/** Logical references per card; duplicate bytes retain distinct authored names. */
export const RISU_ASSET_MAX = 12_288;
/** Risu exports may include one x_meta entry for each asset. */
export const RISU_ZIP_MEMBERS_MAX = 32_768;
/** Combined packages leave one classic ZIP member for the portable backup manifest. */
export const RISU_AGGREGATE_IMAGES_MAX = 65_534;
