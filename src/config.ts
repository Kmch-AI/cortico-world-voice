/** `worlds.voice` 的默认值、配置组与界面文案。 */
import type { ConfigGroup } from 'cortico/core/types.ts';
import { pick, type Language, type LanguageTable } from 'cortico/core/language.ts';
import type { VoiceConfigSection, VoiceModelStyle } from './types.ts';

export const VOICE_ID = 'voice';
/** World 定义、WebUI 与配置页共用同一个显示名。 */
export const VOICE_LABEL = 'Kmch AI · 语音';

export const VOICE_DEFAULTS: VoiceConfigSection = {
  enabled: false,

  serviceUrl: 'http://127.0.0.1:9883',
  serviceTokenSecret: '',
  model: '',
  voice: '',
  modelOptions: {},
  modelStyles: {},
  format: 'wav',
  timeoutMs: 180_000,

  emotionMode: 'instruct',
  defaultEmotion: '',
  defaultInstruct: '',
  speed: 1,
  paralinguistic: 'auto',

  minChars: 2,
  maxChars: 1200,

  filterCode: true,
  filterUrls: true,
  filterMarkdown: true,
  filterActionTags: true,
  filterEmoji: true,
  filterSymbols: '',

  playback: 'local',
  volume: 0.9,
  chunkMax: 120,
  gapMs: 120,
  shareAudio: false,
};

/**
 * 当前模型的朗读风格。模型页保存的值优先,缺省字段回落到旧的全局值,
 * 这样升级前已有的配置仍然有效。
 */
export function modelStyle(cfg: VoiceConfigSection, model = cfg.model): VoiceModelStyle {
  const saved = cfg.modelStyles?.[model] ?? {};
  return {
    voice: saved.voice ?? cfg.voice,
    emotionMode: saved.emotionMode ?? cfg.emotionMode,
    defaultEmotion: saved.defaultEmotion ?? cfg.defaultEmotion,
    defaultInstruct: saved.defaultInstruct ?? cfg.defaultInstruct,
    speed: saved.speed ?? cfg.speed,
    paralinguistic: saved.paralinguistic ?? cfg.paralinguistic,
  };
}

/** 把模型风格盖到配置上,给过滤、合成与提示词读取。 */
export function styledConfig(cfg: VoiceConfigSection, model = cfg.model): VoiceConfigSection {
  return { ...cfg, ...modelStyle(cfg, model) };
}

const TEXT = {
  zh: {
    label: 'Kmch AI · 语音',
    envTitle: '语音 · 环境提示词',
    lampService: '语音服务',
    lampQueue: '朗读队列',
    servicePage: '服务设置',
    modelPanel: '模型',
    modelSaveShape: '保存失败:参数格式不对。',
    modelSaveModel: '保存失败:模型 id 不能为空。',
    modelSaveVoice: '保存失败:音色必须是字符串。',
    modelSaveStyle: '保存失败:朗读风格格式不对。',
    modelSaveOptions: '保存失败:模型参数必须是对象。',
    modelUnknownMethod: '未知的面板方法。',
    connection: '连接',
    connectionDesc: '语音服务的 HTTP 地址与令牌。',
    serviceUrl: '服务地址',
    serviceUrlDesc: 'Kmch AI · 服务 的网关地址。',
    serviceTokenSecret: '服务令牌变量名',
    serviceTokenSecretDesc: '部署 .env 里的变量名,留空表示服务不校验。',
    format: '音频格式',
    timeoutMs: '超时(毫秒)',
    minChars: '最短字数',
    maxChars: '最长字数',
    filter: '文本过滤',
    filterDesc: '',
    filterCode: '过滤代码块',
    filterUrls: '过滤网址',
    filterMarkdown: '过滤 Markdown',
    filterActionTags: '过滤动作标记',
    filterActionTagsDesc: '删掉 【…】、<…>、〈…〉。',
    filterEmoji: '过滤表情与符号',
    filterSymbols: '额外过滤字符',
    filterSymbolsDesc: '按字面删除,可用逗号/分号/换行分隔。',
    output: '输出',
    outputDesc: '',
    playback: '播放方式',
    playbackDesc: 'local 用本机播放器;event 发 tts.voice 事件交给别的插件;none 只合成。',
    volume: '音量',
    chunkMax: '单块字数',
    gapMs: '块间停顿(毫秒)',
    shareAudio: '回执带音频附件',
  },
  en: {
    label: 'Kmch AI · 语音',
    envTitle: 'Voice · environment prompt',
    lampService: 'Speech service',
    lampQueue: 'Speech queue',
    servicePage: 'Service settings',
    modelPanel: '模型',
    modelSaveShape: 'Save failed: invalid arguments.',
    modelSaveModel: 'Save failed: the model id must not be empty.',
    modelSaveVoice: 'Save failed: voice must be a string.',
    modelSaveStyle: 'Save failed: invalid voice style.',
    modelSaveOptions: 'Save failed: model options must be an object.',
    modelUnknownMethod: 'Unknown panel method.',
    connection: 'Connection',
    connectionDesc: 'Where the speech service is and which token it expects.',
    serviceUrl: 'Service URL',
    serviceUrlDesc: 'Gateway address of Kmch AI · Service.',
    serviceTokenSecret: 'Service token variable',
    serviceTokenSecretDesc: 'Name in the deployment .env; empty means the service does not check.',
    format: 'Audio format',
    timeoutMs: 'Timeout (ms)',
    minChars: 'Minimum characters',
    maxChars: 'Maximum characters',
    filter: 'Text filter',
    filterDesc: '',
    filterCode: 'Filter code blocks',
    filterUrls: 'Filter URLs',
    filterMarkdown: 'Filter Markdown',
    filterActionTags: 'Filter action markup',
    filterActionTagsDesc: 'Removes 【…】, <…> and 〈…〉.',
    filterEmoji: 'Filter emoji and symbols',
    filterSymbols: 'Extra filtered characters',
    filterSymbolsDesc: 'Removed literally; comma/semicolon/newline separated.',
    output: 'Output',
    outputDesc: '',
    playback: 'Playback',
    playbackDesc: 'local uses the built-in player; event emits tts.voice for another plugin; none only synthesizes.',
    volume: 'Volume',
    chunkMax: 'Characters per chunk',
    gapMs: 'Gap between chunks (ms)',
    shareAudio: 'Attach audio to tool results',
  },
} as const;

export type VoiceText = typeof TEXT.zh;

export function voiceText(language: Language): VoiceText {
  return pick(language, TEXT as unknown as LanguageTable<VoiceText>);
}

/** WebUI 的配置组;`language` 只影响标题与说明。 */
export function voiceConfigGroups(language: Language): ConfigGroup[] {
  const t = voiceText(language);
  const p = 'worlds.voice.';
  return [
    {
      id: 'world:voice-connection',
      owner: 'world:voice',
      schema: {
        type: 'object',
        title: t.connection,
        description: t.connectionDesc,
        properties: {
          [`${p}serviceUrl`]: { type: 'string', title: t.serviceUrl, description: t.serviceUrlDesc, 'x-hot': true },
          [`${p}serviceTokenSecret`]: { type: 'string', title: t.serviceTokenSecret, description: t.serviceTokenSecretDesc, 'x-hot': true },
          [`${p}format`]: { type: 'string', title: t.format, enum: ['wav', 'mp3'], 'x-hot': true },
          [`${p}timeoutMs`]: { type: 'integer', title: t.timeoutMs, minimum: 1000, maximum: 600_000, 'x-hot': true },
        },
      },
    },
    {
      id: 'world:voice-filter',
      owner: 'world:voice',
      schema: {
        type: 'object',
        title: t.filter,
        properties: {
          [`${p}minChars`]: { type: 'integer', title: t.minChars, minimum: 1, maximum: 100, 'x-hot': true },
          [`${p}maxChars`]: { type: 'integer', title: t.maxChars, minimum: 20, maximum: 8000, 'x-hot': true },
          [`${p}filterCode`]: { type: 'boolean', title: t.filterCode, 'x-hot': true },
          [`${p}filterUrls`]: { type: 'boolean', title: t.filterUrls, 'x-hot': true },
          [`${p}filterMarkdown`]: { type: 'boolean', title: t.filterMarkdown, 'x-hot': true },
          [`${p}filterActionTags`]: { type: 'boolean', title: t.filterActionTags, description: t.filterActionTagsDesc, 'x-hot': true },
          [`${p}filterEmoji`]: { type: 'boolean', title: t.filterEmoji, 'x-hot': true },
          [`${p}filterSymbols`]: { type: 'string', title: t.filterSymbols, description: t.filterSymbolsDesc, 'x-hot': true },
        },
      },
    },
    {
      id: 'world:voice-output',
      owner: 'world:voice',
      schema: {
        type: 'object',
        title: t.output,
        properties: {
          [`${p}playback`]: { type: 'string', title: t.playback, description: t.playbackDesc, enum: ['local', 'event', 'none'], 'x-hot': true },
          [`${p}volume`]: { type: 'number', title: t.volume, minimum: 0, maximum: 1, multipleOf: 0.05, 'x-hot': true },
          [`${p}chunkMax`]: { type: 'integer', title: t.chunkMax, minimum: 20, maximum: 500, 'x-hot': true },
          [`${p}gapMs`]: { type: 'integer', title: t.gapMs, minimum: 0, maximum: 5000, 'x-hot': true },
          [`${p}shareAudio`]: { type: 'boolean', title: t.shareAudio, 'x-hot': true },
        },
      },
    },
  ];
}
