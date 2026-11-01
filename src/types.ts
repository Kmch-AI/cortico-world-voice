/** 共享类型:配置段、合成请求与音频、协议适配器接口。 */
import type { Logger } from 'cortico/core/types.ts';

export type BackendId = 'audiocpp' | 'openai' | 'custom';
export type AudioFormat = 'wav' | 'mp3';
/** 情绪怎么发给后端。 */
export type EmotionMode = 'instruct' | 'categorical' | 'basic' | 'tags' | 'none';
/** 副语言标签(`[Laughter]` 等)怎么处理。 */
export type ParalinguisticMode = 'auto' | 'keep' | 'strip';
export type PlaybackMode = 'local' | 'event' | 'none';

/** `config.json` 的 `worlds.voice` 段。 */
export interface VoiceConfigSection {
  enabled: boolean;

  // 连接与协议
  backend: BackendId;
  baseUrl: string;
  model: string;
  voice: string;
  /** 密钥的环境变量名;空表示不需要。 */
  apiKeySecret: string;
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

  // 本地语音接口
  httpApi: boolean;
  httpPort: number;
  httpToken: string;
  /** 经 HTTP 接口合成时是否也在本机播放。 */
  httpPlay: boolean;

  // 唱歌
  singUrl: string;
  singToken: string;

  // custom 协议
  customUrl: string;
  customMethod: 'POST' | 'GET';
  /** JSON 对象字符串,值里的 `${KEY}` 换成 apiKeySecret 读到的密钥。 */
  customHeaders: string;
  /** JSON 模板;占位符见 README。 */
  customBody: string;
  customResponse: 'audio' | 'base64' | 'url';
  /** base64/url 回应里音频字段的点路径。 */
  customAudioPath: string;
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

export interface VoiceOption {
  value: string;
  label: string;
}

export interface BackendHealth {
  ok: boolean;
  detail?: string;
}

/** 适配器运行时可用的东西。 */
export interface BackendContext {
  cfg: VoiceConfigSection;
  secret(name: string): string;
  fetch: typeof fetch;
  log: Logger;
}

/** 一种语音合成协议。新增协议 = 实现这个接口,再在 registry 里登记。 */
export interface TtsBackend {
  readonly id: BackendId;
  readonly label: string;
  synthesize(req: TtsRequest, ctx: BackendContext): Promise<TtsAudio>;
  /** 后端能列出的音色;不支持时返回空数组。 */
  listVoices(ctx: BackendContext): Promise<VoiceOption[]>;
  health(ctx: BackendContext): Promise<BackendHealth>;
}
