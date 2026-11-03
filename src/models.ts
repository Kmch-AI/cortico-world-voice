/**
 * 模型能力与提示词片段。
 *
 * 服务返回的模型 id 决定两件事:正文里能不能写副语言标签,以及环境提示词
 * 该怎么描述文本与情绪。按 id 前缀匹配,大小写不敏感;空模型与未知模型按
 * 通用 OpenAI 兼容模型处理。
 */

interface ModelInfo {
  /** 模型 id 的前缀,小写。 */
  readonly match: readonly string[];
  /** 给人看的名字;未知模型为空。 */
  readonly label: string;
  /** 是否支持 `[Laughter]` 这类副语言标签。 */
  readonly tags: boolean;
  /** 环境提示词里的文本与情绪写法。 */
  readonly prompt: string;
}

const MING3: ModelInfo = {
  match: ['ming3', 'ming-3', 'ming_3'],
  label: 'Ming 3.0',
  tags: true,
  prompt: '调用 voice_speak 时可用 instruct 描述表演方式,emotion 传情绪,voice 与 speed 也可选;支持 [Laughter] [Sigh] [Breathing] [Uhm] [Question-ei] 等副语言标签.',
};

const INDEXTTS2: ModelInfo = {
  match: ['index-tts2', 'index_tts2', 'index-tts2.5', 'index_tts2_5', '2.5'],
  label: 'IndexTTS2',
  tags: false,
  prompt: '调用 voice_speak 时只填 text 与 instruct;不要填 emotion、voice、speed。instruct 用自然语言描述表演方式,例如「用轻快、带笑意的语气」,服务会把它写入 emotion_text。不要在正文写 emotion_text 或 [Laughter] 这类方括号标签。采样/时长参数在语音模型页配置,不要写进正文。需要把音频交给其他渠道时才填 silent。',
};

const GENERIC: ModelInfo = {
  match: [],
  label: '',
  tags: false,
  prompt: '调用 voice_speak 时用 instruct 描述语气;不要用方括号标签,除非确认模型支持.',
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

/** 环境提示词里的文本与情绪写法;空模型与未知模型用通用片段。 */
export function modelPrompt(model: string): string {
  return (profileOf(model) ?? GENERIC).prompt;
}
