/**
 * 配置页的模型与音色下拉要读运行中实例从服务探到的目录,但
 * `WorldDefinition.configOptions` 是静态签名。实例启动或探活时把读取函数注册进来;
 * 只支持 `voice.models` 与 `voice.voices` 两种 kind,未知 kind 返回空。
 * 读的是已经缓存的表,不在配置页里发请求;服务不可达时保留上次的表,没有就是空表。
 * 当前值不在表里时由框架补入,这里不重复做。
 */
import { VOICE_MODELS_KIND, VOICE_OPTIONS_KIND } from './config.ts';
import type { SelectOption } from './types.ts';

export const OPTION_KINDS = [VOICE_MODELS_KIND, VOICE_OPTIONS_KIND] as const;
export type OptionKind = (typeof OPTION_KINDS)[number];

type Provider = () => readonly SelectOption[];

const providers = new Map<OptionKind, Provider>();

function isOptionKind(kind: string): kind is OptionKind {
  return kind === VOICE_MODELS_KIND || kind === VOICE_OPTIONS_KIND;
}

/** 实例启动或探活时登记;同一 kind 后登记的覆盖先前的。 */
export function registerOptions(kind: OptionKind, provider: Provider): void {
  providers.set(kind, provider);
}

/** 实例停止时撤销自己登记的那一项;已有更新实例登记时不动它。 */
export function unregisterOptions(kind: OptionKind, provider: Provider): void {
  if (providers.get(kind) === provider) providers.delete(kind);
}

/** 未知 kind 返回空数组,框架继续查询其他 World。 */
export function currentOptions(kind: string): SelectOption[] {
  if (!isOptionKind(kind)) return [];
  return [...(providers.get(kind)?.() ?? [])];
}
