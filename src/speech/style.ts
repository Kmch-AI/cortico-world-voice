/** 情绪、语速与表演指令的归一。 */
import type { VoiceConfigSection, VoiceModelStyle } from '../types.ts';

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

/**
 * 环境提示词里的一句话:当前情绪控制方式实际会用到的默认值。
 * `tagsKept` / `speedSupported` 由调用方按模型能力算好,避免提示词与实际发送不一致。
 */
export function describeStyle(
  style: VoiceModelStyle,
  tagsKept = style.paralinguistic !== 'strip',
  speedSupported = true,
  tagsSupported = true,
  emotionSupported = true,
): string {
  const speedValue = Math.abs(style.speed - 1) >= 0.05 ? classifySpeed(style.speed) : '原速';
  switch (style.emotionMode) {
    case 'instruct': {
      const parts: string[] = [];
      if (style.defaultEmotion) parts.push(`默认情绪是${style.defaultEmotion}`);
      if (style.defaultInstruct) parts.push(`默认表演指令是「${style.defaultInstruct}」`);
      parts.push(`语速${speedValue}`);
      return `情绪用自然语言控制,${parts.join(',')}`;
    }
    case 'categorical':
      if (!emotionSupported) return '当前模型不发送情绪参数';
      return style.defaultEmotion
        ? `情绪用短标签控制,默认情绪是${style.defaultEmotion}`
        : '情绪用短标签控制,没填时用平静';
    case 'basic':
      return speedSupported
        ? `情绪控制只发语速,默认${speedValue}`
        : '当前模型不支持独立语速,不发送情绪参数';
    case 'tags':
      if (!tagsKept) return '情绪不发送,正文标签也会被删掉';
      return tagsSupported
        ? '情绪只用正文里的副语言标签表达'
        : '情绪只靠正文标签,但模型不支持,可能被念出字面';
    case 'none':
      return '不发送情绪参数';
  }
}
