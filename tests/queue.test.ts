import { describe, expect, it } from 'vitest';
import { SpeechQueue, type QueueSettings, type SpeechJob } from '../src/audio/queue.ts';
import type { PlayResult } from '../src/audio/player.ts';
import { quietLogger, RecordingPlayer, wavBytes } from './helpers/voice.ts';

/** 播放会一直停在这里,直到 hush。 */
class BlockingPlayer extends RecordingPlayer {
  private pending: ((result: PlayResult) => void) | null = null;

  override play(file: string): Promise<PlayResult> {
    this.plays.push(file);
    return new Promise<PlayResult>((resolve) => { this.pending = resolve; });
  }

  override hush(): void {
    this.hushed += 1;
    const pending = this.pending;
    this.pending = null;
    pending?.('cut');
  }
}

function makeQueue(settings: QueueSettings, player = new RecordingPlayer(), order: string[] = []): SpeechQueue {
  return new SpeechQueue({
    player,
    settings: () => settings,
    log: quietLogger,
    sleep: async () => {},
    writeTemp: () => 'clip.wav',
    removeTemp: () => {},
  });
}

function makeJob(chunks: string[], silent = false, order: string[] = []): SpeechJob {
  return {
    text: chunks.join(' '),
    chunks,
    silent,
    source: 'test',
    produce: async (chunk) => {
      order.push(`synth:${chunk}`);
      return { bytes: wavBytes(1), mime: 'audio/wav', seconds: 1 };
    },
  };
}

describe('SpeechQueue', () => {
  it('按块合成并依次播放,块间停顿', async () => {
    const order: string[] = [];
    const sleeps: number[] = [];
    const player = new RecordingPlayer();
    const queue = new SpeechQueue({
      player,
      settings: () => ({ playback: 'local', volume: 0.8, gapMs: 120 }),
      log: quietLogger,
      sleep: async (ms) => { sleeps.push(ms); },
      writeTemp: () => 'clip.wav',
      removeTemp: () => {},
    });
    const result = await queue.enqueue(makeJob(['甲。', '乙。'], false, order)).done;
    expect(result.ok).toBe(true);
    expect(order).toEqual(['synth:甲。', 'synth:乙。']);
    expect(player.plays).toEqual(['clip.wav', 'clip.wav']);
    expect(sleeps).toEqual([120]);
  });

  it('silent 只合成不播放', async () => {
    const player = new RecordingPlayer();
    const queue = makeQueue({ playback: 'local', volume: 1, gapMs: 0 }, player);
    const result = await queue.enqueue(makeJob(['甲。'], true)).done;
    expect(result.ok).toBe(true);
    expect(player.plays).toEqual([]);
    expect(result.audios).toHaveLength(1);
  });

  it('hush 取消当前并清空排队', async () => {
    const player = new BlockingPlayer();
    const queue = makeQueue({ playback: 'local', volume: 1, gapMs: 0 }, player);
    const first = queue.enqueue(makeJob(['甲。']));
    const second = queue.enqueue(makeJob(['乙。']));
    await first.started;
    queue.hush();
    const firstResult = await first.done;
    const secondResult = await second.done;
    expect(firstResult.cancelled).toBe(true);
    expect(secondResult.cancelled).toBe(true);
    expect(player.hushed).toBeGreaterThan(0);
  });

  it('合成失败时回调 onError 并收束 started/done', async () => {
    const errors: string[] = [];
    const queue = new SpeechQueue({
      player: null,
      settings: () => ({ playback: 'none', volume: 1, gapMs: 0 }),
      log: quietLogger,
      sleep: async () => {},
      writeTemp: () => 'clip.wav',
      removeTemp: () => {},
      onError: (_job, message) => { errors.push(message); },
    });
    const enqueued = queue.enqueue({
      text: '甲。',
      chunks: ['甲。'],
      silent: true,
      source: 'test',
      produce: async () => { throw new Error('boom'); },
    });
    await enqueued.started;
    const result = await enqueued.done;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('boom');
    expect(errors).toEqual(['boom']);
  });

  it('playback=event 时把每块交给事件出口', async () => {
    const emitted: string[] = [];
    const queue = new SpeechQueue({
      player: null,
      settings: () => ({ playback: 'event', volume: 1, gapMs: 0 }),
      log: quietLogger,
      sleep: async () => {},
      writeTemp: () => 'clip.wav',
      removeTemp: () => {},
      emit: (audio, _job, chunk) => { emitted.push(`${chunk}:${audio.bytes.length}`); },
    });
    const result = await queue.enqueue(makeJob(['甲。', '乙。'])).done;
    expect(result.ok).toBe(true);
    expect(emitted).toEqual([`甲。:${wavBytes(1).length}`, `乙。:${wavBytes(1).length}`]);
  });
});
