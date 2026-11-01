import { describe, expect, it } from 'vitest';
import { VOICE_DEFAULTS } from '../src/config.ts';
import { splitSpeech, truncateSpeech } from '../src/speech/chunk.ts';
import { buildInstruct, classifySpeed, resolveStyle } from '../src/speech/style.ts';
import {
  canonicalizeTags, hasParalinguisticTag, keepsParalinguistic, stripUnknownTags, tagsIn, takeEmotionMarker,
} from '../src/speech/tags.ts';
import { filterSpeech } from '../src/speech/text.ts';

const cfg = (patch: Partial<typeof VOICE_DEFAULTS> = {}) => ({ ...VOICE_DEFAULTS, ...patch });

describe('filterSpeech', () => {
  it('去掉 Markdown、代码、网址与动作标记,保留正文', () => {
    const raw = '## 标题\n**你好**，看这里：https://example.com/x 还有 `code`。\n```js\nconst a = 1;\n```\n【笑】〈动作〉接着说。';
    const out = filterSpeech(raw, cfg());
    expect(out.text).toBe('标题 你好，看这里： 还有。 接着说。');
  });

  it('取 <tts> 内文并标记为强制', () => {
    const out = filterSpeech('前半句<tts>只念这里</tts>后半句', cfg());
    expect(out.text).toBe('只念这里');
    expect(out.forced).toBe(true);
  });

  it('情绪标记从朗读文本里删掉', () => {
    const out = filterSpeech('[emotion:害羞]你好呀', cfg());
    expect(out.text).toBe('你好呀');
    expect(out.emotion).toBe('害羞');
  });

  it('paralinguistic=auto 在支持标签的模型上保留并归一大小写,表外标签删掉', () => {
    const out = filterSpeech('[laughter]你好[happy]', cfg({ model: 'ming3-tts', paralinguistic: 'auto' }));
    expect(out.text).toBe('[Laughter]你好');
    expect(tagsIn(out.text)).toEqual(['Laughter']);
  });

  it('paralinguistic=auto 在当前模型不支持标签时剥掉', () => {
    for (const model of ['', 'index-tts2', 'openai-tts', 'qwen-tts']) {
      const out = filterSpeech('[Laughter]你好[Sigh]', cfg({ model, paralinguistic: 'auto' }));
      expect(out.text, model).toBe('你好');
    }
    expect(filterSpeech('[Laughter]你好', cfg({ model: 'index-tts2', paralinguistic: 'keep' })).text)
      .toBe('[Laughter]你好');
  });

  it('paralinguistic=strip 删掉副语言标签', () => {
    const out = filterSpeech('[Laughter]你好', cfg({ model: 'ming3-tts', paralinguistic: 'strip' }));
    expect(out.text).toBe('你好');
  });

  it('过滤额外字符与表情', () => {
    const out = filterSpeech('你好♡★+世界😀', cfg({ filterSymbols: '+', filterEmoji: true }));
    expect(out.text).toBe('你好世界');
  });

  it('只剩标点时返回空串', () => {
    expect(filterSpeech('！！！……', cfg()).text).toBe('');
  });
});

describe('tags', () => {
  it('规范标签写法', () => {
    expect(canonicalizeTags('[sigh] [QUESTION-EI ]')).toBe('[Sigh] [Question-ei]');
    expect(hasParalinguisticTag('[Sigh]')).toBe(true);
  });

  it('删掉表外标签但保留已知标签', () => {
    expect(stripUnknownTags('[happy]好[Sigh]')).toBe('好[Sigh]');
  });

  it('只取第一个情绪标记', () => {
    expect(takeEmotionMarker('[emotion:开心]甲[emotion:悲伤]乙')).toEqual({ text: ' 甲 乙', emotion: '开心' });
  });

  it('标签保留策略:auto 看模型能力,keep 保留,strip 删除', () => {
    expect(keepsParalinguistic('auto', true)).toBe(true);
    expect(keepsParalinguistic('auto', false)).toBe(false);
    expect(keepsParalinguistic('keep', false)).toBe(true);
    expect(keepsParalinguistic('strip', true)).toBe(false);
  });
});

describe('chunk', () => {
  it('按句切块并保持顺序', () => {
    const chunks = splitSpeech('第一句。第二句！第三句？', 120);
    expect(chunks).toEqual(['第一句。 第二句！ 第三句？']);
  });

  it('长句在逗号处切', () => {
    const text = `${'甲'.repeat(30)}，${'乙'.repeat(30)}，${'丙'.repeat(30)}。`;
    const chunks = splitSpeech(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(40);
  });

  it('不把副语言标签切成两半', () => {
    const chunks = splitSpeech(`${'甲'.repeat(35)}[Breathing]${'乙'.repeat(20)}`, 40);
    for (const chunk of chunks) {
      expect((chunk.match(/\[/g) ?? []).length).toBe((chunk.match(/\]/g) ?? []).length);
    }
  });

  it('在句末截断', () => {
    expect(truncateSpeech('一二三四五六。七八九十', 7)).toBe('一二三四五六。');
  });
});

describe('style', () => {
  it('情绪与语速折成自然语言指令', () => {
    expect(buildInstruct({ emotion: '温柔', instruct: '', speed: 0.8 })).toBe('用情绪是温柔，语速慢速的语气朗读。');
  });

  it('有表演指令时以它为主', () => {
    expect(buildInstruct({ emotion: '开心', instruct: '像在耳边说话', speed: 1 }))
      .toBe('像在耳边说话；情绪是开心。');
  });

  it('参数覆盖配置默认值', () => {
    const style = resolveStyle(cfg({ defaultEmotion: '平静', defaultInstruct: '自然', speed: 1 }), { emotion: '开心', speed: 1.3 });
    expect(style).toEqual({ emotion: '开心', instruct: '自然', speed: 1.3 });
  });

  it('语速分档', () => {
    expect(classifySpeed(0.7)).toBe('慢速');
    expect(classifySpeed(1)).toBe('中速');
    expect(classifySpeed(1.4)).toBe('快速');
  });
});
