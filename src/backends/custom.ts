/**
 * 自定义 JSON 协议:请求头与请求体都是配置里的模板,回应可以是音频字节、
 * base64 字段或一个音频地址。给没有专门适配器的服务留的出口。
 */
import type { BackendContext, BackendHealth, TtsBackend, TtsAudio, TtsRequest, VoiceOption } from '../types.ts';
import { buildInstruct, resolveStyle } from '../speech/style.ts';
import { audioOf, errorSnippet, mimeOf, timedFetch } from './http.ts';

const DEFAULT_BODY = '{"text":"{{text}}","voice":"{{voice}}"}';

/** JSON 字符串里的内容转义(不带引号)。 */
function quote(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function valuesOf(req: TtsRequest, ctx: BackendContext): Record<string, string> {
  const style = resolveStyle(ctx.cfg, req);
  return {
    text: req.text,
    voice: (req.voice ?? '').trim() || ctx.cfg.voice.trim(),
    emotion: style.emotion,
    instruct: buildInstruct(style),
    model: ctx.cfg.model.trim(),
    format: req.format,
    speed: Number.isFinite(style.speed) ? String(style.speed) : '1',
  };
}

function bodyOf(template: string, values: Record<string, string>): string {
  return (template.trim() || DEFAULT_BODY).replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (whole, key: string) => {
    const value = values[key.toLowerCase()];
    if (value === undefined) return whole;
    // speed 是数字,原样放;其余按 JSON 字符串内容转义。
    return key.toLowerCase() === 'speed' ? value : quote(value);
  });
}

function headersOf(raw: string, secret: string): Record<string, string> {
  let parsed: unknown = {};
  if (raw.trim()) {
    try { parsed = JSON.parse(raw); } catch { throw new Error('customHeaders is not valid JSON'); }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('customHeaders must be a JSON object');
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') throw new Error(`customHeaders.${key} must be a string`);
    out[key] = value.split('${KEY}').join(secret);
  }
  if (secret && !Object.keys(out).some((k) => k.toLowerCase() === 'authorization')) {
    out.Authorization = `Bearer ${secret}`;
  }
  return out;
}

function pickPath(data: unknown, path: string): unknown {
  let cur = data;
  for (const seg of (path || 'audio').split('.').filter(Boolean)) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function decodeBase64(raw: string): Uint8Array {
  const comma = raw.indexOf(',');
  const body = raw.startsWith('data:') && comma >= 0 ? raw.slice(comma + 1) : raw;
  const bytes = Buffer.from(body, 'base64');
  if (!bytes.length) throw new Error('customResponse base64 field is empty');
  return new Uint8Array(bytes);
}

export const customBackend: TtsBackend = {
  id: 'custom',
  label: 'custom JSON',

  async synthesize(req: TtsRequest, ctx: BackendContext): Promise<TtsAudio> {
    const { cfg } = ctx;
    const url = cfg.customUrl.trim();
    if (!url) throw new Error('customUrl is empty');
    const secret = ctx.secret(cfg.apiKeySecret);
    const headers = headersOf(cfg.customHeaders, secret);
    const values = valuesOf(req, ctx);

    let target = url;
    const init: RequestInit = { method: cfg.customMethod, headers };
    if (cfg.customMethod === 'GET') {
      const u = new URL(url);
      for (const [key, value] of Object.entries(values)) if (value) u.searchParams.set(key, value);
      target = u.toString();
    } else {
      const body = bodyOf(cfg.customBody, values);
      try { JSON.parse(body); } catch { throw new Error('customBody is not valid JSON after placeholders were filled'); }
      headers['Content-Type'] ??= 'application/json';
      init.body = body;
    }

    const res = await timedFetch(ctx.fetch, target, init, cfg.timeoutMs, req.signal);
    if (!res.ok) throw new Error(await errorSnippet(res));
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (type.startsWith('audio/') || type.includes('octet-stream')) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!bytes.length) throw new Error('custom API returned an empty audio body');
      return audioOf(bytes, req.format);
    }

    if (cfg.customResponse === 'audio') throw new Error(await errorSnippet(res));
    const data = await res.json();
    const value = pickPath(data, cfg.customAudioPath);
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`custom response has no string at ${cfg.customAudioPath || 'audio'}`);
    }
    if (cfg.customResponse === 'base64') {
      return { bytes: decodeBase64(value), mime: mimeOf(req.format) };
    }
    const audioUrl = new URL(value, url).toString();
    const audioRes = await timedFetch(ctx.fetch, audioUrl, { method: 'GET', headers }, cfg.timeoutMs, req.signal);
    if (!audioRes.ok) throw new Error(await errorSnippet(audioRes));
    const bytes = new Uint8Array(await audioRes.arrayBuffer());
    if (!bytes.length) throw new Error('custom audio URL returned an empty body');
    return { bytes, mime: (audioRes.headers.get('content-type') ?? '').split(';')[0] || mimeOf(req.format) };
  },

  async listVoices(): Promise<VoiceOption[]> {
    return [];
  },

  async health(ctx: BackendContext): Promise<BackendHealth> {
    return ctx.cfg.customUrl.trim()
      ? { ok: true, detail: 'not probed' }
      : { ok: false, detail: 'customUrl is empty' };
  },
};
