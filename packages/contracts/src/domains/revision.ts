import { z } from 'zod';

export const revision = z.number().int().nonnegative();
