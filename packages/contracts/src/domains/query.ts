import { z } from 'zod/v4';

const integerText = /^-?(?:0|[1-9]\d*)$/u;

export const queryInt = <S extends z.ZodType<number, number>>(number: S = z.int() as never) =>
  z.union([z.number(), z.string().regex(integerText).transform(Number)]).pipe(number);

export const queryBoolean = z.union([
  z.boolean(),
  z.enum(['true', 'false']).transform((value) => value === 'true'),
]);
