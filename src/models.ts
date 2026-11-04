/**
 * 模型能力与提示词片段。
 *
 * 服务返回的模型 id 决定两件事:这个模型认不认副语言标签,以及 instruct /
 * emotion / speed 最终落到哪里。提示词再叠加模型页选的情绪控制方式与标签
 * 策略,让模型只填当前设置真正会发送的字段。按 id 前缀匹配,大小写不敏感;
 * 空模型与未知模型按通用 OpenAI 兼容模型处理。
 */
import type { EmotionMode, VoiceModelStyle } from './types.ts';
import { keepsParalinguistic } from './speech/tags.ts';

interface ModelInfo {
  /** 模型 id 的前缀,小写。 */
  readonly match: readonly string[];
  /** 给人看的名字;未知模型为空。 */
  readonly label: string;
  /** 是否支持 `[Laughter]` 这类副语言标签。 */
  readonly tags: boolean;
  /** 服务的模型 profile 是否把独立的 `speed` 参数落到模型上。 */
  readonly speed: boolean;
  /** 服务的模型 profile 是否有 `emotion` 字段。 */
  readonly emotion: boolean;
  /** instruct / emotion / speed 在这个模型上的落点。 */
  readonly note: string;
}

const MING3: ModelInfo = {
  match: ['ming3-tts', 'ming-3', 'ming_3'],
  label: 'Ming 3.0 TTS',
  tags: true,
  speed: true,
  emotion: true,
  note: 'Ming 3.0 会把 instruct 落到自由文本模板、emotion 落到情绪模板、speed 落到语速档。',
};

const INDEXTTS2: ModelInfo = {
  match: ['index-tts2', 'index_tts2', 'index-tts2.5', 'index_tts2_5'],
  label: 'IndexTTS2',
  tags: false,
  speed: false,
  emotion: true,
  note: 'IndexTTS2 会把 instruct 或 emotion 的自然语言文字写入 emotion_text;独立的 speed 参数不落到模型上。',
};

const GENERIC: ModelInfo = {
  match: [],
  label: '',
  tags: false,
  speed: true,
  emotion: false,
  note: '未知模型按 OpenAI 兼容处理:服务会映射 instruct 到 instructions、speed 直接透传;emotion 不发送。',
};

const KNOWN: readonly ModelInfo[] = [MING3, INDEXTTS2];

function normalize(model: string): string {
  return typeof model === 'string' ? model.trim().toLowerCase() : '';
}

function profileOf(model: string): ModelInfo | null {
  const id = normalize(model);
  if (!id) return null;
  return KNOWN.find((info) => info.match.some((prefix) => id.startsWith(prefix))) ?? null;
}

/** 当前模型是否支持副语言标签;未知与空模型按通用模型处理,返回 false。 */
export function modelSupportsTags(model: string): boolean {
  return profileOf(model)?.tags ?? GENERIC.tags;
}

/** 给人看的模型名;未知或空模型返回空串,由调用方退回模型 id。 */
export function modelLabel(model: string): string {
  return profileOf(model)?.label ?? '';
}

/** 模型的 profile 是否把独立的 `speed` 参数落到模型上。 */
export function modelSupportsSpeed(model: string): boolean {
  return (profileOf(model) ?? GENERIC).speed;
}

/** 模型的 profile 是否有 `emotion` 字段。 */
export function modelSupportsEmotion(model: string): boolean {
  return (profileOf(model) ?? GENERIC).emotion;
}

/** 当前设置下,这个模型这一句允许填哪些字段。 */
function fieldRule(mode: EmotionMode, info: ModelInfo, tagsKept: boolean): string {
  switch (mode) {
    case 'instruct':
      return '调用 voice_speak 时,用 instruct 写这一句的表演方式(自然语言,例如「像在耳边轻声说话,语速偏慢」);不要填 emotion。speed 可选,会并入指令。';
    case 'categorical':
      return info.emotion
        ? '调用 voice_speak 时,用 emotion 写一个短情绪词(例如 开心、温柔、疲惫);不要填 instruct 与 speed,它们不会发送。'
        : '当前模型不发送 emotion;不要填 emotion、instruct 与 speed,按模型默认语气朗读。';
    case 'basic':
      return info.speed
        ? '调用 voice_speak 时,只用 speed(0.5–2,1 为原速);不要填 emotion 与 instruct,它们不会发送。'
        : '当前模型不支持独立的语速参数;不要填 emotion、instruct 与 speed,按模型默认语气朗读。';
    case 'tags':
      if (!tagsKept) return '当前设置不保留副语言标签,emotion 与 instruct 也不发送;按模型默认语气朗读。';
      return info.tags
        ? '调用 voice_speak 时,不要填 emotion、instruct 与 speed;用 text 里的副语言标签表达情绪。'
        : '调用 voice_speak 时,不要填 emotion、instruct 与 speed;标签会保留在 text 里,但这个模型不支持副语言标签,可能被念出字面。';
    case 'none':
      return '调用 voice_speak 时,不要填 emotion、instruct 与 speed;语气由模型默认值决定。';
  }
}

/** 正文里能不能写 `[Laughter]` 这类标签。 */
function tagRule(tagsSupported: boolean, tagsKept: boolean): string {
  if (tagsKept) {
    return tagsSupported
      ? '可在 text 里内联 [Laughter] [Sigh] [Breathing] [Uhm] [Question-ei] 等副语言标签;它们会被演出来,不会被念出。'
      : '标签会保留在 text 里,但这个模型不支持副语言标签,可能被念出字面;只在确认模型能演时使用。';
  }
  return tagsSupported
    ? '不要在 text 里写副语言标签;当前设置会把它们删掉。'
    : '不要在 text 里写 [Laughter] 这类方括号标签;这个模型不支持,写了会被删掉。';
}

/**
 * 环境提示词里的文本与情绪写法:模型能力 × 情绪控制方式 × 标签策略。
 * 模型页切换这两个开关时,面板预览与下一轮环境提示词都用同一份结果。
 */
export function voicePrompt(model: string, style: VoiceModelStyle): string {
  const info = profileOf(model) ?? GENERIC;
  const tagsKept = keepsParalinguistic(style.paralinguistic, info.tags);
  return [
    fieldRule(style.emotionMode, info, tagsKept),
    tagRule(info.tags, tagsKept),
    info.note,
    'voice 只在需要临时换音色时填,否则用配置里的音色。',
  ].join(' ');
}

/** 模型页可以提供的情绪控制方式;服务 profile 落不到的字段不提供对应方式。 */
export function modelEmotionModes(model: string): EmotionMode[] {
  const info = profileOf(model) ?? GENERIC;
  const modes: EmotionMode[] = ['instruct'];
  if (info.emotion) modes.push('categorical');
  if (info.speed) modes.push('basic');
  modes.push('tags', 'none');
  return modes;
}
