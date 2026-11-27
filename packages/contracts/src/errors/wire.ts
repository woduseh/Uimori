import type { AppErrorCode, AppErrorParams } from './catalog.js';

export type AppErrorWire<C extends AppErrorCode = AppErrorCode> = {
  code: C;
} & (AppErrorParams[C] extends undefined ? { params?: never } : { params: AppErrorParams[C] });

export type LegacyErrorWire = { error: string };

export type ErrorWire = AppErrorWire | LegacyErrorWire;

export type ReceivedErrorWire = {
  code?: string;
  params?: Record<string, string | number | boolean>;
  error?: string;
};

export function readErrorWire(payload: unknown): ReceivedErrorWire {
  if (!payload || typeof payload !== 'object') return {};
  const { code, params, error } = payload as ReceivedErrorWire;
  if (typeof code === 'string') return params === undefined ? { code } : { code, params };
  return typeof error === 'string' ? { error } : {};
}
