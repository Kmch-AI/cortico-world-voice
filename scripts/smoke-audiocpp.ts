/**
 * 对着一台真的 audiocpp_server 跑一遍:探活、列音色、合成一段带标签的话。
 * 用法:`pnpm smoke:audiocpp [baseUrl] [out.wav]`,默认 http://127.0.0.1:8000。
 */
import { writeFileSync } from 'node:fs';
import { nullLogger } from 'cortico/core/util.ts';
import { audiocppBackend } from '../src/backends/audiocpp.ts';
import { VOICE_DEFAULTS } from '../src/config.ts';
import type { BackendContext } from '../src/types.ts';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:8000';
const out = process.argv[3] ?? 'smoke.wav';
const ctx: BackendContext = {
  cfg: { ...VOICE_DEFAULTS, backend: 'audiocpp', baseUrl, emotionMode: 'instruct' },
  secret: () => '',
  fetch,
  log: nullLogger(),
};

const health = await audiocppBackend.health(ctx);
console.log('health:', health);
if (!health.ok) process.exit(2);

const voices = await audiocppBackend.listVoices(ctx);
console.log('voices:', voices);

const started = Date.now();
const audio = await audiocppBackend.synthesize({
  text: '[Laughter]你好呀，今天过得怎么样？',
  emotion: '温柔、轻快',
  format: 'wav',
}, ctx);
writeFileSync(out, audio.bytes);
console.log(`wrote ${out}: ${audio.bytes.length} bytes, ${audio.seconds?.toFixed(2) ?? '?'} s, ${Date.now() - started} ms`);
