/** 情绪、语速与表演指令的归一。 */
import type { VoiceConfigSection } from '../types.ts';

export interface StyleOverride {
  emotion?: string;
  instruct?: string;
  speed?: number;
}

export interface ResolvedStyle {
  emotion: string;
  instruct: string;
  speed: number;
}

export function classifySpeed(speed: number): '慢速' | '中速' | '快速' {
  if (!Number.isFinite(speed)) return '中速';
  if (speed <= 0.85) return '慢速';
  if (speed >= 1.15) return '快速';
  return '中速';
}

/** 参数 > 配置默认值。空串表示没给。 */
export function resolveStyle(cfg: VoiceConfigSection, override: StyleOverride = {}): ResolvedStyle {
  return {
    emotion: (override.emotion ?? '').trim() || cfg.defaultEmotion.trim(),
    instruct: (override.instruct ?? '').trim() || cfg.defaultInstruct.trim(),
    speed: override.speed ?? cfg.speed,
  };
}

/**
 * 自然语言表演指令,作为 `instructions` 发给服务。
 * 有 instruct 时以它为主,情绪与语速续在后面。
 */
export function buildInstruct(style: ResolvedStyle): string {
  const parts: string[] = [];
  if (style.emotion) parts.push(`情绪是${style.emotion}`);
  if (Number.isFinite(style.speed) && Math.abs(style.speed - 1) >= 0.05) {
    parts.push(`语速${classifySpeed(style.speed)}`);
  }
  if (style.instruct) {
    const base = style.instruct.replace(/[。.!！\s]+$/, '');
    return parts.length ? `${base}；${parts.join('，')}。` : `${base}。`;
  }
  return parts.length ? `用${parts.join('，')}的语气朗读。` : '';
}
