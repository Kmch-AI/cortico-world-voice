/** 「模型」面板的文案与参数名对照表;浏览器端只 import 这里,不依赖 cortico 运行时。 */

export interface PanelText {
  title: string;
  model: string;
  voice: string;
  refresh: string;
  save: string;
  saved: string;
  loading: string;
  promptTitle: string;
  styleTitle: string;
  paramsTitle: string;
  emotionMode: string;
  defaultEmotion: string;
  defaultInstruct: string;
  speed: string;
  paralinguistic: string;
  emotionModeOptions: readonly { value: string; label: string }[];
  paralinguisticOptions: readonly { value: string; label: string }[];
}

const TEXT: Record<'zh' | 'en', PanelText> = {
  zh: {
    title: '模型',
    model: '模型',
    voice: '音色',
    refresh: '刷新',
    save: '保存',
    saved: '已保存',
    loading: '读取中…',
    promptTitle: '模型提示词',
    styleTitle: '声音与情绪',
    paramsTitle: '模型参数',
    emotionMode: '情绪控制',
    defaultEmotion: '默认情绪',
    defaultInstruct: '默认表演指令',
    speed: '语速',
    paralinguistic: '副语言标签',
    emotionModeOptions: [
      { value: 'instruct', label: '自然语言' },
      { value: 'categorical', label: '情绪标签' },
      { value: 'basic', label: '语速' },
      { value: 'tags', label: '正文标签' },
      { value: 'none', label: '不发送' },
    ],
    paralinguisticOptions: [
      { value: 'auto', label: '自动' },
      { value: 'keep', label: '保留' },
      { value: 'strip', label: '删除' },
    ],
  },
  en: {
    title: '模型',
    model: 'Model',
    voice: 'Voice',
    refresh: 'Refresh',
    save: 'Save',
    saved: 'Saved',
    loading: 'Loading…',
    promptTitle: 'Model prompt',
    styleTitle: 'Voice and emotion',
    paramsTitle: 'Model parameters',
    emotionMode: 'Emotion control',
    defaultEmotion: 'Default emotion',
    defaultInstruct: 'Default direction',
    speed: 'Speed',
    paralinguistic: 'Paralinguistic tags',
    emotionModeOptions: [
      { value: 'instruct', label: 'Natural language' },
      { value: 'categorical', label: 'Emotion label' },
      { value: 'basic', label: 'Speed' },
      { value: 'tags', label: 'Inline tags' },
      { value: 'none', label: 'Send nothing' },
    ],
    paralinguisticOptions: [
      { value: 'auto', label: 'Auto' },
      { value: 'keep', label: 'Keep' },
      { value: 'strip', label: 'Strip' },
    ],
  },
};

export function panelText(language: string): PanelText {
  return language.toLowerCase().startsWith('zh') ? TEXT.zh : TEXT.en;
}

/** IndexTTS2 的请求参数名;服务给的是 wire name,面板补一层中文。 */
export const PARAM_LABELS: Record<string, string> = {
  template_name: '模板',
  language: '语言',
  instruction_schema: '指令语言',
  pitch: '音高',
  volume: '音量',
  guidance_scale: '引导强度',
  sigma: '噪声尺度',
  raw_text: '整段发送',
  trim_silence: '修剪静音',
  emotion_alpha: '情绪强度',
  emotion_text: '情绪描述',
  use_emotion_text: '使用文字情绪',
  use_random_emotion: '随机情绪',
  duration_scale: '时长缩放',
  interval_silence_ms: '分段静音',
  do_sample: '采样',
  top_p: 'top_p',
  top_k: 'top_k',
  temperature: '温度',
  length_penalty: '长度惩罚',
  num_beams: 'beam 数',
  repetition_penalty: '重复惩罚',
  max_tokens: '最大 token',
  seed: '种子',
  text_chunk_size: '文本分块大小',
  text_chunk_mode: '分块模式',
};
