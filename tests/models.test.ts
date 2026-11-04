import { describe, expect, it } from 'vitest';
import {
  modelEmotionModes, modelLabel, modelSupportsEmotion, modelSupportsSpeed, modelSupportsTags, voicePrompt,
} from '../src/models.ts';
import type { VoiceModelStyle } from '../src/types.ts';

const style = (patch: Partial<VoiceModelStyle> = {}): VoiceModelStyle => ({
  voice: '',
  emotionMode: 'instruct',
  defaultEmotion: '',
  defaultInstruct: '',
  speed: 1,
  paralinguistic: 'auto',
  ...patch,
});

describe('models', () => {
  it('Ming 3.0 TTS 支持副语言标签', () => {
    for (const model of ['ming3-tts', 'MING3-TTS', 'ming-3', 'ming_3', 'Ming3-TTS']) {
      expect(modelSupportsTags(model), model).toBe(true);
    }
  });

  it('IndexTTS2 / OpenAI / 通用模型不支持副语言标签', () => {
    for (const model of ['index-tts2', 'INDEX_TTS2', 'index-tts2.5', 'index_tts2_5', 'openai-tts', 'qwen-tts', 'ming3', '2.5', '']) {
      expect(modelSupportsTags(model), model).toBe(false);
    }
  });

  it('已知模型有给人看的名字,未知或空模型为空', () => {
    expect(modelLabel('ming3-tts')).toBe('Ming 3.0 TTS');
    expect(modelLabel('index-tts2')).toBe('IndexTTS2');
    expect(modelLabel('')).toBe('');
    expect(modelLabel('qwen-tts')).toBe('');
  });

  it('情绪控制方式决定提示词要求填哪个字段', () => {
    const instruct = voicePrompt('ming3-tts', style({ emotionMode: 'instruct' }));
    expect(instruct).toContain('用 instruct');
    expect(instruct).toContain('不要填 emotion');
    expect(instruct).toContain('speed 可选');

    const categorical = voicePrompt('ming3-tts', style({ emotionMode: 'categorical' }));
    expect(categorical).toContain('用 emotion 写一个短情绪词');
    expect(categorical).toContain('不要填 instruct 与 speed');

    const categoricalGeneric = voicePrompt('qwen-tts', style({ emotionMode: 'categorical' }));
    expect(categoricalGeneric).toContain('当前模型不发送 emotion');
    expect(categoricalGeneric).toContain('按模型默认语气朗读');

    const basic = voicePrompt('ming3-tts', style({ emotionMode: 'basic' }));
    expect(basic).toContain('只用 speed');
    expect(basic).toContain('不要填 emotion 与 instruct');

    const basicIndex = voicePrompt('index-tts2', style({ emotionMode: 'basic' }));
    expect(basicIndex).toContain('当前模型不支持独立的语速参数');

    const none = voicePrompt('ming3-tts', style({ emotionMode: 'none' }));
    expect(none).toContain('不要填 emotion、instruct 与 speed');
    expect(none).not.toContain('用 instruct');
  });

  it('副语言标签策略决定提示词允许还是禁止方括号标签', () => {
    const auto = voicePrompt('ming3-tts', style({ paralinguistic: 'auto' }));
    expect(auto).toContain('[Laughter]');
    expect(auto).toContain('会被演出来');

    const keep = voicePrompt('index-tts2', style({ paralinguistic: 'keep' }));
    expect(keep).toContain('标签会保留在 text 里');
    expect(keep).toContain('可能被念出字面');

    const strip = voicePrompt('ming3-tts', style({ paralinguistic: 'strip' }));
    expect(strip).not.toContain('可在 text 里内联');
    expect(strip).toContain('会把它们删掉');

    const unsupported = voicePrompt('index-tts2', style({ paralinguistic: 'auto' }));
    expect(unsupported).toContain('这个模型不支持');
  });

  it('tags 模式在标签被删掉时不再要求用标签表达情绪', () => {
    const kept = voicePrompt('ming3-tts', style({ emotionMode: 'tags', paralinguistic: 'auto' }));
    expect(kept).toContain('用 text 里的副语言标签表达情绪');

    const stripped = voicePrompt('ming3-tts', style({ emotionMode: 'tags', paralinguistic: 'strip' }));
    expect(stripped).toContain('当前设置不保留副语言标签');
    expect(stripped).not.toContain('用 text 里的副语言标签表达情绪');

    // keep 是对模型能力的显式覆盖:标签会保留,提示词也应允许。
    const keptOnIndex = voicePrompt('index-tts2', style({ emotionMode: 'tags', paralinguistic: 'keep' }));
    expect(keptOnIndex).toContain('标签会保留在 text 里');
    expect(keptOnIndex).toContain('可能被念出字面');
  });

  it('模型提示词说明字段落点与音色用法', () => {
    expect(voicePrompt('ming3-tts', style())).toContain('自由文本模板');
    expect(voicePrompt('index-tts2', style())).toContain('emotion_text');
    expect(voicePrompt('', style())).toContain('instructions');
    expect(voicePrompt('qwen-tts', style())).toContain('voice 只在需要临时换音色时填');
  });

  it('IndexTTS2 不提供独立语速方式,其他模型提供五行', () => {
    expect(modelSupportsSpeed('index-tts2')).toBe(false);
    expect(modelSupportsSpeed('ming3-tts')).toBe(true);
    expect(modelSupportsSpeed('qwen-tts')).toBe(true);
    expect(modelSupportsEmotion('index-tts2')).toBe(true);
    expect(modelSupportsEmotion('ming3-tts')).toBe(true);
    expect(modelSupportsEmotion('qwen-tts')).toBe(false);
    expect(modelEmotionModes('index-tts2')).toEqual(['instruct', 'categorical', 'tags', 'none']);
    expect(modelEmotionModes('ming3-tts')).toEqual(['instruct', 'categorical', 'basic', 'tags', 'none']);
    // 未知模型按 OpenAI 兼容处理:没有 emotion 字段。
    expect(modelEmotionModes('')).toEqual(['instruct', 'basic', 'tags', 'none']);
    expect(modelEmotionModes('qwen-tts')).toEqual(['instruct', 'basic', 'tags', 'none']);
  });
});
