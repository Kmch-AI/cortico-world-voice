import { describe, expect, it } from 'vitest';
import { VOICE_DEFAULTS } from '../src/config.ts';
import { ServiceClient } from '../src/service.ts';
import type { VoiceConfigSection } from '../src/types.ts';
import { wavBytes } from './helpers/voice.ts';

interface Recorded {
  url: string;
  init: RequestInit;
}

function fakeFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function makeClient(
  patch: Partial<VoiceConfigSection> = {},
  fetchImpl: typeof fetch = fakeFetch(() => audioResponse()).fetch,
  secretValue = '',
): { client: ServiceClient; cfg: VoiceConfigSection } {
  const cfg: VoiceConfigSection = { ...VOICE_DEFAULTS, ...patch };
  return {
    cfg,
    client: new ServiceClient({
      fetch: fetchImpl,
      secret: (name) => (name === 'VOICE_TOKEN' ? secretValue : ''),
      cfg: () => cfg,
    }),
  };
}

const audioResponse = (): Response => new Response(wavBytes(1), {
  status: 200,
  headers: { 'content-type': 'audio/wav' },
});

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

describe('ServiceClient.synthesize', () => {
  it('带模型、音色、格式与语义字段,令牌进 Authorization', async () => {
    const { fetch, calls } = fakeFetch(() => audioResponse());
    const { client } = makeClient({
      serviceTokenSecret: 'VOICE_TOKEN',
      model: 'ming3-tts',
      voice: '4016',
    }, fetch, 'sk-test');

    const audio = await client.synthesize({
      text: '你好',
      format: 'wav',
      instruct: '轻声说话',
      emotion: '开心',
      speed: 0.9,
    });

    expect(calls[0]?.url).toBe('http://127.0.0.1:9883/v1/audio/speech');
    expect(calls[0]?.init.method).toBe('POST');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      input: '你好',
      response_format: 'wav',
      model: 'ming3-tts',
      voice: '4016',
      instructions: '轻声说话',
      emotion: '开心',
      speed: 0.9,
    });
    expect(audio.mime).toBe('audio/wav');
    expect(audio.seconds).toBeCloseTo(1, 5);
  });

  it('只带当前模型的 options,其他模型的参数不混入', async () => {
    const { fetch, calls } = fakeFetch(() => audioResponse());
    const { client } = makeClient({
      model: 'index-tts2',
      modelOptions: {
        'index-tts2': { emotion_alpha: 1.2, temperature: 0.7 },
        'ming3-tts': { template_name: 'freeform' },
      },
    }, fetch);

    await client.synthesize({ text: '你好', format: 'wav' });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      input: '你好',
      response_format: 'wav',
      model: 'index-tts2',
      options: { emotion_alpha: 1.2, temperature: 0.7 },
    });
  });

  it('当前模型没有参数或参数为空时不发 options', async () => {
    const cases: Array<Record<string, Record<string, unknown>>> = [
      {},
      { 'ming3-tts': { template_name: 'freeform' } },
      { 'index-tts2': {} },
    ];
    for (const modelOptions of cases) {
      const { fetch, calls } = fakeFetch(() => audioResponse());
      const { client } = makeClient({ model: 'index-tts2', modelOptions }, fetch);
      await client.synthesize({ text: '你好', format: 'wav' });
      expect(JSON.parse(String(calls[0]?.init.body)).options).toBeUndefined();
    }
  });

  it('没有配置令牌时不发 Authorization', async () => {
    const { fetch, calls } = fakeFetch(() => audioResponse());
    const { client } = makeClient({}, fetch);
    await client.synthesize({ text: '你好', format: 'wav' });
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('4xx / 5xx 解析服务错误正文', async () => {
    const { fetch } = fakeFetch(() => jsonResponse({
      error: {
        message: 'input too long', type: 'invalid_request_error', code: 'invalid_value', param: 'input',
      },
    }, 400));
    const { client } = makeClient({}, fetch);
    await expect(client.synthesize({ text: '你好', format: 'wav' }))
      .rejects.toThrow('voice service 400: input too long · invalid_value · param input');

    const { fetch: failing } = fakeFetch(() => new Response('boom', { status: 500 }));
    const { client: failingClient } = makeClient({}, failing);
    await expect(failingClient.synthesize({ text: '你好', format: 'wav' }))
      .rejects.toThrow(/voice service 500: boom/);
  });

  it('接受 wav / mpeg / octet-stream,拒绝其他 MIME', async () => {
    const octet = fakeFetch(() => new Response(wavBytes(1), {
      status: 200, headers: { 'content-type': 'application/octet-stream' },
    }));
    const { client: mp3Client } = makeClient({ format: 'mp3' }, octet.fetch);
    expect((await mp3Client.synthesize({ text: '你好', format: 'mp3' })).mime).toBe('audio/mpeg');

    const xwav = fakeFetch(() => new Response(wavBytes(1), {
      status: 200, headers: { 'content-type': 'audio/x-wav' },
    }));
    const { client: wavClient } = makeClient({}, xwav.fetch);
    expect((await wavClient.synthesize({ text: '你好', format: 'wav' })).mime).toBe('audio/wav');

    const html = fakeFetch(() => new Response('<html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    }));
    const { client: htmlClient } = makeClient({}, html.fetch);
    await expect(htmlClient.synthesize({ text: '你好', format: 'wav' }))
      .rejects.toThrow(/text\/html instead of audio/);

    const empty = fakeFetch(() => new Response(new Uint8Array(), {
      status: 200, headers: { 'content-type': 'audio/wav' },
    }));
    const { client: emptyClient } = makeClient({}, empty.fetch);
    await expect(emptyClient.synthesize({ text: '你好', format: 'wav' }))
      .rejects.toThrow(/empty audio body/);
  });

  it('超时会中止请求并报超时', async () => {
    const { fetch } = fakeFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const { client } = makeClient({ timeoutMs: 20 }, fetch);
    await expect(client.synthesize({ text: '你好', format: 'wav' }))
      .rejects.toThrow(/voice service timed out after 20 ms/);
  });

  it('回应体读不完也受同一个超时约束', async () => {
    const { fetch } = fakeFetch(() => new Response(new ReadableStream({
      start() { /* 有响应头但正文永远不来 */ },
    }), { status: 200, headers: { 'content-type': 'audio/wav' } }));
    const { client } = makeClient({ timeoutMs: 20 }, fetch);
    await expect(client.synthesize({ text: '你好', format: 'wav' }))
      .rejects.toThrow(/voice service timed out after 20 ms/);
  });
});

describe('ServiceClient 目录与健康', () => {
  it('health 汇总状态与模型数', async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ status: 'ok', ready: true, models: 2 }));
    const { client } = makeClient({}, fetch);
    expect(await client.health()).toEqual({
      ok: true, ready: true, status: 'ok', models: 2, detail: 'ok · 2 models',
    });
  });

  it('health 连不上时返回 ok:false 而不抛错', async () => {
    const { fetch } = fakeFetch(() => { throw new Error('connect ECONNREFUSED'); });
    const { client } = makeClient({}, fetch);
    const health = await client.health();
    expect(health.ok).toBe(false);
    expect(health.ready).toBe(false);
    expect(health.detail).toContain('ECONNREFUSED');
  });

  it('models 读 OpenAI 形状的列表,带音色与参数元数据', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({
      object: 'list',
      data: [
        {
          id: 'ming3-tts',
          object: 'model',
          owned_by: 'service',
          display_name: 'Ming 3.0',
          voices: ['4016', { value: '4017' }],
          parameters: [
            {
              name: 'template_name', type: 'enum', description: 'Template.',
              values: ['tts', 'basic'], default: 'tts',
            },
            { name: 'seed', type: 'int', min: 0, max: 4294967295 },
            { name: 'broken', type: 'mystery' },
          ],
        },
        { id: 'qwen-tts', object: 'model', owned_by: 'service' },
        { object: 'model' },
        'not-a-model',
      ],
    }));
    const { client } = makeClient({ serviceUrl: 'http://127.0.0.1:9883/v1/' }, fetch);
    expect(await client.models()).toEqual([
      {
        id: 'ming3-tts',
        label: 'Ming 3.0',
        voices: ['4016', '4017'],
        parameters: [
          {
            name: 'template_name', type: 'enum', description: 'Template.',
            values: ['tts', 'basic'], default: 'tts',
          },
          { name: 'seed', type: 'int', min: 0, max: 4294967295 },
        ],
      },
      { id: 'qwen-tts', voices: [] },
    ]);
    expect(calls[0]?.url).toBe('http://127.0.0.1:9883/v1/models');
  });

  it('voices 带上模型查询并读 data / voices', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({
      object: 'list',
      model: 'ming3-tts',
      voices: ['4016'],
      data: [{ id: '4016', value: '4016', label: '默认音色', model: 'ming3-tts', service: 'audiocpp' }],
    }));
    const { client } = makeClient({ model: 'ming3-tts' }, fetch);
    expect(await client.voices()).toEqual([{ value: '4016', label: '默认音色' }]);
    expect(calls[0]?.url).toBe('http://127.0.0.1:9883/v1/audio/voices?model=ming3-tts');
  });
});
