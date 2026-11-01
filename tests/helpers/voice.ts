/** 测试用的假后端、假播放器与临时 World。 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import type { AudioPlayer, PlayResult } from '../../src/audio/player.ts';
import { VOICE_DEFAULTS } from '../../src/config.ts';
import type { TtsAudio, TtsBackend, TtsRequest, VoiceConfigSection, VoiceOption } from '../../src/types.ts';
import { VoiceWorld, type VoiceWorldDeps } from '../../src/world.ts';

export const quietLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, emit: () => {},
  child() { return this; },
};

/** 44 字节头 + 一段 PCM16 静音;`wavSeconds` 能读出时长。 */
export function wavBytes(seconds = 1, rate = 8000): Uint8Array {
  const samples = Math.round(seconds * rate);
  const data = samples * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + data, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(data, 40);
  return new Uint8Array(buf);
}

export interface FakeBackend extends TtsBackend {
  calls: TtsRequest[];
  voices: VoiceOption[];
  healthState: { ok: boolean; detail?: string };
}

export function fakeBackend(patch: Partial<TtsBackend> = {}): FakeBackend {
  const backend: FakeBackend = {
    id: 'audiocpp',
    label: 'fake',
    calls: [],
    voices: [{ value: '4016', label: '4016' }],
    healthState: { ok: true },
    async synthesize(req: TtsRequest): Promise<TtsAudio> {
      backend.calls.push(req);
      return { bytes: wavBytes(1), mime: 'audio/wav', seconds: 1 };
    },
    async listVoices() { return backend.voices; },
    async health() { return backend.healthState; },
    ...patch,
  };
  return backend;
}

export class RecordingPlayer implements AudioPlayer {
  plays: string[] = [];
  hushed = 0;
  closed = false;
  result: PlayResult = 'played';

  async warm(): Promise<void> {}

  async play(file: string): Promise<PlayResult> {
    this.plays.push(file);
    return this.result;
  }

  hush(): void { this.hushed += 1; }

  async close(): Promise<void> { this.closed = true; }
}

export interface TestWorldHandle {
  world: VoiceWorld;
  cfg: VoiceConfigSection;
  backend: FakeBackend;
  player: RecordingPlayer;
  dir: string;
  cleanup(): void;
}

export function testWorld(patch: Partial<VoiceConfigSection> = {}, deps: Partial<VoiceWorldDeps> = {}): TestWorldHandle {
  const dir = mkdtempSync(join(tmpdir(), 'voice-test-'));
  const cfg: VoiceConfigSection = { ...VOICE_DEFAULTS, enabled: true, playback: 'none', ...patch };
  const backend = (deps.backend as FakeBackend | undefined) ?? fakeBackend();
  const player = new RecordingPlayer();
  const world = new VoiceWorld({
    cfg,
    timezone: 'UTC',
    dataDir: dir,
    secret: () => '',
    persist: (p) => { Object.assign(cfg, p); },
    log: quietLogger,
    deps: {
      backend,
      createPlayer: () => player,
      rng: () => 0,
      now: () => 1_700_000_000_000,
      sleep: async () => {},
      ...deps,
    },
  });
  return {
    world, cfg, backend, player, dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** 让排队的异步任务跑完。 */
export async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
