import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventEnvelope, ToolCallContext } from 'cortico/core/types.ts';
import { dryMountWorld } from 'cortico/extensions/dry-mount.ts';
import { VOICE_DEFAULTS, VOICE_LABEL, voiceText } from '../src/config.ts';
import { VOICE } from '../src/definition.ts';
import type { VoiceModelStyle } from '../src/types.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { fakeService, settle, testWorld, type TestWorldHandle } from './helpers/voice.ts';

const contexts: TestWorldHandle[] = [];
const hosts: FakeHost[] = [];

function make(
  patch: Parameters<typeof testWorld>[0] = {},
  deps: Parameters<typeof testWorld>[1] = {},
): TestWorldHandle {
  const handle = testWorld(patch, deps);
  contexts.push(handle);
  return handle;
}

async function started(handle: TestWorldHandle, host = new FakeHost()): Promise<FakeHost> {
  hosts.push(host);
  await handle.world.start(host);
  await settle(10);
  return host;
}

function toolOf(handle: TestWorldHandle, name: string) {
  const tool = handle.world.tools().find((t) => t.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

function style(patch: Partial<VoiceModelStyle> = {}): Partial<VoiceModelStyle> {
  return {
    voice: '',
    emotionMode: 'instruct',
    defaultEmotion: '',
    defaultInstruct: '',
    speed: 1,
    paralinguistic: 'auto',
    ...patch,
  };
}

afterEach(async () => {
  for (const handle of contexts.splice(0)) {
    await handle.world.stop().catch(() => {});
    handle.cleanup();
  }
  hosts.length = 0;
});

describe('Voice World', () => {
  it('干装载不报失败', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-dry-'));
    try {
      const report = await dryMountWorld(VOICE, { scratchDir: dir });
      expect(report.failures).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('只有 voice_speak / voice_hush,不再有 voice_style 与唱歌工具', async () => {
    const h = make();
    await started(h);
    expect(h.world.tools().map((t) => t.name)).toEqual(['voice_speak', 'voice_hush']);
  });

  it('voice_speak 在 playback=none 时只合成并回执', async () => {
    const h = make({ playback: 'none' });
    await started(h);
    const outcome = await toolOf(h, 'voice_speak').handler({ text: '**你好**呀' }, {} as ToolCallContext);
    expect(typeof outcome).toBe('object');
    expect((outcome as { text: string }).text).toContain('Synthesized one line');
    expect((outcome as { blobs?: unknown[] }).blobs).toHaveLength(1);
    expect(h.service.calls).toHaveLength(1);
    expect(h.service.calls[0]?.text).toBe('你好呀');
    expect(h.service.calls[0]?.format).toBe('wav');
    expect(h.player.plays).toEqual([]);
  });

  it('silent 的 voice_speak 不播放,但回执带音频附件', async () => {
    const h = make({ playback: 'local', shareAudio: false });
    await started(h);
    const outcome = await toolOf(h, 'voice_speak').handler({ text: '先别出声', silent: true }, {} as ToolCallContext);
    await settle(10);
    expect((outcome as { text: string }).text).toContain('without playing');
    expect((outcome as { blobs?: unknown[] }).blobs).toHaveLength(1);
    expect(h.player.plays).toEqual([]);
    expect(h.service.calls).toHaveLength(1);
  });

  it('shareAudio + local:合成一次、播放一次,不重复合成', async () => {
    const h = make({ playback: 'local', shareAudio: true });
    await started(h);
    const outcome = await toolOf(h, 'voice_speak').handler({ text: '这一句要留档' }, {} as ToolCallContext);
    await settle(10);
    expect((outcome as { text: string }).text).toContain('Said one line');
    expect((outcome as { blobs?: unknown[] }).blobs).toHaveLength(1);
    expect(h.service.calls).toHaveLength(1);
    expect(h.player.plays).toHaveLength(1);
  });

  it('服务 4xx / 5xx 时工具回失败并带上服务错误', async () => {
    for (const status of [400, 500]) {
      const h = make();
      h.service.error = new Error(`voice service ${status}: upstream failed`);
      await started(h);
      const outcome = await toolOf(h, 'voice_speak').handler({ text: '你好' }, {} as ToolCallContext) as { text: string; failed?: boolean };
      expect(outcome.failed).toBe(true);
      expect(outcome.text).toContain(`voice service ${status}`);
    }
  });

  it('World 定义、WebUI 与配置文案用同一个显示名', async () => {
    expect(VOICE.label).toBe('Kmch AI · 语音');
    expect(voiceText('zh').label).toBe('Kmch AI · 语音');
    expect(voiceText('en').label).toBe('Kmch AI · 语音');
    const h = make();
    await started(h);
    expect(h.world.webUi('zh').label).toBe('Kmch AI · 语音');
    expect(h.world.webUi('en').label).toBe('Kmch AI · 语音');
    expect(VOICE_LABEL).toBe('Kmch AI · 语音');
  });

  it('每次 defaults() 都给出独立的 modelOptions 与 modelStyles 对象', () => {
    const first = VOICE.defaults();
    const second = VOICE.defaults();
    expect(first.modelOptions).toEqual({});
    expect(first.modelOptions).not.toBe(second.modelOptions);
    expect(first.modelOptions).not.toBe(VOICE_DEFAULTS.modelOptions);
    expect(first.modelStyles).toEqual({});
    expect(first.modelStyles).not.toBe(second.modelStyles);
    expect(first.modelStyles).not.toBe(VOICE_DEFAULTS.modelStyles);
  });

  it('webUi 的服务灯在探活成功后变 online,失败时变 error', async () => {
    const ok = make();
    await started(ok);
    const okUi = ok.world.webUi('zh');
    expect(okUi.lamps?.[0]?.state).toBe('online');
    expect(okUi.config?.length).toBe(3);

    const bad = make({}, {
      service: fakeService({ healthState: { ok: false, ready: false, status: 'HTTP 503', detail: 'voice service 503: down' } }),
    });
    await started(bad);
    const badUi = bad.world.webUi('zh');
    expect(badUi.lamps?.[0]?.state).toBe('error');
    expect(badUi.lamps?.[0]?.hint).toContain('503');
  });

  it('webUi 显示服务灯、队列灯、地址/模型/音色徽标与服务页链接', async () => {
    const h = make({
      serviceUrl: 'http://127.0.0.1:9883',
      model: 'ming3-tts',
      modelStyles: { 'ming3-tts': style({ voice: '4016' }) },
    });
    await started(h);
    const ui = h.world.webUi('zh');
    expect(ui.lamps?.map((lamp) => lamp.label)).toEqual(['语音服务', '朗读队列']);
    expect(ui.badges).toEqual([
      { label: 'service', value: '127.0.0.1:9883', tone: 'plain' },
      { label: 'model', value: 'ming3-tts', tone: 'plain' },
      { label: 'voice', value: '4016', tone: 'plain' },
    ]);
    expect(ui.links).toContainEqual({ label: '服务设置', href: '#/provider/world:service' });
  });

  it('连接组不再重复模型与音色,也不再提供 x-options 目录', async () => {
    const h = make({ model: 'manual-model' });
    await started(h);
    const ui = h.world.webUi('zh');
    const connection = ui.config?.find((group) => group.id === 'world:voice-connection');
    expect(Object.keys(connection?.schema.properties ?? {})).toEqual([
      'worlds.voice.serviceUrl',
      'worlds.voice.serviceTokenSecret',
      'worlds.voice.format',
      'worlds.voice.timeoutMs',
    ]);
    expect(VOICE.configOptions).toBeUndefined();
  });

  it('没有触发组,最短/最长字数归到过滤组', async () => {
    const h = make();
    await started(h);
    const ui = h.world.webUi('zh');
    expect(ui.config?.map((group) => group.id)).toEqual([
      'world:voice-connection',
      'world:voice-filter',
      'world:voice-output',
    ]);
    const filter = ui.config?.find((group) => group.id === 'world:voice-filter');
    expect(Object.keys(filter?.schema.properties ?? {})).toEqual([
      'worlds.voice.minChars',
      'worlds.voice.maxChars',
      'worlds.voice.filterCode',
      'worlds.voice.filterUrls',
      'worlds.voice.filterMarkdown',
      'worlds.voice.filterActionTags',
      'worlds.voice.filterEmoji',
      'worlds.voice.filterSymbols',
    ]);
    expect('explicitTrigger' in VOICE_DEFAULTS).toBe(false);
    expect('explicitKeywords' in VOICE_DEFAULTS).toBe(false);
    expect('explicitWindowSec' in VOICE_DEFAULTS).toBe(false);
  });

  it('环境提示词按模型与当前情绪/标签设置生成', async () => {
    const ming = make({ model: 'ming3-tts' });
    await started(ming);
    const vars = ming.world.envPromptVars();
    expect(vars['voice.modelPrompt']).toContain('[Laughter]');
    expect(vars['voice.modelPrompt']).toContain('用 instruct');
    expect(vars['voice.style']).toContain('情绪用自然语言控制');
    expect(vars['voice.auto']).toBeUndefined();
    expect(vars['voice.emotion']).toBeUndefined();
    expect(vars['voice.instruct']).toBeUndefined();

    const categorical = make({
      model: 'ming3-tts',
      modelStyles: { 'ming3-tts': style({ emotionMode: 'categorical', defaultEmotion: '开心' }) },
    });
    await started(categorical);
    expect(categorical.world.envPromptVars()['voice.modelPrompt']).toContain('用 emotion 写一个短情绪词');
    expect(categorical.world.envPromptVars()['voice.modelPrompt']).not.toContain('用 instruct');
    expect(categorical.world.envPromptVars()['voice.style']).toContain('默认情绪是开心');

    const index = make({ model: 'index-tts2' });
    await started(index);
    expect(index.world.envPromptVars()['voice.modelPrompt']).toContain('emotion_text');
    expect(index.world.envPromptVars()['voice.modelPrompt']).toContain('这个模型不支持');

    const generic = make();
    await started(generic);
    expect(generic.world.envPromptVars()['voice.modelPrompt']).toContain('instructions');
  });

  it('通用环境提示词说明只有 voice_speak 会出声,且不再提 voice_style 或 <tts>', () => {
    const prompt = readFileSync(new URL('../src/ENV_PROMPT.md', import.meta.url), 'utf8');
    expect(prompt).not.toContain('voice_style');
    expect(prompt).not.toContain('<tts>');
    expect(prompt).toContain('只有调用 voice_speak 才会出声');
    expect(prompt).toContain('只填当前设置允许的字段');
    expect(prompt).toContain('{{voice.modelPrompt}}');
    expect(prompt).toContain('{{voice.style}}');
  });

  it('模型专属的朗读风格覆盖全局回落值,并改变环境提示词', async () => {
    const h = make({
      playback: 'none',
      model: 'ming3-tts',
      voice: 'global-voice',
      emotionMode: 'none',
      defaultEmotion: '',
      paralinguistic: 'keep',
      modelStyles: {
        'ming3-tts': style({
          voice: '4016',
          emotionMode: 'categorical',
          defaultEmotion: '开心',
          paralinguistic: 'strip',
        }),
      },
    });
    await started(h);
    expect(h.world.envPromptVars()).toMatchObject({
      'voice.voice': '4016',
    });
    expect(h.world.envPromptVars()['voice.style']).toContain('默认情绪是开心');
    expect(h.world.envPromptVars()['voice.modelPrompt']).toContain('用 emotion');
    expect(h.world.webUi('zh').badges?.find((badge) => badge.label === 'voice')?.value).toBe('4016');

    await toolOf(h, 'voice_speak').handler({ text: '[Laughter]你好' }, {} as ToolCallContext);
    expect(h.service.calls[0]?.text).toBe('你好');
    expect(h.service.calls[0]?.emotion).toBe('开心');
  });

  it('voice_hush 停声', async () => {
    const h = make({ playback: 'local' });
    await started(h);
    const out = await toolOf(h, 'voice_hush').handler({}, {} as ToolCallContext);
    expect(String(out)).toContain('stopped');
    expect(h.player.hushed).toBeGreaterThan(0);
  });

  it('不调用 voice_speak 时不会自己合成', async () => {
    const h = make({ playback: 'none' });
    await started(h);
    expect('outputTap' in h.world).toBe(false);
    await settle(10);
    expect(h.service.calls).toEqual([]);
  });

  it('instruct 模式只发 instructions,categorical 只发 emotion,basic 只发 speed', async () => {
    const instruct = make({
      playback: 'none',
      model: 'ming3-tts',
      modelStyles: { 'ming3-tts': style({ emotionMode: 'instruct', defaultEmotion: '温柔' }) },
    });
    await started(instruct);
    await toolOf(instruct, 'voice_speak').handler({ text: '甲' }, {} as ToolCallContext);
    expect(instruct.service.calls[0]?.instruct).toBe('用情绪是温柔的语气朗读。');
    expect(instruct.service.calls[0]?.emotion).toBeUndefined();
    expect(instruct.service.calls[0]?.speed).toBeUndefined();

    const categorical = make({
      playback: 'none',
      model: 'ming3-tts',
      modelStyles: { 'ming3-tts': style({ emotionMode: 'categorical', defaultEmotion: '害羞' }) },
    });
    await started(categorical);
    await toolOf(categorical, 'voice_speak').handler({ text: '乙' }, {} as ToolCallContext);
    expect(categorical.service.calls[0]?.emotion).toBe('害羞');
    expect(categorical.service.calls[0]?.instruct).toBeUndefined();
    expect(categorical.service.calls[0]?.speed).toBeUndefined();

    const basic = make({
      playback: 'none',
      model: 'ming3-tts',
      modelStyles: { 'ming3-tts': style({ emotionMode: 'basic', speed: 1.4 }) },
    });
    await started(basic);
    await toolOf(basic, 'voice_speak').handler({ text: '丙' }, {} as ToolCallContext);
    expect(basic.service.calls[0]?.speed).toBe(1.4);
    expect(basic.service.calls[0]?.emotion).toBeUndefined();
    expect(basic.service.calls[0]?.instruct).toBeUndefined();
  });

  it('未知模型按 OpenAI 兼容处理,categorical 不发 emotion', async () => {
    const h = make({
      playback: 'none',
      model: 'qwen-tts',
      modelStyles: { 'qwen-tts': style({ emotionMode: 'categorical', defaultEmotion: '开心' }) },
    });
    await started(h);
    await toolOf(h, 'voice_speak').handler({ text: '你好', emotion: '温柔' }, {} as ToolCallContext);
    expect(h.service.calls[0]?.emotion).toBeUndefined();
    expect(h.service.calls[0]?.instruct).toBeUndefined();
    expect(h.service.calls[0]?.speed).toBeUndefined();
  });

  it('IndexTTS2 的 basic 模式不发独立 speed,与提示词一致', async () => {
    const h = make({
      playback: 'none',
      model: 'index-tts2',
      modelStyles: { 'index-tts2': style({ emotionMode: 'basic', speed: 0.7 }) },
    });
    await started(h);
    await toolOf(h, 'voice_speak').handler({ text: '你好' }, {} as ToolCallContext);
    expect(h.service.calls[0]?.speed).toBeUndefined();
    expect(h.service.calls[0]?.emotion).toBeUndefined();
    expect(h.service.calls[0]?.instruct).toBeUndefined();
  });

  it('tags / none 模式不发风格参数', async () => {
    for (const emotionMode of ['tags', 'none'] as const) {
      const h = make({
        playback: 'none',
        model: 'ming3-tts',
        modelStyles: { 'ming3-tts': style({ emotionMode, defaultEmotion: '开心', speed: 1.3 }) },
      });
      await started(h);
      await toolOf(h, 'voice_speak').handler({ text: '你好' }, {} as ToolCallContext);
      expect(h.service.calls[0]?.emotion).toBeUndefined();
      expect(h.service.calls[0]?.instruct).toBeUndefined();
      expect(h.service.calls[0]?.speed).toBeUndefined();
      expect(h.service.calls[0]?.format).toBe('wav');
    }
  });

  it('事件不投给模型:tts.voice 带 deliver:false', async () => {
    const h = make({ playback: 'event' });
    const host = await started(h);
    await toolOf(h, 'voice_speak').handler({ text: '你好' }, {} as ToolCallContext);
    await settle(10);
    const voiceEvent = host.events.find((e: EventEnvelope) => e.type === 'tts.voice');
    expect(voiceEvent).toBeTruthy();
    expect(host.pushOpts[host.events.indexOf(voiceEvent!)]).toEqual({ deliver: false });
  });
});
