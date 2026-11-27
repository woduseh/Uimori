import { z } from 'zod/v4';

export const nonBlank = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim() !== '', 'Expected a non-blank string');
