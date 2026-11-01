/** 把一段回复变成能念的正文:取 `<tts>`、去代码/网址/Markdown/动作标记/符号。 */
import type { VoiceConfigSection } from '../types.ts';
import {
  canonicalizeTags,
  keepsParalinguistic,
  stripParalinguisticTags,
  stripUnknownTags,
  takeEmotionMarker,
} from './tags.ts';

export interface FilteredSpeech {
  /** 过滤后的朗读文本;空串表示没有可念的内容。 */
  text: string;
  /** 原文用 `<tts>` 指定了要念的段落;这种请求不受概率限制。 */
  forced: boolean;
  /** 文本里的情绪标记;没有时为空。 */
  emotion: string;
}

const TTS_TAG_RE = /<tts>([\s\S]*?)<\/tts>/gi;
const FENCED_CODE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()]+/gi;
const HTML_TAG_RE = /<\/?[A-Za-z][^>]*>/g;
const ACTION_ANGLE_RE = /[<＜〈]([^>＞〉\n]{0,32})[>＞〉]/g;
const ACTION_BRACKET_RE = /【[^】]*】/g;
const EMOJI_RE = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu;
const SYMBOL_RE = /[\p{So}\p{Sk}\p{Cf}\p{Cs}]/gu;
const LIST_MARK_RE = /^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+/gm;
const HEADING_RE = /^[ \t]*#{1,6}[ \t]+/gm;
const QUOTE_RE = /^[ \t]*>[ \t]?/gm;
const EMPHASIS_RE = /[*_~]{1,3}/g;

/** `<tts>…</tts>` 里的内容才是要念的;没有这个标签时返回原文。 */
export function extractTtsMarkup(raw: string): { text: string; forced: boolean } {
  const parts: string[] = [];
  TTS_TAG_RE.lastIndex = 0;
  for (const m of raw.matchAll(TTS_TAG_RE)) parts.push(m[1] ?? '');
  if (parts.length === 0) return { text: raw, forced: false };
  return { text: parts.join(' '), forced: true };
}

function symbolList(raw: string): string[] {
  return raw
    .split(/[,，;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function collapse(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,，.。!！?？;；:：、])/g, '$1')
    .replace(/^[\s,，.。!！?？;；:：、]+/, '')
    .trim();
}

/** 过滤一段文本。配置每次现读,所以热改立即生效。 */
export function filterSpeech(raw: string, cfg: VoiceConfigSection): FilteredSpeech {
  if (typeof raw !== 'string' || !raw) return { text: '', forced: false, emotion: '' };

  const markup = extractTtsMarkup(raw);
  const emotion = takeEmotionMarker(markup.text);
  let text = emotion.text;

  if (cfg.filterCode) {
    text = text.replace(FENCED_CODE_RE, ' ').replace(INLINE_CODE_RE, ' ');
  }
  if (cfg.filterUrls) {
    text = text.replace(IMAGE_RE, ' ').replace(LINK_RE, '$1');
    text = text.replace(URL_RE, ' ');
  }
  if (cfg.filterMarkdown) {
    text = text
      .replace(HEADING_RE, '')
      .replace(LIST_MARK_RE, '')
      .replace(QUOTE_RE, '')
      .replace(EMPHASIS_RE, '');
  }
  if (cfg.filterActionTags) {
    text = text.replace(ACTION_BRACKET_RE, ' ').replace(ACTION_ANGLE_RE, ' ');
  }
  text = text.replace(HTML_TAG_RE, ' ');

  text = canonicalizeTags(text);
  text = stripUnknownTags(text);
  if (!keepsParalinguistic(cfg.paralinguistic)) text = stripParalinguisticTags(text);

  if (cfg.filterEmoji) text = text.replace(EMOJI_RE, '').replace(SYMBOL_RE, '');

  for (const symbol of symbolList(cfg.filterSymbols)) {
    if (symbol) text = text.split(symbol).join('');
  }

  text = collapse(text);
  // 只剩标点或控制字符的内容不念。
  if (!/[\p{L}\p{N}]/u.test(text)) text = '';
  return { text, forced: markup.forced, emotion: emotion.emotion };
}
