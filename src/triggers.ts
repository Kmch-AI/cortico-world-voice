/**
 * 触发层:从主 session 的输出流里认出显式请求的正文,以及从事件库里认出
 * 「刚才有人要语音」。这一层不认识 TTS,也不掷概率。
 */
import type { EventEnvelope, OutputTap, WorldHost } from 'cortico/core/types.ts';
import type { StreamEvent } from 'cortico/protocol/open-responses/index.ts';

/** 只结束这一轮的控制工具,不算「这一轮做了别的事」。 */
const FLOW_TOOLS = new Set(['end_turn']);

export function splitList(raw: string): string[] {
  return raw
    .split(/[,，;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface TapOptions {
  /** 一段完整的话;`source` 形如 `text`。 */
  onText(text: string, source: string): void;
  /** 模型调用被取消或打断;可以用来停声。 */
  onAbort?(): void;
}

/**
 * 主 session 的输出旁路。一轮里只有纯文本、没有实质函数调用时,把正文交出去;
 * 是否朗读由显式关键词或 `<tts>` 决定。
 */
interface StreamLike {
  type: string;
  delta?: string;
  output_index?: number;
  item?: { type?: string; name?: string } | null;
}

export class VoiceTap implements OutputTap {
  private text = '';
  /** 这一轮出现过的函数调用:output_index -> name;名字未知时存空串。 */
  private readonly callNames = new Map<number, string>();
  /** 没有 output_index 的函数调用;无法判断是不是 end_turn,按实质调用处理。 */
  private orphanCall = false;

  constructor(private readonly opts: TapOptions) {}

  private noteCall(index: number, name: string): void {
    if (index < 0) {
      if (name && FLOW_TOOLS.has(name)) return;
      this.orphanCall = true;
      return;
    }
    if (name) this.callNames.set(index, name);
    else if (!this.callNames.has(index)) this.callNames.set(index, '');
  }

  onEvent(event: StreamEvent): void {
    const e = event as StreamLike;
    const index = e.output_index ?? -1;
    if (e.type === 'response.output_text.delta') {
      this.text += e.delta ?? '';
      return;
    }
    if (e.type === 'response.output_item.added' && e.item?.type === 'function_call') {
      this.noteCall(index, e.item.name ?? '');
      return;
    }
    // 有的传输只给参数结束事件,不带完整 item;名字从 added 里取。
    if (e.type === 'response.function_call_arguments.done') {
      this.noteCall(index, this.callNames.get(index) ?? '');
      return;
    }
    if (e.type === 'response.output_item.done' && e.item?.type === 'function_call') {
      this.noteCall(index, e.item.name ?? this.callNames.get(index) ?? '');
    }
  }

  onRoundEnd(): void {
    const text = this.text;
    this.text = '';
    // 只有结束轮次的调用不算实质动作;纯文本回复照样可以交给显式触发判断。
    const nonFlow = this.orphanCall
      || [...this.callNames.values()].some((name) => name === '' || !FLOW_TOOLS.has(name));
    this.callNames.clear();
    this.orphanCall = false;
    if (!nonFlow && text.trim()) this.opts.onText(text, 'text');
  }

  onAbort(): void {
    this.text = '';
    this.callNames.clear();
    this.orphanCall = false;
    this.opts.onAbort?.();
  }
}

/** 一条事件里能念的正文:优先 `meta.body`。 */
export function textOfEvent(event: EventEnvelope): string {
  const body = event.meta?.body;
  if (typeof body === 'string' && body.trim()) return body;
  return event.text ?? '';
}

/**
 * 一条事件是不是「人对 bot 说的话」。外部事件算;控制台把操作员消息按 internal 投递
 * (它装的是操作员直接对 bot 说话),所以带 `meta.from` 的渠道消息也算。bot 自己的回录
 * 类型以 `.self` / `.bot` 结尾,排除。
 */
function isUserEvent(event: EventEnvelope): boolean {
  if (event.source === 'voice') return false;
  if (event.origin === 'external') return true;
  const from = event.meta?.from;
  if (typeof from !== 'string' || !from.trim()) return false;
  return !/(?:^|\.)(?:self|bot|assistant)$/i.test(event.type);
}

/** 最近 `windowSec` 秒内最后一条人对 bot 说的话。 */
export function latestUserText(host: WorldHost, windowSec: number, now = Date.now()): string {
  if (windowSec <= 0) return '';
  let events: EventEnvelope[];
  try {
    events = host.store.range({ limit: 80 });
  } catch {
    return '';
  }
  const floor = now - windowSec * 1000;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (!isUserEvent(event)) continue;
    const at = Date.parse(event.ts);
    if (Number.isFinite(at) && at < floor) continue;
    const text = textOfEvent(event);
    if (text.trim()) return text;
  }
  return '';
}

/** 关键词表里任意一个出现在文本里(大小写不敏感)。 */
export function hasKeyword(text: string, keywords: string): boolean {
  const lower = text.toLowerCase();
  return splitList(keywords).some((word) => lower.includes(word.toLowerCase()));
}
