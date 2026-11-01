/**
 * 本地语音接口。给 QQ 插件、唱歌插件、脚本用;只监听 127.0.0.1。
 * 形状尽量贴近 OpenAI:`/v1/audio/speech`、`/v1/models`、`/v1/audio/voices`。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from 'cortico/core/types.ts';
import type { AudioFormat, TtsAudio, TtsRequest, VoiceOption } from './types.ts';

const BODY_MAX = 1024 * 1024;

export interface VoiceHttpStatus {
  ready: boolean;
  state: string;
  backend: string;
  model: string;
  voice: string;
  queue: number;
  sing: boolean;
}

export interface VoiceHttpSpeech {
  request: TtsRequest;
  /** 请求方要求本机播放。 */
  play: boolean;
}

export interface VoiceHttpDeps {
  token(): string;
  status(): VoiceHttpStatus;
  synthesize(req: VoiceHttpSpeech, signal: AbortSignal): Promise<TtsAudio>;
  sing(lyrics: string, signal: AbortSignal): Promise<TtsAudio>;
  voices(): Promise<VoiceOption[]>;
  log: Logger;
}

export interface VoiceHttpHandle {
  port: number;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (b: Buffer) => {
      size += b.length;
      if (size > BODY_MAX) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
      parts.push(b);
    });
    req.on('end', () => {
      if (parts.length === 0) { resolve({}); return; }
      try {
        const parsed = JSON.parse(Buffer.concat(parts).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new HttpError(400, 'body must be a JSON object'));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, 'body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

const asText = (v: unknown, max = 8000): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

const asNumber = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

function formatOf(v: unknown): AudioFormat {
  return v === 'mp3' ? 'mp3' : 'wav';
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function writeAudio(res: ServerResponse, audio: TtsAudio): void {
  res.writeHead(200, {
    'content-type': audio.mime,
    'content-length': audio.bytes.length,
    ...(audio.seconds ? { 'x-voice-seconds': audio.seconds.toFixed(2) } : {}),
  });
  res.end(Buffer.from(audio.bytes));
}

/** 起接口;`port` 为 0 时由系统分配。 */
export function startVoiceHttp(opts: { port: number; host?: string; deps: VoiceHttpDeps }): Promise<VoiceHttpHandle> {
  const { deps } = opts;

  const authorized = (req: IncomingMessage, url: URL): boolean => {
    const token = deps.token().trim();
    if (!token) return true;
    if ((req.headers.authorization ?? '') === `Bearer ${token}`) return true;
    return url.searchParams.get('token') === token;
  };

  const speech = async (res: ServerResponse, body: Record<string, unknown>): Promise<void> => {
    const text = asText(body.input) || asText(body.text);
    if (!text) throw new HttpError(400, 'missing input');
    const request: TtsRequest = {
      text,
      format: formatOf(body.response_format ?? body.format),
      ...(asText(body.voice, 200) ? { voice: asText(body.voice, 200) } : {}),
      ...(asText(body.emotion, 200) ? { emotion: asText(body.emotion, 200) } : {}),
      ...((asText(body.instruct, 2000) || asText(body.instructions, 2000))
        ? { instruct: asText(body.instruct, 2000) || asText(body.instructions, 2000) }
        : {}),
      ...(asNumber(body.speed) !== undefined ? { speed: asNumber(body.speed) } : {}),
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), 180_000);
    try {
      const audio = await deps.synthesize({ request, play: body.play === true }, ctrl.signal);
      writeAudio(res, audio);
    } finally {
      clearTimeout(timer);
    }
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!authorized(req, url)) { writeJson(res, 401, { error: 'bad token' }); return; }
    void (async () => {
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
        writeJson(res, 200, deps.status());
        return;
      }
      if (req.method === 'GET' && /\/models\/?$/.test(url.pathname)) {
        const status = deps.status();
        writeJson(res, 200, {
          object: 'list',
          data: status.model ? [{ id: status.model, object: 'model', owned_by: 'cortico-world-voice' }] : [],
        });
        return;
      }
      if (req.method === 'GET' && /\/audio\/voices\/?$/.test(url.pathname)) {
        const voices = await deps.voices();
        writeJson(res, 200, { voices: voices.map((v) => v.value), data: voices });
        return;
      }
      if (req.method === 'POST' && /\/audio\/speech\/?$/.test(url.pathname)) {
        await speech(res, await readJson(req));
        return;
      }
      if (req.method === 'POST' && /\/audio\/sing\/?$/.test(url.pathname)) {
        if (!deps.status().sing) throw new HttpError(503, 'no singing service configured');
        const body = await readJson(req);
        const lyrics = asText(body.lyrics, 2000);
        if (!lyrics) throw new HttpError(400, 'missing lyrics');
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(new Error('timeout')), 300_000);
        try {
          writeAudio(res, await deps.sing(lyrics, ctrl.signal));
        } finally {
          clearTimeout(timer);
        }
        return;
      }
      writeJson(res, 404, { error: `no such route: ${req.method} ${url.pathname}` });
    })().catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 502;
      const message = error instanceof Error ? error.message : String(error);
      deps.log.warn('本地语音接口失败', { path: url.pathname, status, err: message });
      if (!res.headersSent) writeJson(res, status, { error: message });
      else res.end();
    });
  };

  return new Promise<VoiceHttpHandle>((resolve, reject) => {
    let server: Server;
    try {
      server = createServer(handler);
    } catch (error) {
      reject(error);
      return;
    }
    server.on('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : opts.port;
      resolve({
        port,
        close: () => new Promise<void>((done) => {
          server.close(() => done());
          server.closeAllConnections();
        }),
      });
    });
  });
}
