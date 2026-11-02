import { afterEach, describe, expect, it } from 'vitest';
import { modelPrompt } from '../src/models.ts';
import type { PanelModelState } from '../src/panel.ts';
import { testWorld, type TestWorldHandle } from './helpers/voice.ts';

const contexts: TestWorldHandle[] = [];

function make(patch: Parameters<typeof testWorld>[0] = {}): TestWorldHandle {
  const handle = testWorld(patch);
  contexts.push(handle);
  return handle;
}

function invokeOf(handle: TestWorldHandle) {
  const invoke = handle.world.webUi('zh').invoke;
  if (!invoke) throw new Error('missing panel invoke');
  return invoke;
}

afterEach(async () => {
  for (const handle of contexts.splice(0)) {
    await handle.world.stop().catch(() => {});
    handle.cleanup();
  }
});

describe('模型面板', () => {
  it('声明 model 面板,title 为「模型」,state 可走 GET', () => {
    const h = make();
    expect(h.world.webUi('zh').panels).toEqual([
      { id: 'model', title: '模型', getMethods: ['state'] },
    ]);
  });

  it('state 首次读取目录,再读直接用缓存', async () => {
    const h = make();
    const invoke = invokeOf(h);
    const first = await invoke('model', 'state', []) as PanelModelState;
    expect(first).toMatchObject({
      model: '',
      voice: '',
      prompt: modelPrompt(''),
      options: {},
      style: {
        voice: '',
        emotionMode: 'instruct',
        defaultEmotion: '',
        defaultInstruct: '',
        speed: 1,
        paralinguistic: 'auto',
      },
      models: h.service.modelList,
      prompts: { 'ming3-tts': modelPrompt('ming3-tts') },
      settings: {
        'ming3-tts': {
          voice: '',
          style: { emotionMode: 'instruct', speed: 1 },
          options: {},
        },
      },
    });
    expect(h.service.modelCalls).toBe(1);
    expect(h.service.voiceCalls).toBe(1);
    expect(h.service.voiceModels).toEqual(['ming3-tts']);

    await invoke('model', 'state', []);
    expect(h.service.modelCalls).toBe(1);
    expect(h.service.voiceCalls).toBe(1);
  });

  it('save 写回模型、音色与当前模型的参数', async () => {
    const h = make({ model: 'ming3-tts', voice: 'legacy' });
    const invoke = invokeOf(h);
    const saved = await invoke('model', 'save', [{
      model: ' index-tts2 ',
      voice: ' 4016 ',
      options: { emotion_alpha: 1.2, use_emotion_text: true },
    }]) as PanelModelState;

    expect(h.cfg.model).toBe('index-tts2');
    expect(h.cfg.voice).toBe('legacy');
    expect(h.cfg.modelStyles?.['index-tts2']).toMatchObject({
      voice: '4016',
      emotionMode: 'instruct',
      defaultEmotion: '',
      defaultInstruct: '',
      speed: 1,
      paralinguistic: 'auto',
    });
    expect(h.cfg.modelOptions).toEqual({
      'index-tts2': { emotion_alpha: 1.2, use_emotion_text: true },
    });
    expect(saved.model).toBe('index-tts2');
    expect(saved.voice).toBe('4016');
    expect(saved.prompt).toBe(modelPrompt('index-tts2'));
    expect(saved.prompt).toContain('emotion_text');
    expect(saved.options).toEqual({ emotion_alpha: 1.2, use_emotion_text: true });
  });

  it('save 把朗读风格按模型保存,并回读每个模型的设置', async () => {
    const h = make({ model: 'ming3-tts', modelStyles: { 'index-tts2': { speed: 1.4 } } });
    const invoke = invokeOf(h);
    const saved = await invoke('model', 'save', [{
      model: 'ming3-tts',
      voice: '4016',
      style: {
        emotionMode: 'categorical',
        defaultEmotion: '温柔',
        defaultInstruct: '像在耳边说话',
        speed: 0.9,
        paralinguistic: 'strip',
      },
      options: { seed: 7 },
    }]) as PanelModelState;

    expect(saved.style).toEqual({
      voice: '4016',
      emotionMode: 'categorical',
      defaultEmotion: '温柔',
      defaultInstruct: '像在耳边说话',
      speed: 0.9,
      paralinguistic: 'strip',
    });
    expect(saved.settings['ming3-tts']).toEqual({
      voice: '4016',
      style: saved.style,
      options: { seed: 7 },
    });
    expect(saved.settings['index-tts2']).toMatchObject({
      style: { voice: '', speed: 1.4, emotionMode: 'instruct' },
      options: {},
    });
  });

  it('save 校验朗读风格字段', async () => {
    const h = make({ model: 'ming3-tts' });
    const invoke = invokeOf(h);
    await expect(invoke('model', 'save', [{
      model: 'ming3-tts', voice: '', options: {}, style: { emotionMode: 'loud' },
    }])).rejects.toThrow();
    await expect(invoke('model', 'save', [{
      model: 'ming3-tts', voice: '', options: {}, style: { paralinguistic: 'maybe' },
    }])).rejects.toThrow();
    await expect(invoke('model', 'save', [{
      model: 'ming3-tts', voice: '', options: {}, style: { speed: 'fast' },
    }])).rejects.toThrow();
  });

  it('空 options 删掉该模型的条目', async () => {
    const h = make({
      modelOptions: {
        'index-tts2': { top_k: 30 },
        'ming3-tts': { template_name: 'freeform' },
      },
    });
    const invoke = invokeOf(h);

    await invoke('model', 'save', [{ model: 'index-tts2', voice: '4016', options: {} }]);
    expect(h.cfg.modelOptions).toEqual({ 'ming3-tts': { template_name: 'freeform' } });

    await invoke('model', 'save', [{ model: 'ming3-tts', voice: '4016', options: {} }]);
    expect(h.cfg.modelOptions).toEqual({});
  });

  it('save 校验字符串与普通对象', async () => {
    const h = make();
    const invoke = invokeOf(h);
    await expect(invoke('model', 'save', [])).rejects.toThrow();
    await expect(invoke('model', 'save', [{ model: '', voice: '', options: {} }])).rejects.toThrow();
    await expect(invoke('model', 'save', [{ model: 'm', voice: 1, options: {} }])).rejects.toThrow();
    await expect(invoke('model', 'save', [{ model: 'm', voice: '', options: [1] }])).rejects.toThrow();
  });

  it('refresh 失败时保留上一次目录并带回错误', async () => {
    const h = make({ model: 'ming3-tts' });
    const invoke = invokeOf(h);
    const first = await invoke('model', 'state', []) as PanelModelState;
    expect(first.models).toHaveLength(1);

    h.service.catalogError = new Error('connect ECONNREFUSED 127.0.0.1:9883');
    const refreshed = await invoke('model', 'refresh', []) as PanelModelState;
    expect(refreshed.models).toEqual(first.models);
    expect(refreshed.error).toContain('ECONNREFUSED');
    expect(refreshed.model).toBe('ming3-tts');

    const cached = await invoke('model', 'state', []) as PanelModelState;
    expect(cached.models).toEqual(first.models);
    expect(cached.error).toContain('ECONNREFUSED');
  });

  it('/v1/models 成功而音色表失败时,模型与参数仍来自模型表', async () => {
    const h = make({ model: 'ming3-tts' });
    h.service.voices = async () => { throw new Error('voices endpoint down'); };
    const state = await invokeOf(h)('model', 'state', []) as PanelModelState;

    expect(state.models).toEqual(h.service.modelList);
    expect(state.models[0]?.parameters?.map((parameter) => parameter.name))
      .toEqual(['template_name', 'seed']);
    expect(state.error).toBeUndefined();
  });

  it('refresh 重取模型表,并用当前模型补音色表', async () => {
    const h = make({ model: 'ming3-tts' });
    const invoke = invokeOf(h);
    await invoke('model', 'state', []);

    h.service.modelList = [
      { id: 'ming3-tts', label: 'Ming 3.0', voices: ['4016'] },
      { id: 'index-tts2', label: 'IndexTTS2', voices: ['v2'] },
    ];
    h.service.voiceList = [
      { value: '4016', label: '4016' },
      { value: '4017', label: '4017' },
    ];
    const refreshed = await invoke('model', 'refresh', []) as PanelModelState;
    expect(refreshed.models.map((model) => model.voices)).toEqual([['4016', '4017'], ['v2']]);
    expect(h.service.modelCalls).toBe(2);
    expect(h.service.voiceModels).toEqual(['ming3-tts', 'ming3-tts']);
  });

  it('目录错误不回显服务地址', async () => {
    const h = make({ serviceUrl: 'http://127.0.0.1:9883', model: 'ming3-tts' });
    h.service.catalogError = new Error('cannot reach http://127.0.0.1:9883/v1/models');
    const state = await invokeOf(h)('model', 'refresh', []) as PanelModelState;
    expect(state.error).not.toContain('http://127.0.0.1:9883');
    expect(state.error).toContain('[service]');
  });

  it('state 不带出服务地址与令牌', async () => {
    const h = make({
      serviceUrl: 'http://127.0.0.1:9883',
      serviceTokenSecret: 'VOICE_TOKEN',
    });
    const state = await invokeOf(h)('model', 'state', []) as PanelModelState;
    const text = JSON.stringify(state);
    expect(text).not.toContain('127.0.0.1:9883');
    expect(text).not.toContain('VOICE_TOKEN');
    expect(state).not.toHaveProperty('serviceUrl');
    expect(state).not.toHaveProperty('serviceTokenSecret');
  });

  it('未知面板与未知方法报错', async () => {
    const h = make();
    const invoke = invokeOf(h);
    await expect(invoke('other', 'state', [])).rejects.toThrow();
    await expect(invoke('model', 'nope', [])).rejects.toThrow();
  });
});
