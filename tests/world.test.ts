import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventEnvelope, ToolCallContext } from 'cortico/core/types.ts';
import { dryMountWorld } from 'cortico/extensions/dry-mount.ts';
import type { StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import { VOICE_DEFAULTS, VOICE_LABEL, voiceText } from '../src/config.ts';
import { VOICE } from '../src/definition.ts';
import { modelPrompt } from '../src/models.ts';
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

function event(patch: Record<string, unknown>): StreamEvent {
  return { type: 'x', ...patch } as unknown as StreamEvent;
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

  it('只有 voice_speak / voice_hush / voice_style,不再有唱歌工具', async () => {
    const h = make();
    await started(h);
    expect(h.world.tools().map((t) => t.name)).toEqual(['voice_speak', 'voice_hush', 'voice_style']);
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
    expect(okUi.config?.length).toBe(4);

    const bad = make({}, {
      service: fakeService({ healthState: { ok: false, ready: false, status: 'HTTP 503', detail: 'voice service 503: down' } }),
    });
    await started(bad);
    const badUi = bad.world.webUi('zh');
    expect(badUi.lamps?.[0]?.state).toBe('error');
    expect(badUi.lamps?.[0]?.hint).toContain('503');
  });

  it('webUi 显示服务灯、队列灯、地址/模型/音色徽标与服务页链接', async () => {
    const h = make({ serviceUrl: 'http://127.0.0.1:9883', model: 'ming3-tts', voice: '4016' });
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
    const h = make({ model: 'manual-model', voice: 'manual-voice' });
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

  it('环境提示词变量带当前模型的写法', async () => {
    const ming = make({ model: 'ming3-tts' });
    await started(ming);
    expect(ming.world.envPromptVars()['voice.modelPrompt']).toBe(modelPrompt('ming3-tts'));
    expect(ming.world.envPromptVars()['voice.modelPrompt']).toContain('[Laughter]');

    const index = make({ model: 'index-tts2' });
    await started(index);
    expect(index.world.envPromptVars()['voice.modelPrompt']).toBe(modelPrompt('index-tts2'));
    expect(index.world.envPromptVars()['voice.modelPrompt']).toContain('emotion_text');

    const generic = make();
    await started(generic);
    expect(generic.world.envPromptVars()['voice.modelPrompt']).toBe(modelPrompt(''));
    expect(generic.world.envPromptVars()['voice.modelPrompt']).toContain('instructions');
  });

  it('模型专属的朗读风格覆盖全局回落值', async () => {
    const h = make({
      playback: 'none',
      model: 'ming3-tts',
      voice: 'global-voice',
      emotionMode: 'none',
      defaultEmotion: '',
      paralinguistic: 'keep',
      modelStyles: {
        'ming3-tts': {
          voice: '4016',
          emotionMode: 'categorical',
          defaultEmotion: '开心',
          defaultInstruct: '',
          speed: 1,
          paralinguistic: 'strip',
        },
      },
    });
    await started(h);
    expect(h.world.envPromptVars()).toMatchObject({
      'voice.voice': '4016',
      'voice.emotion': '开心',
    });
    expect(h.world.webUi('zh').badges?.find((badge) => badge.label === 'voice')?.value).toBe('4016');

    await toolOf(h, 'voice_speak').handler({ text: '[Laughter]你好' }, {} as ToolCallContext);
    expect(h.service.calls[0]?.text).toBe('你好');
    expect(h.service.calls[0]?.emotion).toBe('开心');
  });

  it('voice_style 选了模型后只写该模型的风格', async () => {
    const h = make({ model: 'ming3-tts', modelStyles: {} });
    await started(h);
    await toolOf(h, 'voice_style').handler({ emotion: '开心', voice: 'v9', speed: 1.2 }, {} as ToolCallContext);
    expect(h.cfg.defaultEmotion).toBe('');
    expect(h.cfg.voice).toBe('');
    expect(h.cfg.modelStyles?.['ming3-tts']).toMatchObject({
      defaultEmotion: '开心',
      voice: 'v9',
      speed: 1.2,
    });
  });

  it('voice_style 读与写', async () => {
    const h = make();
    await started(h);
    const tool = toolOf(h, 'voice_style');
    const read = await tool.handler({}, {} as ToolCallContext) as { text: string };
    expect(read.text).toContain('automatic:');
    expect(read.text).not.toContain('singing:');
    await tool.handler({ emotion: '开心', voice: 'v9' }, {} as ToolCallContext);
    expect(h.cfg.defaultEmotion).toBe('开心');
    expect(h.cfg.voice).toBe('v9');
  });

  it('voice_hush 停声', async () => {
    const h = make({ playback: 'local' });
    await started(h);
    const out = await toolOf(h, 'voice_hush').handler({}, {} as ToolCallContext);
    expect(String(out)).toContain('stopped');
    expect(h.player.hushed).toBeGreaterThan(0);
  });

  it('自动朗读:纯文本轮按概率触发', async () => {
    const h = make({ autoProbability: 1, playback: 'none' });
    await started(h);
    const tap = h.world.outputTap()!;
    tap.onEvent(event({ type: 'response.output_text.delta', delta: '今天天气不错。' }));
    tap.onRoundEnd?.();
    await settle(10);
    expect(h.service.calls.map((c) => c.text)).toEqual(['今天天气不错。']);
  });

  it('概率为 0 时不自动朗读', async () => {
    const h = make({ autoProbability: 0, playback: 'none' });
    await started(h);
    const tap = h.world.outputTap()!;
    tap.onEvent(event({ type: 'response.output_text.delta', delta: '今天天气不错。' }));
    tap.onRoundEnd?.();
    await settle(10);
    expect(h.service.calls).toEqual([]);
  });

  it('最近消息里有显式关键词时绕过概率', async () => {
    const h = make({ autoProbability: 0, playback: 'none' });
    const host = new FakeHost();
    const ts = new Date(1_700_000_000_000).toISOString();
    host.store = {
      ...host.store,
      range: () => [{ cursor: 1, type: 'console.message', ts, source: 'console', origin: 'external', text: '', meta: { body: '念给我听' } }],
    } as unknown as typeof host.store;
    await started(h, host);
    const tap = h.world.outputTap()!;
    tap.onEvent(event({ type: 'response.output_text.delta', delta: '好呀。' }));
    tap.onRoundEnd?.();
    await settle(10);
    expect(h.service.calls.map((c) => c.text)).toEqual(['好呀。']);
  });

  it('指定工具的参数触发朗读,同样的文字不重复念', async () => {
    const h = make({ autoProbability: 1, playback: 'none' });
    await started(h);
    const tap = h.world.outputTap()!;
    const call = event({
      type: 'response.output_item.done',
      item: { type: 'function_call', name: 'pet_say', arguments: '{"script":"你好呀"}' },
    });
    tap.onEvent(call);
    tap.onEvent(call);
    await settle(10);
    expect(h.service.calls.map((c) => c.text)).toEqual(['你好呀']);
  });

  it('instruct 模式只发 instructions,categorical 只发 emotion,basic 只发 speed', async () => {
    const instruct = make({ playback: 'none', emotionMode: 'instruct', defaultEmotion: '温柔', defaultInstruct: '' });
    await started(instruct);
    await toolOf(instruct, 'voice_speak').handler({ text: '甲' }, {} as ToolCallContext);
    expect(instruct.service.calls[0]?.instruct).toBe('用情绪是温柔的语气朗读。');
    expect(instruct.service.calls[0]?.emotion).toBeUndefined();
    expect(instruct.service.calls[0]?.speed).toBeUndefined();

    const categorical = make({ playback: 'none', emotionMode: 'categorical', defaultEmotion: '害羞' });
    await started(categorical);
    await toolOf(categorical, 'voice_speak').handler({ text: '乙' }, {} as ToolCallContext);
    expect(categorical.service.calls[0]?.emotion).toBe('害羞');
    expect(categorical.service.calls[0]?.instruct).toBeUndefined();
    expect(categorical.service.calls[0]?.speed).toBeUndefined();

    const basic = make({ playback: 'none', emotionMode: 'basic', speed: 1.4 });
    await started(basic);
    await toolOf(basic, 'voice_speak').handler({ text: '丙' }, {} as ToolCallContext);
    expect(basic.service.calls[0]?.speed).toBe(1.4);
    expect(basic.service.calls[0]?.emotion).toBeUndefined();
    expect(basic.service.calls[0]?.instruct).toBeUndefined();
  });

  it('tags / none 模式不发风格参数', async () => {
    for (const emotionMode of ['tags', 'none'] as const) {
      const h = make({ playback: 'none', emotionMode, defaultEmotion: '开心', speed: 1.3 });
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
