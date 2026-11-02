/**
 * 完整链路:Kmch AI · 服务 → 触发 → 过滤 → 合成 → 事件出口。
 * 需要服务网关已经跑着:`pnpm smoke:chain http://127.0.0.1:9883`。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VOICE_DEFAULTS } from '../src/config.ts';
import type { VoiceConfigSection } from '../src/types.ts';
import { VoiceWorld } from '../src/world.ts';
import { FakeHost } from '../tests/helpers/fake-host.ts';
import { quietLogger } from '../tests/helpers/voice.ts';

const serviceUrl = process.argv[2] ?? 'http://127.0.0.1:9883';
const dir = mkdtempSync(join(tmpdir(), 'voice-chain-'));
const cfg: VoiceConfigSection = {
  ...VOICE_DEFAULTS,
  enabled: true,
  serviceUrl,
  playback: 'event',
};
const host = new FakeHost();
const world = new VoiceWorld({
  cfg,
  timezone: 'UTC',
  dataDir: dir,
  secret: () => '',
  persist: (patch) => { Object.assign(cfg, patch); },
  log: quietLogger,
});

try {
  await world.start(host);
  const tap = world.outputTap();
  const started = Date.now();
  tap.onEvent({ type: 'response.output_text.delta', delta: '<tts>你好，这是一次完整链路测试。</tts>' } as never);
  tap.onRoundEnd?.();

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !host.events.some((e) => e.type === 'tts.voice')) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const event = host.events.find((e) => e.type === 'tts.voice');
  if (!event) throw new Error('no tts.voice event arrived');
  const blob = (event.blobs ?? [])[0] as { bytes?: Uint8Array } | undefined;
  console.log('tts.voice:', {
    ms: Date.now() - started,
    chars: event.text.length,
    bytes: blob?.bytes?.length ?? 0,
    deliver: host.pushOpts[host.events.indexOf(event)] ?? null,
  });
  if (!blob?.bytes?.length) process.exitCode = 1;
} finally {
  await world.stop();
  rmSync(dir, { recursive: true, force: true });
}
