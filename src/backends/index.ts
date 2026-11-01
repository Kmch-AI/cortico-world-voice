/** 协议适配器登记表。新增一种方言:实现 TtsBackend,再放进这张表。 */
import type { BackendId, TtsBackend } from '../types.ts';
import { audiocppBackend } from './audiocpp.ts';
import { customBackend } from './custom.ts';
import { openaiBackend } from './openai.ts';

const BACKENDS: Readonly<Record<BackendId, TtsBackend>> = {
  audiocpp: audiocppBackend,
  openai: openaiBackend,
  custom: customBackend,
};

export function backendOf(id: string): TtsBackend {
  return BACKENDS[id as BackendId] ?? BACKENDS.audiocpp;
}

export function backendIds(): BackendId[] {
  return Object.keys(BACKENDS) as BackendId[];
}

export { audiocppBackend, customBackend, openaiBackend };
