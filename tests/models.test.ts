import { describe, expect, it } from 'vitest';
import { modelLabel, modelPrompt, modelSupportsTags } from '../src/models.ts';

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

  it('按模型选择文本与情绪写法', () => {
    const ming = modelPrompt('ming3-tts');
    expect(ming).toContain('[Laughter]');
    expect(ming).toContain('emotion 传情绪');

    const index = modelPrompt('index-tts2');
    expect(index).toContain('只填 text 与 instruct');
    expect(index).toContain('不要填 emotion、voice、speed');
    expect(index).toContain('emotion_text');
    expect(index).toContain('[Laughter]');
    expect(index).not.toContain('情绪用 voice_speak 的 emotion 或 instruct');

    const generic = modelPrompt('');
    expect(generic).toContain('用 instruct 描述语气');
    expect(generic).toContain('不要用方括号标签');
    expect(modelPrompt('qwen-tts')).toBe(generic);
    expect(modelPrompt('openai-tts')).toBe(generic);
  });
});
