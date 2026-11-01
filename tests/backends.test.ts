import { describe, expect, it } from 'vitest';
import { audiocppBackend } from '../src/backends/audiocpp.ts';
import { customBackend } from '../src/backends/custom.ts';
import { apiUrl, wavSeconds } from '../src/backends/http.ts';
import { openaiBackend } from '../src/backends/openai.ts';
import { VOICE_DEFAULTS } from '../src/config.ts';
import type { BackendContext, VoiceConfigSection } from '../src/types.ts';
import { quietLogger, wavBytes } from './helpers/voice.ts';

interface Recorded {
  url: string;
  init: RequestInit;
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function context(patch: Partial<VoiceConfigSection>, fetchImpl: typeof fetch): BackendContext {
  return {
    cfg: { ...VOICE_DEFAULTS, ...patch },
    secret: (name) => (name === 'VOICE_KEY' ? 'sk-test' : ''),
    fetch: fetchImpl,
    log: quietLogger,
  };
}

const audioResponse = (): Response => new Response(wavBytes(1), { status: 200, headers: { 'content-type': 'audio/wav' } });

describe('apiUrl', () => {
  it('带不带 /v1 都拼出同一个接口', () => {
    expect(apiUrl('http://127.0.0.1:8000', '/audio/speech')).toBe('http://127.0.0.1:8000/v1/audio/speech');
    expect(apiUrl('http://127.0.0.1:8000/v1/', '/audio/speech')).toBe('http://127.0.0.1:8000/v1/audio/speech');
  });
});

describe('openai backend', () => {
  it('请求体带模型、文本、音色与指令,密钥进 Authorization', async () => {
    const { fetch, calls } = fakeFetch(() => audioResponse());
    const ctx = context({ apiKeySecret: 'VOICE_KEY', defaultInstruct: '轻声说话', voice: '' }, fetch);
    const audio = await openaiBackend.synthesize({ text: '你好', format: 'wav' }, ctx);
    expect(audio.mime).toBe('audio/wav');
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(calls[0]!.url).toBe('http://127.0.0.1:8000/v1/audio/speech');
    expect(body).toMatchObject({ input: '你好', response_format: 'wav', voice: 'alloy', instructions: '轻声说话。' });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('非音频回应报错并带正文', async () => {
    const { fetch } = fakeFetch(() => new Response('{"error":"bad"}', { status: 400, headers: { 'content-type': 'application/json' } }));
    await expect(openaiBackend.synthesize({ text: '你好', format: 'wav' }, context({}, fetch)))
      .rejects.toThrow(/TTS API 400/);
  });
});

describe('audiocpp backend', () => {
  it('instruct 模式发 freeform 模板', async () => {
    const { fetch, calls } = fakeFetch(() => audioResponse());
    const ctx = context({ emotionMode: 'instruct', defaultEmotion: '温柔' }, fetch);
    await audiocppBackend.synthesize({ text: '你好', format: 'wav' }, ctx);
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.options).toEqual({ template_name: 'freeform', instruct: '用情绪是温柔的语气朗读。' });
  });

  it('categorical 模式只发情绪标签', async () => {
    const { fetch, calls } = fakeFetch(() => audioResponse());
    const ctx = context({ emotionMode: 'categorical', defaultEmotion: '害羞' }, fetch);
    await audiocppBackend.synthesize({ text: '你好', format: 'wav' }, ctx);
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.options).toEqual({ template_name: 'emotion', emotion: '害羞' });
  });

  it('basic 模式把语速折成三档', async () => {
    const { fetch, calls } = fakeFetch(() => audioResponse());
    const ctx = context({ emotionMode: 'basic', speed: 1.4 }, fetch);
    await audiocppBackend.synthesize({ text: '你好', format: 'wav' }, ctx);
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.options).toEqual({ template_name: 'basic', speed: '快速', pitch: '中', volume: '中' });
  });

  it('读音色列表', async () => {
    const { fetch } = fakeFetch(() => new Response(JSON.stringify({ voices: ['4016', { id: 'v2', label: '二号' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const voices = await audiocppBackend.listVoices(context({ model: 'ming3-tts' }, fetch));
    expect(voices).toEqual([{ value: '4016', label: '4016' }, { value: 'v2', label: '二号' }]);
  });
});

describe('custom backend', () => {
  it('请求体模板替换文本与情绪,请求头替换密钥', async () => {
    const { fetch, calls } = fakeFetch(() => audioResponse());
    const ctx = context({
      customUrl: 'http://127.0.0.1:9999/tts',
      apiKeySecret: 'VOICE_KEY',
      customHeaders: '{"X-Key":"${KEY}"}',
      customBody: '{"text":"{{text}}","emotion":"{{emotion}}","speed":{{speed}}}',
    }, fetch);
    await customBackend.synthesize({ text: '他说"你好"', emotion: '开心', format: 'wav' }, ctx);
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body).toEqual({ text: '他说"你好"', emotion: '开心', speed: 1 });
    expect((calls[0]!.init.headers as Record<string, string>)['X-Key']).toBe('sk-test');
  });

  it('base64 回应解码成音频', async () => {
    const b64 = Buffer.from(wavBytes(1)).toString('base64');
    const { fetch } = fakeFetch(() => new Response(JSON.stringify({ data: { audio: b64 } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const ctx = context({
      customUrl: 'http://127.0.0.1:9999/tts',
      customResponse: 'base64',
      customAudioPath: 'data.audio',
    }, fetch);
    const audio = await customBackend.synthesize({ text: '你好', format: 'wav' }, ctx);
    expect(audio.bytes.length).toBe(wavBytes(1).length);
  });

  it('空的 customUrl 明确报错', async () => {
    const { fetch } = fakeFetch(() => audioResponse());
    await expect(customBackend.synthesize({ text: '你好', format: 'wav' }, context({}, fetch)))
      .rejects.toThrow(/customUrl is empty/);
  });
});

describe('wavSeconds', () => {
  it('从 RIFF 头算时长', () => {
    expect(wavSeconds(wavBytes(2))).toBeCloseTo(2, 5);
  });

  it('不是 wav 时返回 undefined', () => {
    expect(wavSeconds(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});
