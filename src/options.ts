/**
 * 配置页的音色下拉要读运行中实例探到的音色,但 `WorldDefinition.configOptions` 是静态签名。
 * 实例启动时把「读当前音色表」的函数注册进来。
 */
import type { VoiceOption } from './types.ts';

let provider: (() => VoiceOption[]) | null = null;

export function registerVoiceOptions(fn: () => VoiceOption[]): void {
  provider = fn;
}

export function currentVoiceOptions(): VoiceOption[] {
  return provider?.() ?? [];
}
