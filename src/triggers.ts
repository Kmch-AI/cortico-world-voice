/**
 * 触发层:从主 session 的输出流里认出「要念的话」,以及从事件库里认出
 * 显式语音请求与配置的事件源。这一层不认识 TTS。
 */
import type { EventEnvelope, OutputTap, WorldHost } from 'cortico/core/types.ts';
import type { StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import type { VoiceConfigSection } from './types.ts';

/** 工具参数里可能放正文的字段,按顺序取第一个字符串。 */
const TEXT_FIELDS = ['script', 'question', 'text', 'content', 'message', 'body'] as const;

export function splitList(raw: string): string[] {
  return raw
    .split(/[,，;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function toolNames(cfg: VoiceConfigSection): Set<string> {
  return new Set(splitList(cfg.autoTools));
}

export function eventTypes(cfg: VoiceConfigSection): Set<string> {
  return new Set(splitList(cfg.autoEvents));
}

/** 从工具调用参数里取正文;取不到返回空串。 */
export function textOfToolArgs(raw: string): string {
  if (!raw) return '';
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return ''; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
  const obj = parsed as Record<string, unknown>;
  for (const field of TEXT_FIELDS) {
    const value = obj[field];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

export interface TapOptions {
  cfg: () => VoiceConfigSection;
  /** 一段完整的话;`source` 形如 `text` 或 `tool:pet_say`。 */
  onText(text: string, source: string): void;
  /** 模型调用被取消或打断;可以用来停声。 */
  onAbort?(): void;
}

/**
 * 主 session 的输出旁路。一轮里只有纯文本、没有函数调用时,把正文交出去;
 * 指定工具的参数在调用完成时交出去。工具自己念的 `voice_*` 不在此列。
 */
interface StreamLike {
  type: string;
  delta?: string;
  arguments?: string;
  output_index?: number;
  item?: { type?: string; name?: string; arguments?: string } | null;
}

export class VoiceTap implements OutputTap {
  private text = '';
  private calls = 0;
  private readonly names = new Map<number, string>();
  private readonly emitted = new Set<number>();

  constructor(private readonly opts: TapOptions) {}

  /** 工具调用完成:同一个 output_index 只交出去一次。 */
  private takeCall(index: number, name: string, args: string): void {
    if (!name || name.startsWith('voice_')) return;
    if (this.emitted.has(index)) return;
    if (!toolNames(this.opts.cfg()).has(name)) return;
    const text = textOfToolArgs(args);
    if (!text) return;
    this.emitted.add(index);
    this.opts.onText(text, `tool:${name}`);
  }

  onEvent(event: StreamEvent): void {
    const e = event as StreamLike;
    const index = e.output_index ?? -1;
    if (e.type === 'response.output_text.delta') {
      this.text += e.delta ?? '';
      return;
    }
    if (e.type === 'response.output_item.added' && e.item?.type === 'function_call') {
      this.calls += 1;
      if (e.item.name) this.names.set(index, e.item.name);
      return;
    }
    // 有的传输只给参数结束事件,不带完整 item;名字从 added 里取。
    if (e.type === 'response.function_call_arguments.done') {
      const name = this.names.get(index) ?? '';
      if (name) this.takeCall(index, name, e.arguments ?? '');
      return;
    }
    if (e.type === 'response.output_item.done' && e.item?.type === 'function_call') {
      this.calls += 1;
      const name = e.item.name ?? this.names.get(index) ?? '';
      if (name) this.takeCall(index, name, e.item.arguments ?? '');
      this.names.delete(index);
    }
  }

  onRoundEnd(): void {
    const text = this.text;
    this.text = '';
    const pureText = this.calls === 0;
    this.calls = 0;
    this.names.clear();
    this.emitted.clear();
    if (pureText && text.trim()) this.opts.onText(text, 'text');
  }

  onAbort(): void {
    this.text = '';
    this.calls = 0;
    this.names.clear();
    this.emitted.clear();
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

export interface EventPollOptions {
  host: WorldHost;
  types: Set<string>;
  onText(text: string, source: string): void;
  intervalMs?: number;
  log(message: string, data?: unknown): void;
}

/** 轮询事件库;只处理启动之后的新事件,不补读。 */
export class EventPoller {
  private timer: NodeJS.Timeout | null = null;
  private cursor = 0;

  constructor(private readonly opts: EventPollOptions) {}

  start(): void {
    if (this.timer) return;
    try { this.cursor = this.opts.host.store.latestCursor(); } catch { this.cursor = 0; }
    const tick = (): void => {
      let events: EventEnvelope[];
      try {
        events = this.opts.host.store.range({ fromCursor: this.cursor + 1, limit: 50 });
      } catch (error) {
        this.opts.log('事件轮询失败', { err: error instanceof Error ? error.message : String(error) });
        return;
      }
      for (const event of events) {
        this.cursor = Math.max(this.cursor, event.cursor);
        if (event.source === 'voice') continue;
        if (!this.opts.types.has(event.type)) continue;
        const text = textOfEvent(event);
        if (text.trim()) this.opts.onText(text, `event:${event.type}`);
      }
    };
    this.timer = setInterval(tick, this.opts.intervalMs ?? 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
