import type { Logger } from './types/hooks.js';

export const isAbortError = (err: unknown): boolean =>
  err instanceof Error && err.name === 'AbortError';

export const newAbortError = (message = 'The operation was aborted'): Error => {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
};

export const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw newAbortError();
};

/** Deep-freeze a structuredClone snapshot for async (fire-and-forget) steps. */
export const freezeState = <T>(value: T): T => {
  const clone = structuredClone(value);
  const deepFreeze = (obj: unknown): void => {
    if (obj === null || typeof obj !== 'object') return;
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
  };
  deepFreeze(clone);
  return clone;
};

export const consoleLogger: Logger = {
  debug: (msg, data) => console.debug(msg, data ?? ''),
  info: (msg, data) => console.info(msg, data ?? ''),
  warn: (msg, data) => console.warn(msg, data ?? ''),
  error: (msg, data) => console.error(msg, data ?? ''),
};

/** A logger that drops everything (default for tests). */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
