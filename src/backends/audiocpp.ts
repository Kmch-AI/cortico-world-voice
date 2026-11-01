/**
 * audiocpp 的 `/v1/audio/speech`。兼容 OpenAI 的外形,另有一个 `options` 对象:
 * Ming 3.0 用 `template_name` 选 basic / freeform / emotion 三种控制模板。
 */
import type { BackendContext, BackendHealth, TtsBackend, TtsRequest, VoiceOption } from '../types.ts';
import { buildInstruct, classifySpeed, resolveStyle } from '../speech/style.ts';
import { apiUrl, authHeaders, readAudio, timedFetch } from './http.ts';

function optionsOf(req: TtsRequest, cfg: BackendContext['cfg']): Record<string, unknown> | undefined {
  const style = resolveStyle(cfg, req);
  switch (cfg.emotionMode) {
    case 'instruct': {
      const instruct = buildInstruct(style);
      return instruct ? { template_name: 'freeform', instruct } : undefined;
    }
    case 'categorical':
      return { template_name: 'emotion', emotion: style.emotion || '平静' };
    case 'basic':
      return {
        template_name: 'basic',
        speed: classifySpeed(style.speed),
        pitch: '中',
        volume: '中',
      };
    default:
      return undefined;
  }
}

export const audiocppBackend: TtsBackend = {
  id: 'audiocpp',
  label: 'audiocpp',

  async synthesize(req: TtsRequest, ctx: BackendContext) {
    const { cfg } = ctx;
    const body: Record<string, unknown> = {
      model: cfg.model.trim() || undefined,
      voice: (req.voice ?? '').trim() || cfg.voice.trim() || undefined,
      input: req.text,
      response_format: req.format,
    };
    const options = optionsOf(req, cfg);
    if (options) body.options = options;
    for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
    const res = await timedFetch(ctx.fetch, apiUrl(cfg.baseUrl, '/audio/speech'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(ctx.secret(cfg.apiKeySecret)) },
      body: JSON.stringify(body),
    }, cfg.timeoutMs, req.signal);
    return readAudio(res, req.format);
  },

  async listVoices(ctx: BackendContext): Promise<VoiceOption[]> {
    const { cfg } = ctx;
    const url = new URL(apiUrl(cfg.baseUrl, '/audio/voices'));
    if (cfg.model.trim()) url.searchParams.set('model', cfg.model.trim());
    try {
      const res = await timedFetch(ctx.fetch, url.toString(), {
        method: 'GET',
        headers: authHeaders(ctx.secret(cfg.apiKeySecret)),
      }, Math.min(cfg.timeoutMs, 8000));
      if (!res.ok) return [];
      const data = await res.json() as { voices?: unknown };
      const raw = Array.isArray(data?.voices) ? data.voices : Array.isArray(data) ? data : [];
      return raw.flatMap((item): VoiceOption[] => {
        if (typeof item === 'string' && item.trim()) return [{ value: item, label: item }];
        if (item && typeof item === 'object') {
          const o = item as Record<string, unknown>;
          const value = typeof o.id === 'string' ? o.id : typeof o.name === 'string' ? o.name : '';
          if (!value) return [];
          const label = typeof o.label === 'string' ? o.label
            : typeof o.displayName === 'string' ? o.displayName : value;
          return [{ value, label }];
        }
        return [];
      });
    } catch {
      return [];
    }
  },

  async health(ctx: BackendContext): Promise<BackendHealth> {
    const { cfg } = ctx;
    const root = cfg.baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
    try {
      const res = await timedFetch(ctx.fetch, `${root}/health`, {
        method: 'GET',
        headers: authHeaders(ctx.secret(cfg.apiKeySecret)),
      }, Math.min(cfg.timeoutMs, 8000));
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
      const data = await res.json().catch(() => null) as { models?: number; backend?: string } | null;
      const detail = data ? `${data.backend ?? 'unknown'} · ${data.models ?? 0} models` : undefined;
      return { ok: true, ...(detail ? { detail } : {}) };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  },
};
