import { z } from 'zod/v4';

export const revision = z.int().nonnegative();
