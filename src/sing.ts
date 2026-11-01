/**
 * 唱歌插件的 HTTP 连接。协议跟现有的 DiffSinger World 一致:
 * `GET /health`、`POST /sing {lyrics,…}` → `audio/wav`(或 `{audioBase64}`)。
 * 只经 HTTP 相连,不 import 对方的包。
 */
import type { TtsAudio } from './types.ts';
import { errorSnippet, mimeOf, timedFetch } from './backends/http.ts';

/** 正文以 `【唱】`(或 `[唱]` / `[sing]`)开头时交给唱歌插件。 */
export const SING_MARK = /^\s*[【\[]\s*(?:唱|sing)\s*[】\]]\s*/i;

export function singRequestOf(text: string): { lyrics: string; marked: boolean } {
  const m = SING_MARK.exec(text);
  if (!m) return { lyrics: text.trim(), marked: false };
  return { lyrics: text.slice(m[0].length).trim(), marked: true };
}

function singUrlOf(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, '');
  const url = new URL(trimmed);
  if (!/\/sing$/.test(url.pathname)) url.pathname = `${url.pathname.replace(/\/$/, '')}/sing`;
  return url.toString();
}

export interface SingOptions {
  url: string;
  token?: string;
  lyrics: string;
  timeoutMs: number;
  fetch: typeof fetch;
  signal?: AbortSignal;
}

export async function singRemote(opts: SingOptions): Promise<TtsAudio> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await timedFetch(opts.fetch, singUrlOf(opts.url), {
    method: 'POST',
    headers,
    body: JSON.stringify({ lyrics: opts.lyrics }),
  }, Math.max(30_000, opts.timeoutMs), opts.signal);
  if (!res.ok) throw new Error(await errorSnippet(res));
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  if (type.startsWith('audio/') || type.includes('octet-stream')) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length) throw new Error('singing service returned an empty body');
    return { bytes, mime: type.split(';')[0] || mimeOf('wav') };
  }
  const data = await res.json().catch(() => null) as { audioBase64?: unknown; mime?: unknown } | null;
  if (typeof data?.audioBase64 === 'string' && data.audioBase64) {
    return {
      bytes: new Uint8Array(Buffer.from(data.audioBase64, 'base64')),
      mime: typeof data.mime === 'string' ? data.mime : mimeOf('wav'),
    };
  }
  throw new Error('singing service returned no audio');
}

export async function singHealth(opts: { url: string; token?: string; fetch: typeof fetch }): Promise<boolean> {
  if (!opts.url.trim()) return false;
  try {
    const url = new URL(opts.url.trim().replace(/\/+$/, ''));
    url.pathname = '/health';
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    const res = await timedFetch(opts.fetch, url.toString(), { method: 'GET', headers }, 5000);
    if (!res.ok) return false;
    const data = await res.json().catch(() => null) as { ready?: unknown } | null;
    return data?.ready !== false;
  } catch {
    return false;
  }
}
