import { HttpError } from './request-validation.js';

export type HelperResourcePatchReason =
  | 'invalid_change'
  | 'invalid_target'
  | 'target_missing'
  | 'target_removed'
  | 'text_not_found'
  | 'text_ambiguous'
  | 'invalid_value';

export type HelperResourcePatchFailure = {
  changeIndex: number | null;
  path: string | null;
  op: string | null;
  reason: HelperResourcePatchReason;
  stage?: 'validation';
  target?: string;
  matchCount?: number;
};

/** A rejected proposal has no saved effects; details identify the change to revise. */
export class HelperResourcePatchError extends HttpError {
  constructor(
    statusCode: number,
    message: string,
    readonly details: HelperResourcePatchFailure
  ) {
    super(statusCode, message);
  }
}
