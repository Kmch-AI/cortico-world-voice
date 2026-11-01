/** 共享类型:配置段、合成请求与音频、服务目录与健康。 */

export type AudioFormat = 'wav' | 'mp3';
/** 情绪怎么发给服务。 */
export type EmotionMode = 'instruct' | 'categorical' | 'basic' | 'tags' | 'none';
/** 副语言标签(`[Laughter]` 等)怎么处理。 */
export type ParalinguisticMode = 'auto' | 'keep' | 'strip';
export type PlaybackMode = 'local' | 'event' | 'none';

/** `config.json` 的 `worlds.voice` 段。 */
export interface VoiceConfigSection {
  enabled: boolean;

  // 连接
  /** Kmch AI · 服务 的网关地址。 */
  serviceUrl: string;
  /** 服务令牌的环境变量名;空表示服务不校验。 */
  serviceTokenSecret: string;
  model: string;
  voice: string;
  format: AudioFormat;
  timeoutMs: number;

  // 音色与情绪
  emotionMode: EmotionMode;
  defaultEmotion: string;
  defaultInstruct: string;
  /** 语速倍率;1 为原速。 */
  speed: number;
  paralinguistic: ParalinguisticMode;

  // 触发
  autoSpeak: boolean;
  /** 自动朗读的概率,0–1。显式请求与工具调用不受它限制。 */
  autoProbability: number;
  autoFromText: boolean;
  /** 逗号分隔的工具名;这些工具的参数会被当作要念的正文。 */
  autoTools: string;
  /** 逗号分隔的事件类型;这些事件的正文会被念出来。 */
  autoEvents: string;
  explicitTrigger: boolean;
  explicitKeywords: string;
  /** 往回看多少秒内的用户消息算「刚才」。 */
  explicitWindowSec: number;
  minChars: number;
  maxChars: number;

  // 过滤
  filterCode: boolean;
  filterUrls: boolean;
  filterMarkdown: boolean;
  filterActionTags: boolean;
  filterEmoji: boolean;
  /** 额外要从朗读文本里删掉的字符,按字面,可用逗号/分号/换行分隔。 */
  filterSymbols: string;

  // 出口
  playback: PlaybackMode;
  volume: number;
  /** 单块最长字符数;长句在标点处再切。 */
  chunkMax: number;
  /** 块间停顿毫秒数。 */
  gapMs: number;
  /** 工具回执带音频附件,渠道工具可用 `[blob …]` 句柄发送。 */
  shareAudio: boolean;
}

/** 一次合成。`text` 已经过过滤,不再含控制标记。 */
export interface TtsRequest {
  text: string;
  voice?: string;
  emotion?: string;
  instruct?: string;
  speed?: number;
  format: AudioFormat;
  signal?: AbortSignal;
}

export interface TtsAudio {
  bytes: Uint8Array;
  mime: string;
  /** 已知时的时长(秒),只用于日志与回执。 */
  seconds?: number;
}

/** 配置下拉的一项;`value` 写回配置,`label` 显示。 */
export interface SelectOption {
  value: string;
  label: string;
}

export type VoiceOption = SelectOption;
export type ModelOption = SelectOption;

/** `GET /health` 的摘要;`ok` 只表示网关有回应,`ready` 表示至少有一个服务能合成。 */
export interface ServiceHealth {
  ok: boolean;
  ready: boolean;
  status: string;
  detail?: string;
  models?: number;
}
