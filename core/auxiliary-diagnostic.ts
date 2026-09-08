/** Local execution location; provider details remain in the linked attempt response. */
export type AuxiliaryFailureDiagnostic = {
  stage: 'preparation' | 'translation' | 'translation-refusal' | 'status' | 'image';
  code: string;
  attemptId?: string;
  blockId?: string;
  slotName?: string;
};
