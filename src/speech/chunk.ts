/** 把正文切成适合合成与播放的小块。 */

/** 句末(或换行)后切开,标点留在前一句。 */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /[。！？!?；;…]+|\n+|[.](?=\s|$)/g;
  for (const m of text.matchAll(re)) {
    const end = (m.index ?? 0) + m[0].length;
    const piece = text.slice(start, end).trim();
    if (piece) out.push(piece);
    start = end;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/** 不把副语言标签切成两半:切点落在 `[` 与 `]` 之间时退到 `[` 前。 */
function safeCut(text: string, limit: number): number {
  let cut = limit;
  const open = text.lastIndexOf('[', cut);
  const close = text.lastIndexOf(']', cut);
  if (open > close) cut = open;
  if (cut <= 0) cut = Math.min(limit, text.length);
  return cut;
}

/** 超长句优先在逗号/顿号/空格处切,找不到才硬切。 */
function cutLong(text: string, maxLen: number): [string, string] {
  if (text.length <= maxLen) return [text, ''];
  const window = text.slice(0, maxLen);
  const marks = ['，', ',', '、', '；', ';', '：', ':', ' '];
  let cut = -1;
  for (const mark of marks) cut = Math.max(cut, window.lastIndexOf(mark));
  if (cut < maxLen * 0.4) cut = maxLen;
  cut = safeCut(text, cut);
  return [text.slice(0, cut).trim(), text.slice(cut).trim()];
}

/** 按句打包成块,每块不超过 `maxLen` 个字符。 */
export function splitSpeech(text: string, maxLen: number): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const limit = Math.max(20, Math.floor(maxLen));
  const chunks: string[] = [];
  let cur = '';
  for (const sentence of splitSentences(normalized)) {
    if (!cur) cur = sentence;
    else if (cur.length + 1 + sentence.length <= limit) cur = `${cur} ${sentence}`;
    else {
      chunks.push(cur);
      cur = sentence;
    }
    while (cur.length > limit) {
      const [head, tail] = cutLong(cur, limit);
      if (head) chunks.push(head);
      cur = tail;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.filter((c) => /[\p{L}\p{N}]/u.test(c));
}

/** 在句末截断到 `max` 字左右;找不到句末就在 `max` 处截。 */
export function truncateSpeech(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const at = Math.max(
    head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'),
    head.lastIndexOf('.'), head.lastIndexOf('!'), head.lastIndexOf('?'),
  );
  if (at >= max * 0.5) return head.slice(0, at + 1).trim();
  return head.trim();
}
