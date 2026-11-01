/** 测试用的假服务客户端、假播放器与临时 World。 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import type { AudioPlayer, PlayResult } from '../../src/audio/player.ts';
import { VOICE_DEFAULTS } from '../../src/config.ts';
import type { SpeechService } from '../../src/service.ts';
import type {
  ModelOption, ServiceHealth, TtsAudio, TtsRequest, VoiceConfigSection, VoiceOption,
} from '../../src/types.ts';
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

export interface FakeService extends SpeechService {
  calls: TtsRequest[];
  voiceList: VoiceOption[];
  modelList: ModelOption[];
  healthState: ServiceHealth;
  healthCalls: number;
  voiceCalls: number;
  modelCalls: number;
  error: Error | null;
}

export function fakeService(patch: Partial<FakeService> = {}): FakeService {
  const service: FakeService = {
    calls: [],
    voiceList: [{ value: '4016', label: '4016' }],
    modelList: [{ value: 'ming3-tts', label: 'ming3-tts' }],
    healthState: { ok: true, ready: true, status: 'ok', detail: 'ok · 1 models', models: 1 },
    healthCalls: 0,
    voiceCalls: 0,
    modelCalls: 0,
    error: null,
    async synthesize(req: TtsRequest): Promise<TtsAudio> {
      service.calls.push(req);
      if (service.error) throw service.error;
      return { bytes: wavBytes(1), mime: 'audio/wav', seconds: 1 };
    },
    async health(): Promise<ServiceHealth> {
      service.healthCalls += 1;
      return service.healthState;
    },
    async models(): Promise<ModelOption[]> {
      service.modelCalls += 1;
      return service.modelList;
    },
    async voices(): Promise<VoiceOption[]> {
      service.voiceCalls += 1;
      return service.voiceList;
    },
    ...patch,
  };
  return service;
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
  service: FakeService;
  player: RecordingPlayer;
  dir: string;
  cleanup(): void;
}

export function testWorld(patch: Partial<VoiceConfigSection> = {}, deps: Partial<VoiceWorldDeps> = {}): TestWorldHandle {
  const dir = mkdtempSync(join(tmpdir(), 'voice-test-'));
  const cfg: VoiceConfigSection = { ...VOICE_DEFAULTS, enabled: true, playback: 'none', ...patch };
  const service = (deps.service as FakeService | undefined) ?? fakeService();
  const player = new RecordingPlayer();
  const world = new VoiceWorld({
    cfg,
    timezone: 'UTC',
    dataDir: dir,
    secret: () => '',
    persist: (p) => { Object.assign(cfg, p); },
    log: quietLogger,
    deps: {
      service,
      createPlayer: () => player,
      rng: () => 0,
      now: () => 1_700_000_000_000,
      sleep: async () => {},
      ...deps,
    },
  });
  return {
    world, cfg, service, player, dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** 让排队的异步任务跑完。 */
export async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
