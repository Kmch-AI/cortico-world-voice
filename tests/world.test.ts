import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventEnvelope, ToolCallContext } from 'cortico/core/types.ts';
import { dryMountWorld } from 'cortico/extensions/dry-mount.ts';
import type { StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import { VOICE } from '../src/definition.ts';
import { FakeHost } from './helpers/fake-host.ts';
import { settle, testWorld, type TestWorldHandle } from './helpers/voice.ts';

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

  it('voice_speak 在 playback=none 时只合成并回执', async () => {
    const h = make({ playback: 'none' });
    await started(h);
    const tool = h.world.tools().find((t) => t.name === 'voice_speak')!;
    const outcome = await tool.handler({ text: '**你好**呀' }, {} as ToolCallContext);
    expect(typeof outcome).toBe('object');
    expect((outcome as { text: string }).text).toContain('Synthesized one line');
    expect((outcome as { blobs?: unknown[] }).blobs).toHaveLength(1);
    expect(h.backend.calls[0]?.text).toBe('你好呀');
  });

  it('voice_style 读与写', async () => {
    const h = make();
    await started(h);
    const tool = h.world.tools().find((t) => t.name === 'voice_style')!;
    const read = await tool.handler({}, {} as ToolCallContext) as { text: string };
    expect(read.text).toContain('automatic:');
    await tool.handler({ emotion: '开心', voice: 'v9' }, {} as ToolCallContext);
    expect(h.cfg.defaultEmotion).toBe('开心');
    expect(h.cfg.voice).toBe('v9');
  });

  it('voice_hush 停声', async () => {
    const h = make({ playback: 'local' });
    await started(h);
    const tool = h.world.tools().find((t) => t.name === 'voice_hush')!;
    const out = await tool.handler({}, {} as ToolCallContext);
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
    expect(h.backend.calls.map((c) => c.text)).toEqual(['今天天气不错。']);
  });

  it('概率为 0 时不自动朗读', async () => {
    const h = make({ autoProbability: 0, playback: 'none' });
    await started(h);
    const tap = h.world.outputTap()!;
    tap.onEvent(event({ type: 'response.output_text.delta', delta: '今天天气不错。' }));
    tap.onRoundEnd?.();
    await settle(10);
    expect(h.backend.calls).toEqual([]);
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
    expect(h.backend.calls.map((c) => c.text)).toEqual(['好呀。']);
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
    expect(h.backend.calls.map((c) => c.text)).toEqual(['你好呀']);
  });

  it('自动来源里的【唱】转给唱歌插件,不走 TTS', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      urls.push(String(input));
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/wav' } });
    }) as typeof fetch;
    const h = make(
      { autoProbability: 1, playback: 'none', singUrl: 'http://127.0.0.1:9882' },
      { fetch: fetchImpl },
    );
    await started(h);
    const tap = h.world.outputTap()!;
    tap.onEvent(event({
      type: 'response.output_item.done',
      item: { type: 'function_call', name: 'pet_say', arguments: '{"script":"【唱】啦啦啦"}' },
    }));
    await settle(10);
    expect(urls.some((url) => url.endsWith('/sing'))).toBe(true);
    expect(h.backend.calls).toEqual([]);
  });

  it('webUi 的灯在探活后变 online', async () => {
    const h = make();
    await started(h);
    const ui = h.world.webUi('zh');
    expect(ui.label).toBe('语音');
    expect(ui.lamps?.[0]?.state).toBe('online');
    expect(ui.config?.length).toBeGreaterThan(0);
  });

  it('事件不投给模型:tts.voice 带 deliver:false', async () => {
    const h = make({ playback: 'event' });
    const host = await started(h);
    const tool = h.world.tools().find((t) => t.name === 'voice_speak')!;
    await tool.handler({ text: '你好' }, {} as ToolCallContext);
    await settle(10);
    const voiceEvent = host.events.find((e: EventEnvelope) => e.type === 'tts.voice');
    expect(voiceEvent).toBeTruthy();
    expect(host.pushOpts[host.events.indexOf(voiceEvent!)]).toEqual({ deliver: false });
  });
});
