/** 共享类型:配置段、合成请求与音频、服务目录与健康。 */

export type AudioFormat = 'wav' | 'mp3';
/** 情绪怎么发给服务。 */
export type EmotionMode = 'instruct' | 'categorical' | 'basic' | 'tags' | 'none';
/** 副语言标签(`[Laughter]` 等)怎么处理。 */
export type ParalinguisticMode = 'auto' | 'keep' | 'strip';
export type PlaybackMode = 'local' | 'event' | 'none';

/** 单个模型的朗读风格;缺省字段回落到 `worlds.voice` 上的全局同名值。 */
export interface VoiceModelStyle {
  voice: string;
  emotionMode: EmotionMode;
  defaultEmotion: string;
  defaultInstruct: string;
  /** 语速倍率;1 为原速。 */
  speed: number;
  paralinguistic: ParalinguisticMode;
}

/** `config.json` 的 `worlds.voice` 段。 */
export interface VoiceConfigSection {
  enabled: boolean;

  // 连接
  /** Kmch AI · 服务 的网关地址。 */
  serviceUrl: string;
  /** 服务令牌的环境变量名;空表示服务不校验。 */
  serviceTokenSecret: string;
  model: string;
  /** 旧的全局音色;只作为没有模型专属设置时的回落值。 */
  voice: string;
  /** 模型专属的 request 参数,按模型 id 分组;由「模型」面板写回,不进 ConfigGroup。 */
  modelOptions: Record<string, Record<string, unknown>>;
  /** 模型专属的朗读风格;由「模型」面板写回,不进 ConfigGroup。 */
  modelStyles: Record<string, Partial<VoiceModelStyle>>;
  format: AudioFormat;
  timeoutMs: number;

  // 朗读风格的全局回落值(旧配置仍可用;界面上已移到模型页)
  emotionMode: EmotionMode;
  defaultEmotion: string;
  defaultInstruct: string;
  /** 语速倍率;1 为原速。 */
  speed: number;
  paralinguistic: ParalinguisticMode;

  // 过滤与长度
  minChars: number;
  maxChars: number;
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

/** 服务 `GET /v1/models` 里 `parameters[].type` 的取值。 */
export type ModelParameterType =
  | 'string'
  | 'enum'
  | 'bool'
  | 'int'
  | 'float'
  | 'string_list'
  | 'path'
  | 'path_list';

/** 模型请求参数的元数据;服务按模型给出,面板据此渲染字段。 */
export interface ModelParameter {
  name: string;
  type: ModelParameterType;
  description?: string;
  values?: string[];
  default?: unknown;
  min?: number;
  max?: number;
}

/** 服务目录里的一项模型;音色与请求参数元数据随模型走。 */
export interface VoiceModel {
  id: string;
  label?: string;
  voices: string[];
  parameters?: ModelParameter[];
}

/** `GET /health` 的摘要;`ok` 只表示网关有回应,`ready` 表示至少有一个服务能合成。 */
export interface ServiceHealth {
  ok: boolean;
  ready: boolean;
  status: string;
  detail?: string;
  models?: number;
}
