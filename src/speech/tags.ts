/**
 * 副语言标签与情绪标记。
 *
 * 副语言标签是朗读文本的一部分,模型会把它演成呼吸/笑声/叹气,不念出字面。
 * 情绪标记只是控制注释,合成前从文本里删掉。
 */

/** Ming 3.0 系模型支持的副语言标签。 */
export const PARALINGUISTIC_TAGS: readonly string[] = [
  'Breathing',
  'Cough',
  'Sigh',
  'Laughter',
  'Surprise-ah',
  'Surprise-oh',
  'Dissatisfaction-hnn',
  'Uhm',
  'Confirmation-en',
  'Question-ei',
  'Question-ah',
  'Question-en',
  'Question-oh',
  'Question-huh',
];

const CANONICAL = new Map(PARALINGUISTIC_TAGS.map((t) => [t.toLowerCase(), t]));
const KNOWN_TAG_RE = new RegExp(
  `\\[\\s*(${PARALINGUISTIC_TAGS.map((t) => t.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|')})\\s*\\]`,
  'gi',
);
/** 看起来像标签的方括号内容:字母开头、不超过 24 字、可带连字符。 */
const TAG_LIKE_RE = /\[\s*([A-Za-z][A-Za-z0-9-]{0,23})\s*\]/g;

/** 大小写与括号内空白归一;表外内容不动。 */
export function canonicalizeTags(text: string): string {
  return text.replace(TAG_LIKE_RE, (whole, inner: string) => {
    const canonical = CANONICAL.get(inner.trim().toLowerCase());
    return canonical ? `[${canonical}]` : whole;
  });
}

/** 文本里是否有受支持的副语言标签。 */
export function hasParalinguisticTag(text: string): boolean {
  KNOWN_TAG_RE.lastIndex = 0;
  return KNOWN_TAG_RE.test(text);
}

/** 删掉受支持的副语言标签。 */
export function stripParalinguisticTags(text: string): string {
  return text.replace(KNOWN_TAG_RE, '');
}

/** 删掉表外的标签形状内容(`[happy]`、`[1]` 这类),防止被念出来。 */
export function stripUnknownTags(text: string): string {
  return text.replace(TAG_LIKE_RE, (whole, inner: string) =>
    CANONICAL.has(inner.trim().toLowerCase()) ? whole : '');
}

/**
 * auto 保留标签,由服务里的模型决定演不演;keep 一律保留;strip 一律删掉。
 */
export function keepsParalinguistic(mode: 'auto' | 'keep' | 'strip'): boolean {
  return mode !== 'strip';
}

const EMOTION_MARKERS: ReadonlyArray<RegExp> = [
  /\[\[\s*emotion\s*[:=]\s*([^\]]{1,40})\s*\]\]/gi,
  /\[\s*emotion\s*[:=]\s*([^\]]{1,40})\s*\]/gi,
  /<\s*emotion\s*[:=]\s*([^>]{1,40})\s*>/gi,
];

/** 取出第一个情绪标记并从文本里删掉;没有标记时 emotion 为空。 */
export function takeEmotionMarker(text: string): { text: string; emotion: string } {
  let emotion = '';
  let out = text;
  for (const re of EMOTION_MARKERS) {
    re.lastIndex = 0;
    out = out.replace(re, (_whole, value: string) => {
      if (!emotion) emotion = value.trim();
      return ' ';
    });
  }
  return { text: out, emotion };
}

/** 标签是不是受支持的那一个(大小写不敏感),返回规范写法。 */
export function canonicalTag(raw: string): string | null {
  return CANONICAL.get(raw.trim().toLowerCase()) ?? null;
}

/** 测试与文档用:把标签按出现顺序列出来。 */
export function tagsIn(text: string): string[] {
  const out: string[] = [];
  KNOWN_TAG_RE.lastIndex = 0;
  for (const m of text.matchAll(KNOWN_TAG_RE)) {
    const canonical = CANONICAL.get(m[1]!.toLowerCase());
    if (canonical) out.push(canonical);
  }
  return out;
}
