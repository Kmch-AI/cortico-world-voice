/**
 * 「模型」面板的数据形状。服务端经由 `World.webUi().invoke` 构造,浏览器端只
 * `import type` 这些声明;面板不接触服务地址与令牌。
 */
import type { VoiceModel, VoiceModelStyle } from './types.ts';

/** 一个模型在面板里的已保存状态。 */
export interface PanelModelSetting {
  voice: string;
  style: VoiceModelStyle;
  options: Record<string, unknown>;
}

export interface PanelModelState {
  /** `worlds.voice.model`。 */
  model: string;
  /** 当前模型的音色。 */
  voice: string;
  /** 当前模型的环境提示词片段,来自 `models.ts`。 */
  prompt: string;
  /** 每个模型的环境提示词片段,切换模型时立即更新。 */
  prompts: Record<string, string>;
  /** 当前模型已保存的请求参数。 */
  options: Record<string, unknown>;
  /** 当前模型生效的朗读风格;没有专属设置时回落到全局值。 */
  style: VoiceModelStyle;
  /** 服务目录;服务不可达时是上一次可用的结果。 */
  models: VoiceModel[];
  /** 每个模型的音色、风格与请求参数;面板切模型时不用等保存。 */
  settings: Record<string, PanelModelSetting>;
  /** 最近一次读取服务目录失败的原因。 */
  error?: string;
}

/** `invoke('model','save', [save])` 的请求体。 */
export interface PanelModelSave {
  model: string;
  voice: string;
  style?: Partial<VoiceModelStyle>;
  options: Record<string, unknown>;
}

/** 只认普通对象:数组、null 与类对象都不算。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
