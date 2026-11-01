/**
 * Kmch AI · 服务 的 HTTP 客户端。语音只认这一条协议:
 * `POST /v1/audio/speech` 取音频,`GET /health` 探活,
 * `GET /v1/models` 与 `GET /v1/audio/voices` 取目录。
 * 令牌只从 secret() 现读,不写日志、不留副本。
 */
import type {
  AudioFormat, ModelParameter, ModelParameterType, ServiceHealth, TtsAudio, TtsRequest,
  VoiceConfigSection, VoiceModel, VoiceOption,
} from './types.ts';

const PROBE_TIMEOUT_MS = 8000;
const LIST_TIMEOUT_MS = 8000;

export interface ServiceClientDeps {
  fetch: typeof fetch;
  /** 从部署 .env 读密钥;名字为空时返回空串。 */
  secret(name: string): string;
  /** `worlds.voice` 的活引用。 */
  cfg(): VoiceConfigSection;
}

/** World 只需要这些方法;测试用假客户端也实现它们。 */
export type SpeechService = Pick<ServiceClient, 'synthesize' | 'health' | 'models' | 'voices'>;

export class ServiceClient implements SpeechService {
  constructor(private readonly deps: ServiceClientDeps) {}

  private get cfg(): VoiceConfigSection {
    return this.deps.cfg();
  }

  async synthesize(req: TtsRequest, signal?: AbortSignal): Promise<TtsAudio> {
    const cfg = this.cfg;
    const body: Record<string, unknown> = {
      input: req.text,
      response_format: req.format,
    };
    const model = cfg.model.trim();
    if (model) body.model = model;
    // 只带当前模型自己的参数;其他模型的配置不混进这次请求。
    const options = cfg.modelOptions?.[model];
    if (options && Object.keys(options).length > 0) body.options = options;
    const voice = (req.voice ?? '').trim() || cfg.voice.trim();
    if (voice) body.voice = voice;
    const instruct = (req.instruct ?? '').trim();
    if (instruct) body.instructions = instruct;
    const emotion = (req.emotion ?? '').trim();
    if (emotion) body.emotion = emotion;
    if (req.speed !== undefined && Number.isFinite(req.speed)) body.speed = req.speed;

    return this.request(this.endpoint('/v1/audio/speech'), {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(body),
    }, cfg.timeoutMs, signal ?? req.signal, async (res) => {
      if (!res.ok) throw new Error(await errorText(res));
      const declared = res.headers.get('content-type');
      const mime = normalizeMime(declared, req.format);
      if (!mime) {
        throw new Error(`voice service returned ${declared?.split(';')[0]?.trim() || 'no content-type'} instead of audio`);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length === 0) throw new Error('voice service returned an empty audio body');
      return { bytes, mime, seconds: mime === 'audio/wav' ? wavSeconds(bytes) : undefined };
    });
  }

  /** 探活;连不上或回应不合法时返回 `ok: false`,不抛错。 */
  async health(): Promise<ServiceHealth> {
    try {
      return await this.request(
        this.endpoint('/health'),
        { method: 'GET', headers: this.headers() },
        Math.min(this.cfg.timeoutMs || PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS),
        undefined,
        async (res): Promise<ServiceHealth> => {
          if (!res.ok) {
            return { ok: false, ready: false, status: `HTTP ${res.status}`, detail: await errorText(res) };
          }
          const data = await res.json().catch(() => null) as {
            status?: unknown; ready?: unknown; models?: unknown; services?: unknown;
          } | null;
          const status = typeof data?.status === 'string' && data.status.trim() ? data.status.trim() : 'ok';
          const ready = data?.ready === true;
          const models = typeof data?.models === 'number'
            ? data.models
            : Array.isArray(data?.services) ? data.services.length : undefined;
          return {
            ok: true,
            ready,
            status,
            ...(models !== undefined ? { models } : {}),
            detail: `${status}${models !== undefined ? ` · ${models} models` : ''}`,
          };
        },
      );
    } catch (error) {
      return { ok: false, ready: false, status: 'unreachable', detail: messageOf(error) };
    }
  }

  async models(): Promise<VoiceModel[]> {
    const payload = await this.request(
      this.endpoint('/v1/models'),
      { method: 'GET', headers: this.headers() },
      this.listTimeout(),
      undefined,
      (res) => this.readJson(res),
    ) as { data?: unknown } | unknown[] | null;
    const raw = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
    return raw.flatMap((item): VoiceModel[] => {
      const model = modelOf(item);
      return model ? [model] : [];
    });
  }

  async voices(model?: string): Promise<VoiceOption[]> {
    const url = new URL(this.endpoint('/v1/audio/voices'));
    const wanted = (model ?? this.cfg.model).trim();
    if (wanted) url.searchParams.set('model', wanted);
    const payload = await this.request(
      url.toString(),
      { method: 'GET', headers: this.headers() },
      this.listTimeout(),
      undefined,
      (res) => this.readJson(res),
    ) as { data?: unknown; voices?: unknown } | unknown[] | null;
    const raw = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data) ? payload.data
        : Array.isArray(payload?.voices) ? payload.voices
          : [];
    return raw.flatMap((item): VoiceOption[] => {
      const option = optionOf(item);
      return option ? [option] : [];
    });
  }

  // ———————— 内部 ————————

  /** 地址可以带 `/v1`,也可以不带;路径统一从网关根算起。 */
  private endpoint(path: string): string {
    const raw = this.cfg.serviceUrl.trim();
    if (!raw) throw new Error('serviceUrl is empty');
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`serviceUrl is not a valid URL: ${raw}`);
    }
    url.search = '';
    url.hash = '';
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    const base = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
    url.pathname = `${base}${path}`;
    return url.toString();
  }

  private headers(json = false): Record<string, string> {
    const out: Record<string, string> = {};
    if (json) out['Content-Type'] = 'application/json';
    const name = this.cfg.serviceTokenSecret.trim();
    const token = name ? this.deps.secret(name).trim() : '';
    if (token) out.Authorization = `Bearer ${token}`;
    return out;
  }

  private listTimeout(): number {
    return Math.min(this.cfg.timeoutMs || LIST_TIMEOUT_MS, LIST_TIMEOUT_MS);
  }

  private async readJson(res: Response): Promise<unknown> {
    if (!res.ok) throw new Error(await errorText(res));
    return res.json().catch(() => null);
  }

  /**
   * 超时覆盖到回应体读完,不只是等到响应头;外部 signal 的取消也持续到读完。
   * `read` 自己抛的错原样保留,超时统一报同一个句子。
   */
  private async request<T>(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    read: (res: Response) => Promise<T>,
  ): Promise<T> {
    const ctrl = new AbortController();
    const ms = Math.max(1, timeoutMs);
    let timedOut = false;
    const timeoutError = (): Error => new Error(`voice service timed out after ${ms} ms`);
    let rejectDeadline: (error: Error) => void = () => {};
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const timer = setTimeout(() => {
      timedOut = true;
      const error = timeoutError();
      ctrl.abort(error);
      rejectDeadline(error);
    }, ms);
    const forward = (): void => ctrl.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) forward();
      else signal.addEventListener('abort', forward, { once: true });
    }
    try {
      const res = await Promise.race([
        this.deps.fetch(url, { ...init, signal: ctrl.signal }),
        deadline,
      ]);
      return await Promise.race([read(res), deadline]);
    } catch (error) {
      if (timedOut) throw timeoutError();
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionOf(item: unknown): { value: string; label: string } | null {
  if (typeof item === 'string') {
    const value = item.trim();
    return value ? { value, label: value } : null;
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const o = item as Record<string, unknown>;
  const value = [o.value, o.id, o.name]
    .find((v): v is string => typeof v === 'string' && v.trim() !== '')?.trim();
  if (!value) return null;
  const label = [o.label, o.display_name, o.displayName, o.name]
    .find((v): v is string => typeof v === 'string' && v.trim() !== '')?.trim() ?? value;
  return { value, label };
}

const PARAMETER_TYPES = new Set<ModelParameterType>([
  'string', 'enum', 'bool', 'int', 'float', 'string_list', 'path', 'path_list',
]);

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** 目录里的音色/取值可能写成字符串,也可能写成对象;只留去重后的字符串。 */
function stringItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = typeof item === 'string'
      ? item.trim()
      : item && typeof item === 'object' && !Array.isArray(item)
        ? firstString(
          (item as Record<string, unknown>).value,
          (item as Record<string, unknown>).id,
          (item as Record<string, unknown>).name,
          (item as Record<string, unknown>).label,
        )
        : '';
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parameterOf(item: unknown): ModelParameter | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const o = item as Record<string, unknown>;
  const name = firstString(o.name);
  const type = firstString(o.type) as ModelParameterType;
  if (!name || !PARAMETER_TYPES.has(type)) return null;
  const description = firstString(o.description);
  const values = stringItems(o.values);
  const min = finiteNumber(o.min);
  const max = finiteNumber(o.max);
  return {
    name,
    type,
    ...(description ? { description } : {}),
    ...(values.length ? { values } : {}),
    ...(o.default !== undefined ? { default: o.default } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
  };
}

/** 服务目录的一项:模型 id、显示名、音色与请求参数;不认识的字段不带走。 */
function modelOf(item: unknown): VoiceModel | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const o = item as Record<string, unknown>;
  const id = firstString(o.id, o.value, o.name);
  if (!id) return null;
  const label = firstString(o.display_name, o.displayName, o.label);
  const parameters = Array.isArray(o.parameters)
    ? o.parameters.flatMap((entry): ModelParameter[] => {
      const parameter = parameterOf(entry);
      return parameter ? [parameter] : [];
    })
    : [];
  return {
    id,
    ...(label ? { label } : {}),
    voices: stringItems(o.voices),
    ...(parameters.length ? { parameters } : {}),
  };
}

/** 音频回应只接受 wav / mpeg;octet-stream 按请求的格式归一。 */
function normalizeMime(raw: string | null, format: AudioFormat): string | null {
  const type = (raw ?? '').split(';')[0]!.trim().toLowerCase();
  if (!type || type === 'application/octet-stream') return format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
  if (type === 'audio/wav' || type === 'audio/wave' || type === 'audio/x-wav') return 'audio/wav';
  if (type === 'audio/mpeg' || type === 'audio/mp3' || type === 'audio/mpeg3' || type === 'audio/x-mpeg') return 'audio/mpeg';
  return null;
}

/** 压成一行:状态行加服务返回的错误正文(JSON 只取 message/code/param)。 */
async function errorText(res: Response): Promise<string> {
  let raw = '';
  try { raw = await res.text(); } catch { /* 读不到就只用状态 */ }
  let detail = raw.replace(/\s+/g, ' ').trim();
  if (detail) {
    try {
      const parsed = JSON.parse(raw) as { error?: unknown };
      const error = parsed?.error;
      if (typeof error === 'string') {
        detail = error.trim() || detail;
      } else if (error && typeof error === 'object' && !Array.isArray(error)) {
        const e = error as Record<string, unknown>;
        const parts: string[] = [];
        if (typeof e.message === 'string' && e.message.trim()) parts.push(e.message.trim());
        if (typeof e.code === 'string' && e.code.trim()) parts.push(e.code.trim());
        if (typeof e.param === 'string' && e.param.trim()) parts.push(`param ${e.param.trim()}`);
        if (parts.length) detail = parts.join(' · ');
      }
    } catch { /* 非 JSON,保留原文 */ }
  }
  const status = `voice service ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
  return `${status}${detail ? `: ${detail.slice(0, 500)}` : ''}`;
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
