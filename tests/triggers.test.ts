import { describe, expect, it } from 'vitest';
import type { EventEnvelope, OutputTap } from 'cortico/core/types.ts';
import type { StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import { VOICE_DEFAULTS } from '../src/config.ts';
import { hasKeyword, latestUserText, textOfEvent, VoiceTap } from '../src/triggers.ts';
import { FakeHost } from './helpers/fake-host.ts';

const keywords = VOICE_DEFAULTS.explicitKeywords;

function event(patch: Record<string, unknown>): StreamEvent {
  return { type: 'x', ...patch } as unknown as StreamEvent;
}

function tapOf(seen: Array<{ text: string; source: string }>, onAbort?: () => void): OutputTap {
  return new VoiceTap({
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

  it('只有 end_turn 时不压掉正文', () => {
    const seen: Array<{ text: string; source: string }> = [];
    const tap = tapOf(seen);
    tap.onEvent(event({ type: 'response.output_text.delta', delta: '说完这句就结束。' }));
    tap.onEvent(event({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', name: 'end_turn' } }));
    tap.onEvent(event({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', name: 'end_turn', arguments: '{}' } }));
    tap.onRoundEnd?.();
    expect(seen).toEqual([{ text: '说完这句就结束。', source: 'text' }]);
  });

  it('end_turn 与其他工具同轮时仍不念正文', () => {
    const seen: Array<{ text: string; source: string }> = [];
    const tap = tapOf(seen);
    tap.onEvent(event({ type: 'response.output_text.delta', delta: '让我查一下' }));
    tap.onEvent(event({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', name: 'end_turn' } }));
    tap.onEvent(event({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', name: 'web_search' } }));
    tap.onRoundEnd?.();
    expect(seen).toEqual([]);
  });

  it('先出现无名调用、随后确认是 end_turn 时仍念正文', () => {
    const seen: Array<{ text: string; source: string }> = [];
    const tap = tapOf(seen);
    tap.onEvent(event({ type: 'response.output_text.delta', delta: '好。' }));
    tap.onEvent(event({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call' } }));
    tap.onEvent(event({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', name: 'end_turn', arguments: '{}' } }));
    tap.onRoundEnd?.();
    expect(seen).toEqual([{ text: '好。', source: 'text' }]);
  });

  it('取消时回调', () => {
    let aborted = 0;
    const tap = tapOf([], () => { aborted += 1; });
    tap.onAbort?.('interrupt');
    expect(aborted).toBe(1);
  });
});

describe('事件正文', () => {
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
    expect(hasKeyword('念给我听', keywords)).toBe(true);
    expect(hasKeyword('今天天气不错', keywords)).toBe(false);
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
