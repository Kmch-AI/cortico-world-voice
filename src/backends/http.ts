/** 适配器共用的 HTTP 小工具:地址拼接、超时、错误正文、音频回应。 */
import type { AudioFormat, TtsAudio } from '../types.ts';

/** 基础地址可以带 `/v1`,也可以不带;两种都拼出同一个接口。 */
export function apiUrl(base: string, path: string): string {
  const trimmed = (base || '').trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('baseUrl is empty');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return /\/v1$/.test(trimmed) ? `${trimmed}${suffix}` : `${trimmed}/v1${suffix}`;
}

export function mimeOf(format: AudioFormat): string {
  return format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
}

export function authHeaders(secret: string | undefined): Record<string, string> {
  return secret ? { Authorization: `Bearer ${secret}` } : {};
}

/** 读一小段错误正文,压成一行。 */
export async function errorSnippet(res: Response, limit = 600): Promise<string> {
  let body = '';
  try { body = await res.text(); } catch { /* 读不到就用状态行 */ }
  const flat = body.replace(/\s+/g, ' ').trim();
  return `TTS API ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${flat ? `: ${flat.slice(0, limit)}` : ''}`;
}

export function audioOf(bytes: Uint8Array, format: AudioFormat): TtsAudio {
  return { bytes, mime: mimeOf(format), seconds: wavSeconds(bytes) };
}

/** 带超时与外部取消的 fetch。 */
export async function timedFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timed out after ${timeoutMs} ms`)), Math.max(1, timeoutMs));
  const forward = (): void => ctrl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) forward();
    else signal.addEventListener('abort', forward, { once: true });
  }
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } catch (error) {
    if (ctrl.signal.aborted && !signal?.aborted) {
      throw new Error(`TTS request timed out after ${timeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
}

/** 回应必须是音频;不是时报错并带正文。 */
export async function readAudio(res: Response, format: AudioFormat): Promise<TtsAudio> {
  if (!res.ok) throw new Error(await errorSnippet(res));
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!type.startsWith('audio/') && !type.includes('octet-stream')) {
    throw new Error(await errorSnippet(res));
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error('TTS API returned an empty audio body');
  return audioOf(bytes, format);
}

/** PCM16 WAV 的时长;不是 RIFF/WAVE 时返回 undefined。 */
export function wavSeconds(bytes: Uint8Array): number | undefined {
  if (bytes.length < 44) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) return undefined;
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= bytes.length) {
    const id = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 0x666d7420 && body + 16 <= bytes.length) byteRate = view.getUint32(body + 8, true);
    if (id === 0x64617461) {
      if (byteRate > 0 && size > 0) return size / byteRate;
      return undefined;
    }
    offset = body + size + (size % 2);
  }
  return undefined;
}
