/**
 * 验证本机播放器:放一个 wav/mp3,音量 0(不出声),打印播放结果。
 * 用法:`pnpm smoke:player <file>`。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nullLogger } from 'cortico/core/util.ts';
import { createPlayer } from '../src/audio/player.ts';

const file = process.argv[2];
if (!file) {
  console.error('usage: pnpm smoke:player <file>');
  process.exit(2);
}
const dir = mkdtempSync(join(tmpdir(), 'voice-player-'));
const player = createPlayer(nullLogger());
try {
  await player.warm(dir);
  const result = await player.play(file, 0);
  console.log('play:', result);
  process.exitCode = result === 'played' ? 0 : 1;
} finally {
  await player.close();
  rmSync(dir, { recursive: true, force: true });
}
