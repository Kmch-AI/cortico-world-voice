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
  },
};

export function panelText(language: string): PanelText {
  return language.toLowerCase().startsWith('zh') ? TEXT.zh : TEXT.en;
}

/** IndexTTS2 的请求参数名;服务给的是 wire name,面板补一层中文。 */
export const PARAM_LABELS: Record<string, string> = {
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
