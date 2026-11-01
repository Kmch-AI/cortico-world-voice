import { describe, expect, it } from 'vitest';
import type { EventEnvelope, OutputTap } from 'cortico/core/types.ts';
import type { StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import { VOICE_DEFAULTS } from '../src/config.ts';
import {
  EventPoller, hasKeyword, latestUserText, textOfEvent, textOfToolArgs, VoiceTap,
} from '../src/triggers.ts';
import { FakeHost } from './helpers/fake-host.ts';

const cfg = { ...VOICE_DEFAULTS };

function event(patch: Record<string, unknown>): StreamEvent {
  return { type: 'x', ...patch } as unknown as StreamEvent;
}

function tapOf(seen: Array<{ text: string; source: string }>, onAbort?: () => void): OutputTap {
  return new VoiceTap({
    cfg: () => cfg,
    onText: (text, source) => seen.push({ text, source }),
    onAbort,
  });
}

describe('VoiceTap', () => {
  it('纯文本一轮结束后交出去', () => {
    const seen: Array<{ text: string; source: string }> = [];
    const tap = tapOf(seen);
    tap.onEvent(event({ type: 'response.output_text.delta', delta: '你好' }));
    tap.onEvent(event({ type: 'response.output_text.delta', delta: '呀' }));
    tap.onRoundEnd?.();
    expect(seen).toEqual([{ text: '你好呀', source: 'text' }]);
  });

  it('这一轮有函数调用时不念正文', () => {
    const seen: Array<{ text: string; source: string }> = [];
    const tap = tapOf(seen);
    tap.onEvent(event({ type: 'response.output_text.delta', delta: '让我查一下' }));
    tap.onEvent(event({ type: 'response.output_item.added', item: { type: 'function_call', name: 'web_search' } }));
    tap.onRoundEnd?.();
    expect(seen).toEqual([]);
  });

  it('指定工具的参数被当作正文', () => {
    const seen: Array<{ text: string; source: string }> = [];
    const tap = tapOf(seen);
    tap.onEvent(event({
      type: 'response.output_item.done',
      item: { type: 'function_call', name: 'pet_say', arguments: '{"script":"【笑】你好"}' },
    }));
    expect(seen).toEqual([{ text: '【笑】你好', source: 'tool:pet_say' }]);
  });

  it('只给参数结束事件时也能认出工具名,且不重复', () => {
    const seen: Array<{ text: string; source: string }> = [];
    const tap = tapOf(seen);
    tap.onEvent(event({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', name: 'pet_say' } }));
    tap.onEvent(event({ type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"script":"你好"}' }));
    tap.onEvent(event({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', name: 'pet_say', arguments: '{"script":"你好"}' } }));
    expect(seen).toEqual([{ text: '你好', source: 'tool:pet_say' }]);
  });

  it('voice_ 自己的工具不再触发朗读', () => {
    const seen: Array<{ text: string; source: string }> = [];
    const tap = tapOf(seen);
    tap.onEvent(event({
      type: 'response.output_item.done',
      item: { type: 'function_call', name: 'voice_speak', arguments: '{"text":"你好"}' },
    }));
    expect(seen).toEqual([]);
  });

  it('取消时回调', () => {
    let aborted = 0;
    const tap = tapOf([], () => { aborted += 1; });
    tap.onAbort?.('interrupt');
    expect(aborted).toBe(1);
  });
});

describe('工具参数与事件正文', () => {
  it('按顺序找正文', () => {
    expect(textOfToolArgs('{"script":"台词","text":"正文"}')).toBe('台词');
    expect(textOfToolArgs('{"text":"正文"}')).toBe('正文');
    expect(textOfToolArgs('not json')).toBe('');
    expect(textOfToolArgs('{"n":1}')).toBe('');
  });

  it('优先 meta.body', () => {
    const e = { text: '[12:00] 甲: hi', meta: { body: 'hi' } } as unknown as EventEnvelope;
    expect(textOfEvent(e)).toBe('hi');
  });
});

describe('显式关键词', () => {
  it('最近的外部事件命中关键词', () => {
    const host = new FakeHost();
    const now = Date.parse('2026-11-01T10:00:00.000Z');
    host.store = {
      ...host.store,
      range: () => [
        { cursor: 1, type: 'console.message', ts: '2026-11-01T09:59:50.000Z', source: 'console', origin: 'external', text: '', meta: { body: '念给我听' } },
      ],
    } as unknown as typeof host.store;
    expect(latestUserText(host, 120, now)).toBe('念给我听');
    expect(hasKeyword('念给我听', cfg.explicitKeywords)).toBe(true);
    expect(hasKeyword('今天天气不错', cfg.explicitKeywords)).toBe(false);
  });

  it('控制台的 internal 操作员消息也算,自录不算', () => {
    const host = new FakeHost();
    const now = Date.parse('2026-11-01T10:00:00.000Z');
    host.store = {
      ...host.store,
      range: () => [
        { cursor: 1, type: 'console.message', ts: '2026-11-01T09:59:50.000Z', source: 'console', origin: 'internal', text: '', meta: { from: '甲', body: '念给我听' } },
        { cursor: 2, type: 'console.self', ts: '2026-11-01T09:59:55.000Z', source: 'console', origin: 'internal', text: '', meta: { from: 'bot', body: '我自己说了语音' } },
      ],
    } as unknown as typeof host.store;
    expect(latestUserText(host, 120, now)).toBe('念给我听');
  });

  it('窗口外的事件不算', () => {
    const host = new FakeHost();
    const now = Date.parse('2026-11-01T10:00:00.000Z');
    host.store = {
      ...host.store,
      range: () => [
        { cursor: 1, type: 'console.message', ts: '2026-11-01T09:00:00.000Z', source: 'console', origin: 'external', text: '念给我听' },
      ],
    } as unknown as typeof host.store;
    expect(latestUserText(host, 120, now)).toBe('');
  });
});

describe('EventPoller', () => {
  it('只处理启动之后的新事件,跳过自己的事件', async () => {
    const host = new FakeHost();
    let cursor = 5;
    const events: EventEnvelope[] = [];
    host.store = {
      ...host.store,
      latestCursor: () => cursor,
      range: (q: { fromCursor?: number }) => events.filter((e) => e.cursor >= (q.fromCursor ?? 0)),
    } as unknown as typeof host.store;
    const seen: string[] = [];
    const poller = new EventPoller({
      host,
      types: new Set(['desktop-pet.self']),
      onText: (text) => seen.push(text),
      intervalMs: 5,
      log: () => {},
    });
    poller.start();
    events.push(
      { cursor: 6, type: 'desktop-pet.self', ts: '', source: 'pet', origin: 'internal', text: '新气泡' },
      { cursor: 7, type: 'desktop-pet.self', ts: '', source: 'voice', origin: 'internal', text: '自己' },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    poller.stop();
    expect(seen).toEqual(['新气泡']);
  });
});
