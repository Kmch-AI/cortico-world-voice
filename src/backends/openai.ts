/** OpenAI 兼容的 `POST /v1/audio/speech`。 */
import type { BackendContext, BackendHealth, TtsBackend, TtsRequest, VoiceOption } from '../types.ts';
import { buildInstruct, resolveStyle } from '../speech/style.ts';
import { apiUrl, authHeaders, readAudio, timedFetch } from './http.ts';

const DEFAULT_MODEL = 'tts-1';
const DEFAULT_VOICE = 'alloy';

export const openaiBackend: TtsBackend = {
  id: 'openai',
  label: 'OpenAI 兼容 /v1/audio/speech',

  async synthesize(req: TtsRequest, ctx: BackendContext) {
    const { cfg } = ctx;
    const style = resolveStyle(cfg, req);
    const body: Record<string, unknown> = {
      model: cfg.model.trim() || DEFAULT_MODEL,
      input: req.text,
      voice: (req.voice ?? '').trim() || cfg.voice.trim() || DEFAULT_VOICE,
      response_format: req.format,
    };
    if (Number.isFinite(style.speed) && style.speed !== 1) {
      body.speed = Math.min(4, Math.max(0.25, style.speed));
    }
    const instructions = buildInstruct(style);
    if (instructions) body.instructions = instructions;
    const res = await timedFetch(ctx.fetch, apiUrl(cfg.baseUrl, '/audio/speech'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(ctx.secret(cfg.apiKeySecret)) },
      body: JSON.stringify(body),
    }, cfg.timeoutMs, req.signal);
    return readAudio(res, req.format);
  },

  async listVoices(): Promise<VoiceOption[]> {
    return [];
  },

  async health(ctx: BackendContext): Promise<BackendHealth> {
    const { cfg } = ctx;
    try {
      const res = await timedFetch(ctx.fetch, apiUrl(cfg.baseUrl, '/models'), {
        method: 'GET',
        headers: authHeaders(ctx.secret(cfg.apiKeySecret)),
      }, Math.min(cfg.timeoutMs, 8000));
      return res.ok ? { ok: true } : { ok: false, detail: `HTTP ${res.status}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  },
};
