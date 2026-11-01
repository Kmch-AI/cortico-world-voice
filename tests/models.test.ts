import { describe, expect, it } from 'vitest';
import { modelLabel, modelPrompt, modelSupportsTags } from '../src/models.ts';

describe('models', () => {
  it('Ming 3.0 支持副语言标签', () => {
    for (const model of ['ming3-tts', 'MING3', 'ming-3', 'ming_3', 'Ming3-TTS']) {
      expect(modelSupportsTags(model), model).toBe(true);
    }
  });

  it('IndexTTS2 / OpenAI / 通用模型不支持副语言标签', () => {
    for (const model of ['index-tts2', 'INDEX_TTS2', 'index-tts2.5', 'index_tts2_5', 'openai-tts', 'qwen-tts', '']) {
      expect(modelSupportsTags(model), model).toBe(false);
    }
  });

  it('已知模型有给人看的名字,未知或空模型为空', () => {
    expect(modelLabel('ming3-tts')).toBe('Ming 3.0');
    expect(modelLabel('index-tts2')).toBe('IndexTTS2');
    expect(modelLabel('')).toBe('');
    expect(modelLabel('qwen-tts')).toBe('');
  });

  it('按模型选择文本与情绪写法', () => {
    const ming = modelPrompt('ming3-tts');
    expect(ming).toContain('[Laughter]');
    expect(ming).toContain('instruct/emotion');

    const index = modelPrompt('index-tts2');
    expect(index).toContain('emotion_text');
    expect(index).toContain('不要写 [Laughter]');
    expect(index).not.toContain('支持 [Laughter]');

    const generic = modelPrompt('');
    expect(generic).toContain('instructions');
    expect(generic).toContain('不要用方括号标签');
    expect(modelPrompt('qwen-tts')).toBe(generic);
    expect(modelPrompt('openai-tts')).toBe(generic);
  });
});
