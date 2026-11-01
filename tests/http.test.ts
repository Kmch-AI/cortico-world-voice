import { afterEach, describe, expect, it } from 'vitest';
import { startVoiceHttp, type VoiceHttpDeps, type VoiceHttpHandle } from '../src/http.ts';
import { quietLogger, wavBytes } from './helpers/voice.ts';

let handle: VoiceHttpHandle | null = null;
afterEach(async () => { await handle?.close(); handle = null; });

function deps(patch: Partial<VoiceHttpDeps> = {}): VoiceHttpDeps {
  return {
    token: () => '',
    status: () => ({
      ready: true, state: 'ready', backend: 'audiocpp', model: 'ming3-tts', voice: '4016', queue: 0, sing: false,
    }),
    synthesize: async () => ({ bytes: wavBytes(1), mime: 'audio/wav', seconds: 1 }),
    sing: async () => ({ bytes: wavBytes(2), mime: 'audio/wav', seconds: 2 }),
    voices: async () => [{ value: '4016', label: '4016' }],
    log: quietLogger,
    ...patch,
  };
}

describe('本地语音接口', () => {
  it('健康、模型与音色', async () => {
    handle = await startVoiceHttp({ port: 0, deps: deps() });
    const base = `http://127.0.0.1:${handle.port}`;
    const health = await (await fetch(`${base}/health`)).json() as Record<string, unknown>;
    expect(health.ready).toBe(true);
    expect(health.backend).toBe('audiocpp');
    const models = await (await fetch(`${base}/v1/models`)).json() as { data: Array<{ id: string }> };
    expect(models.data[0]?.id).toBe('ming3-tts');
    const voices = await (await fetch(`${base}/v1/audio/voices`)).json() as { voices: string[] };
    expect(voices.voices).toEqual(['4016']);
  });

  it('合成返回音频字节,参数透传', async () => {
    const seen: Array<Record<string, unknown>> = [];
    handle = await startVoiceHttp({
      port: 0,
      deps: deps({
        synthesize: async ({ request }) => {
          seen.push(request as unknown as Record<string, unknown>);
          return { bytes: wavBytes(1), mime: 'audio/wav', seconds: 1 };
        },
      }),
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: '你好', voice: 'v2', emotion: '开心', instructions: '轻声', speed: 0.9, response_format: 'wav' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect((await res.arrayBuffer()).byteLength).toBe(wavBytes(1).length);
    expect(seen[0]).toMatchObject({ text: '你好', voice: 'v2', emotion: '开心', instruct: '轻声', speed: 0.9, format: 'wav' });
  });

  it('令牌不对回 401', async () => {
    handle = await startVoiceHttp({ port: 0, deps: deps({ token: () => 'secret' }) });
    const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect(res.status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${handle.port}/health`, { headers: { authorization: 'Bearer secret' } });
    expect(ok.status).toBe(200);
  });

  it('没有唱歌服务时回 503', async () => {
    handle = await startVoiceHttp({ port: 0, deps: deps() });
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/audio/sing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lyrics: '啦啦啦' }),
    });
    expect(res.status).toBe(503);
  });

  it('唱歌服务可用时返回音频', async () => {
    handle = await startVoiceHttp({
      port: 0,
      deps: deps({
        status: () => ({ ready: true, state: 'ready', backend: 'custom', model: '', voice: '', queue: 0, sing: true }),
      }),
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/audio/sing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lyrics: '啦啦啦' }),
    });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(wavBytes(2).length);
  });

  it('缺 input 回 400', async () => {
    handle = await startVoiceHttp({ port: 0, deps: deps() });
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice: 'v' }),
    });
    expect(res.status).toBe(400);
  });
});
